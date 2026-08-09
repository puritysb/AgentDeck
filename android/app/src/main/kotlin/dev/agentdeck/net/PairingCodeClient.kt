package dev.agentdeck.net

import android.os.Build
import android.util.Log
import dev.agentdeck.util.DeviceProfileHolder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

private const val TAG = "PairingCodeClient"

/**
 * Redeems an operator-issued pairing code for the daemon's token.
 *
 * This is the credential path for a device that can do neither of the two
 * things pairing used to require. It has no camera, so `agentdeck qr` is not a
 * flow it can complete; and it is not an ESP32, so there is no USB serial
 * channel to be provisioned over. What is left is `adb reverse`, which is a
 * developer tunnel that dies on reboot — so a reader that was working came back
 * from a power cycle unpaired, hammering an endpoint that closes it 4001, with
 * nothing on screen its user could act on.
 *
 * The exchange is one POST to a daemon the device already found over mDNS:
 * the operator reads a six-digit code off their Mac (`agentdeck pair`), types it
 * here, and the daemon answers with the token. Everything that makes that safe —
 * the window only exists while the operator holds it open, the code is short
 * lived, five wrong guesses close it — lives on the daemon; see
 * shared/src/pairing-code.ts.
 *
 * The token is returned rather than stored here. The caller persists it as a
 * `ws://host:port?token=…` URL through the normal
 * [PairingCredential.mayPersist] path, which is the one place allowed to decide
 * what overwrites a stored credential.
 */
object PairingCodeClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json; charset=utf-8".toMediaType()

    /** What the daemon said, translated into something a screen can show. */
    sealed interface Result {
        /** Paired. [wsUrl] is ready to be dialled and persisted. */
        data class Paired(val wsUrl: String, val token: String) : Result

        /**
         * Refused, and worth another try with a better code.
         * [attemptsRemaining] is what the daemon says is left in this window.
         */
        data class WrongCode(val attemptsRemaining: Int) : Result

        /** No window is open, or it closed. The operator must open a new one. */
        data object NoWindow : Result

        /** The window burnt through its attempts or its devices. */
        data object WindowClosed : Result

        /** Never reached the daemon. */
        data class Unreachable(val detail: String) : Result
    }

    /**
     * Redeem [code] against the daemon at [host]:[port].
     *
     * @param code as typed by the user; normalized here so a code entered with
     *   the space it was displayed with is not spent as a wrong guess.
     */
    suspend fun redeem(
        host: String,
        port: Int,
        code: String,
        deviceName: String = defaultDeviceName(),
        deviceKind: String = defaultDeviceKind(),
    ): Result = withContext(Dispatchers.IO) {
        val normalized = PairingCodeRules.normalize(code)
            ?: return@withContext Result.WrongCode(attemptsRemaining = -1)

        val body = JSONObject()
            .put("code", normalized)
            .put("name", deviceName)
            .put("kind", deviceKind)
            .toString()
            .toRequestBody(JSON)

        val request = Request.Builder()
            .url("http://$host:$port/pair")
            .post(body)
            .build()

        try {
            client.newCall(request).execute().use { response ->
                return@withContext interpret(
                    status = response.code,
                    body = response.body?.string(),
                    host = host,
                    port = port,
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "pairing request to $host:$port failed", e)
            return@withContext Result.Unreachable(e.message ?: "could not reach the daemon")
        }
    }

    /**
     * The daemon's answer, as the thing to put on screen.
     *
     * Pure and internal so the branch table has a plain-JUnit test: it is the
     * whole difference between "type it again" and "go open a window on your
     * Mac", and getting it wrong strands a reader on a screen whose advice
     * cannot work. The statuses are the shared contract in
     * shared/src/pairing-code.ts, not this client's invention.
     */
    internal fun interpret(status: Int, body: String?, host: String, port: Int): Result {
        val json = runCatching { JSONObject(body.orEmpty()) }.getOrNull()
        return when (status) {
            200 -> {
                val token = json?.optString("token").orEmpty()
                if (token.isEmpty()) {
                    Result.Unreachable("daemon accepted the code but sent no token")
                } else {
                    // Built from the endpoint we actually reached, not from
                    // anything the daemon told us to dial — the device already
                    // knows where it is talking, and a credential path is the
                    // wrong place to start following redirects.
                    Result.Paired(wsUrl = "ws://$host:$port?token=$token", token = token)
                }
            }
            // 401 covers both "no window" and "wrong code". They are the same
            // status on the wire on purpose — a closed daemon must not reveal
            // that somebody is pairing — so the body's error field is what
            // separates them, for the user's benefit only.
            401 -> when (json?.optString("error")) {
                "mismatch" -> Result.WrongCode(json.optInt("attemptsRemaining", -1))
                else -> Result.NoWindow
            }
            410, 429 -> Result.WindowClosed
            400 -> Result.WrongCode(json?.optInt("attemptsRemaining", -1) ?: -1)
            else -> Result.Unreachable("daemon answered $status")
        }
    }

    /** Redeem against a discovered bridge, using the endpoint it advertised. */
    suspend fun redeem(bridge: DiscoveredBridge, code: String): Result =
        redeem(host = bridge.host, port = bridge.port, code = code)

    /** What the operator sees in the CLI as this device's name. */
    fun defaultDeviceName(): String {
        val model = Build.MODEL?.trim().orEmpty()
        val brand = Build.MANUFACTURER?.trim().orEmpty()
        return when {
            model.isEmpty() && brand.isEmpty() -> "Android device"
            model.startsWith(brand, ignoreCase = true) || brand.isEmpty() -> model
            else -> "$brand $model"
        }
    }

    /**
     * Coarse device kind, so the operator can tell which reader just paired.
     *
     * `DeviceProfileHolder.current` auto-detects when nothing has been installed
     * yet and never throws, so this needs no fallback of its own — and a wrong
     * label is not worth failing a pairing over either way.
     */
    fun defaultDeviceKind(): String =
        if (DeviceProfileHolder.current.isEink) "android-eink" else "android"
}
