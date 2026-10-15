# Android app (Google Play)

The Android app is a **Trusted Web Activity**: a thin launcher that opens https://majorincident.netlify.app in Chrome,
full screen, with the app's own icon, splash screen and location permission. Everything users see is the web app in
this repository, so a web deploy updates the app too; the Android project only changes when the icon, name, colours,
permissions or the site address change.

Package name `org.emevidence.mitriage`. Target API 36 (Google Play requires the current level for new apps and
updates). No native code, so the 16 KB page-size rule does not apply. Builds run in
`.github/workflows/android.yml`; nothing here has been built or installed on a real device yet, so expect the first
workflow run to need a fix or two.

## One-off set-up (Jake)

1. **Google Play developer account.** Google says health apps should use an organisation account (D-U-N-S number
   needed); an organisation account also skips the 12-tester closed test that new personal accounts must run.
2. **Upload key.** On a machine with Java:
   `keytool -genkeypair -v -keystore upload.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000`
   Then add four GitHub secrets: `ANDROID_KEYSTORE_BASE64` (`base64 -w0 upload.keystore`), `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS` (`upload`), `ANDROID_KEY_PASSWORD`. Never commit the keystore.
3. Run the **android** workflow (Actions → android → Run workflow) and download `app-release.aab`.
4. In Play Console create the app, choose **Play App Signing**, upload the bundle to Internal testing.
5. **Digital Asset Links.** In Play Console → Setup → App signing, copy the *app signing* SHA-256 fingerprint into
   `.well-known/assetlinks.json` (replace the first placeholder; the second is the upload key's fingerprint from
   `keytool -list -v`, useful only for builds installed by hand). Deploy the site. Until this matches, Chrome shows the
   app with a browser address bar instead of full screen.
6. Fill in the Play Console sections below, then release to Internal testing, then Production.

## Play Console answers (prepared; you are responsible for their accuracy)

**App category:** Medical. **Free.** **Contains ads:** no. **Target audience:** 18 and over (emergency responders).

**Privacy policy URL:** https://majorincident.netlify.app/privacy.html

**Data safety** (what leaves the device, and only when the user starts or joins live sharing with a commander):

| Data type | Collected? | Shared? | Purpose | Notes |
|---|---|---|---|---|
| Location (precise) | Yes, optional | No | App functionality | Casualty positions and the CCS position are sent to the commander screen. Used on the device even without sharing. |
| Health info (about casualties, not the user) | Yes, optional | No | App functionality | Triage category, timings, interventions, injuries, free-text notes. No names or NHS numbers are asked for. |
| User IDs / name | Yes, optional | No | App functionality | The triager's typed name and a random device code, so the commander screen can say who reported what. |
| Device or other IDs | No | No | | The device code is random and set by the app, not a hardware ID. |
| Crash logs, diagnostics, analytics | No | No | | The app has no analytics and no crash reporting. |

Data is encrypted in transit (HTTPS). Users can delete it: the server copy is deleted 24 hours after the last update,
or at once with *End incident for everyone*; records on the phone are deleted with *Close / reset incident*.
Data is not collected for advertising and is not sold.

**Health apps declaration:** the app is a clinical decision support / triage logging tool for trained responders using
the NHS England Ten Second Triage and Major Incident Triage Tool. It is not yet approved for real incidents: until the
clinical safety case is complete, describe it as *training and exercise use* in the listing, and change the
declaration and description when that changes. (Whether it counts as a medical device under UK MHRA rules is a question
for a regulatory adviser; the plan covers this.)

**Permissions:** INTERNET, ACCESS_COARSE_LOCATION, ACCESS_FINE_LOCATION. Camera (QR scanning) is requested by the
website through Chrome, not by the app, so it does not appear in the app's permission list.

**Account deletion:** not applicable, the app has no accounts.

**Play Integrity API:** considered and not used. The app has no server-side accounts or paid content; joining an
incident is already gated by its code and PIN, and a tampered copy could only ever send its own triage records. Revisit
if the app is cleared for real incidents and a Trust requires attestation.

## Changing the app

- Site address: `hostName`, `defaultUrl` and `assetStatements` in `app/build.gradle`, the shortcut in
  `res/xml/shortcuts.xml`, and `.well-known/assetlinks.json` on the site.
- Version: `versionProps` in `app/build.gradle`; `code` must rise on every Play upload.
- Icons: generated from the site's `icon-512.png` and `icon-maskable-512.png`.
