package dev.agentdeck.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import dev.agentdeck.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

internal data class ApkRelease(val version: String, val url: String, val sha256: String, val size: Long)

internal object ApkUpdates {
    private val client = OkHttpClient.Builder().followSslRedirects(false)
        .callTimeout(120, TimeUnit.SECONDS).build()
    private const val repo = "https://github.com/puritysb/AgentDeck/releases/download/"
    private const val maxBytes = 64L * 1024 * 1024
    private val versionPattern = Regex("[0-9]+\\.[0-9]+\\.[0-9]+")

    internal fun newer(candidate: String, installed: String): Boolean {
        if (!versionPattern.matches(candidate) || !versionPattern.matches(installed)) return false
        val a = candidate.split('.').map { it.toLongOrNull() ?: return false }
        val b = installed.split('.').map { it.toLongOrNull() ?: return false }
        return a.zip(b).firstOrNull { it.first != it.second }?.let { it.first > it.second } ?: false
    }

    internal fun parseRelease(value: JsonObject): ApkRelease? {
        if (value["draft"]?.jsonPrimitive?.booleanOrNull != false ||
            value["prerelease"]?.jsonPrimitive?.booleanOrNull != false) return null
        val tag = value["tag_name"]?.jsonPrimitive?.contentOrNull ?: return null
        if (!tag.startsWith("android-v")) return null
        val version = tag.removePrefix("android-v")
        if (!versionPattern.matches(version)) return null
        val name = "agentdeck-v$version.apk"
        val asset = value["assets"]?.jsonArray?.mapNotNull { it as? JsonObject }
            ?.firstOrNull { it["name"]?.jsonPrimitive?.contentOrNull == name } ?: return null
        val url = asset["browser_download_url"]?.jsonPrimitive?.contentOrNull ?: return null
        if (url != "$repo$tag/$name") return null
        val digest = asset["digest"]?.jsonPrimitive?.contentOrNull?.removePrefix("sha256:") ?: return null
        if (!Regex("[a-fA-F0-9]{64}").matches(digest)) return null
        val size = asset["size"]?.jsonPrimitive?.longOrNull ?: return null
        if (size !in 1..maxBytes) return null
        return ApkRelease(version, url, digest.lowercase(), size)
    }

    suspend fun check(): ApkRelease? = withContext(Dispatchers.IO) {
        check(BuildConfig.APK_UPDATES)
        client.newCall(Request.Builder()
            .url("https://api.github.com/repos/puritysb/AgentDeck/releases?per_page=100")
            .header("Accept", "application/vnd.github+json").build()).execute().use { response ->
            check(response.isSuccessful) { "Update service unavailable (${response.code}). Try again later." }
            val body = response.body ?: error("Empty update response")
            // Bound the metadata response too; release notes are not required here.
            val bytes = body.byteStream().use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (output.size() <= 2 * 1024 * 1024) {
                    coroutineContext.ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            check(bytes.size <= 2 * 1024 * 1024) { "Update response too large" }
            Json.parseToJsonElement(bytes.decodeToString()).jsonArray
                .mapNotNull { (it as? JsonObject)?.let(::parseRelease) }
                .filter { newer(it.version, BuildConfig.VERSION_NAME) }
                .reduceOrNull { a, b -> if (newer(b.version, a.version)) b else a }
        }
    }

    suspend fun download(context: Context, release: ApkRelease): File = withContext(Dispatchers.IO) {
        check(BuildConfig.APK_UPDATES)
        val directory = File(context.cacheDir, "updates").apply { mkdirs() }
        val file = File(directory, "agentdeck.apk")
        file.delete()
        try {
            client.newCall(Request.Builder().url(release.url).build()).execute().use { response ->
                check(response.isSuccessful) { "Download failed (${response.code})" }
                val body = response.body ?: error("Empty download")
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                file.outputStream().use { output ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(32768)
                        while (true) {
                            coroutineContext.ensureActive()
                            val n = input.read(buffer)
                            if (n < 0) break
                            total += n
                            check(total <= release.size && total <= maxBytes) { "Invalid download size" }
                            digest.update(buffer, 0, n)
                            output.write(buffer, 0, n)
                        }
                    }
                }
                check(total == release.size) { "Incomplete download. Try again." }
                val hash = digest.digest().joinToString("") { "%02x".format(it) }
                check(hash == release.sha256) { "Update integrity check failed" }
            }
            val pm = context.packageManager
            // API 28–29 leave `signingInfo` null for an ARCHIVE read with
            // GET_SIGNING_CERTIFICATES alone (a v2-only APK, as ours is), so a
            // Crema on Android 10 compared an empty signer set against the
            // installed one and refused every genuine update. Asking for the
            // legacy signatures too populates them; signerSet() uses whichever
            // the platform filled.
            @Suppress("DEPRECATION")
            val flags = PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
            val apk = pm.getPackageArchiveInfo(file.path, flags) ?: error("Invalid Android package")
            val installed = pm.getPackageInfo(context.packageName, flags)
            check(apk.packageName == context.packageName && apk.longVersionCode > installed.longVersionCode) {
                "This package is not a newer AgentDeck update"
            }
            val installedSigners = signerSet(installed)
            check(installedSigners.isNotEmpty() && signerSet(apk) == installedSigners) {
                "Update signing certificate does not match this installation"
            }
            file
        } catch (e: Exception) {
            file.delete()
            throw e
        }
    }

    /** The package's signing certificates, from `signingInfo` or, where the platform left it empty, the legacy `signatures`. */
    @Suppress("DEPRECATION")
    internal fun signerSet(info: android.content.pm.PackageInfo): Set<String> =
        (info.signingInfo?.apkContentsSigners?.takeIf { it.isNotEmpty() } ?: info.signatures)
            ?.map { it.toCharsString() }?.toSet().orEmpty()

    fun install(context: Context, file: File): Boolean {
        check(BuildConfig.APK_UPDATES)
        if (!context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")))
            return false
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        return true
    }
}
