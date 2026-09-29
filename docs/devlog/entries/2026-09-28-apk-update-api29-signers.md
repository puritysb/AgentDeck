# 2026-09-28 — In-app APK updates were refused on Android 10

The Crema (Android 10, API 29) found android-v1.6.0 and downloaded it, then
refused it: "Update signing certificate does not match this installation". The
installed app and the release APK carry the same certificate (SHA-256
`10603af8…`, confirmed with `apksigner` on both). The updater read the
downloaded archive with `getPackageArchiveInfo(…, GET_SIGNING_CERTIFICATES)`;
on API 28–29 that leaves `signingInfo` null for an archive, so an empty signer
set was compared against the installed one. Android 11+ (the Lenovo tablet, API
30) fills it, which is why the path had passed there. The updater now also asks
for the legacy `signatures` and uses whichever the platform filled
(`ApkUpdates.signerSet`). Verified end to end on the Crema: a build with the fix
downloaded, verified and installed the published 1.6.0 through Android's
installer. Because the check runs in the installed app, a device on 1.6.0 or
earlier needs the fixed build installed once by other means.
