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
   needed) in the name of West Midlands Evidence Based Emergency Medicine Ltd (company number 16644703); an organisation account also skips the 12-tester closed test that new personal accounts must run.
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

**App category:** Medical. **Free.** **Contains ads:** no. **Target audience:** 18 and over (emergency responders). **App name on Play:** Major Incident Triage.

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

**Health apps declaration:** Medical, **Medical reference and education** (training and exercises), with the "not a
medical device" disclaimer. Don't tick Clinical Decision Support or Medical Device Apps while the intended purpose is
training only: those describe use on real patients, which the listing says the app is not for. Change both together
if the app is cleared for real incidents. Intended purpose, word for word everywhere: **"Training and exercise use only. Not for use with real
patients."**

**Listing text (use as is; the whole full description is in [play-listing.md](play-listing.md)):**

- Short description (80 characters max): *Major incident triage practice (TST, MITT) for exercises. Not for real patients.*
  (80; the earlier wording was 96 characters, too long for Play)
- Start of the full description: *Major Incident Triage helps trained responders practise NHS England Ten Second Triage
  and the Major Incident Triage Tool, record interventions and hand casualties over between phones in exercises.
  Training and exercise use only. Not for use with real patients. This app is not a medical device and has not been
  approved for clinical use.*

Change the declaration and the listing only if the intended purpose formally changes (after the clinical safety case
and any UKCA marking).

**Permissions:** INTERNET, ACCESS_COARSE_LOCATION, ACCESS_FINE_LOCATION. Camera (QR and barcode scanning, and photographing a printed tag number for on-device reading) and microphone (voice notes, see the privacy notice) are requested by the
website through Chrome, not by the app, so it does not appear in the app's permission list.

**Account deletion:** not applicable, the app has no accounts.

**App access** (Play Console → Policy → App content → App access): choose "All or some functionality in my app is
restricted", because live sharing needs a code and PIN that the user makes. Add one set of instructions:

- Name: `Live sharing with a commander screen`
- Username and password: leave blank (there are no accounts).
- Any other instructions: `No sign-in is needed. On the start page type any name and tap "I'm a healthcare
  professional" (it shows everything), then tap START TRIAGE and answer the questions; this works offline. To see live sharing, on the start
  page of one device tap Demo, then Run a live exercise, then Control room.
  This creates a training incident and shows its code, PIN and QR code; tap Open the commander screen. On a second
  device type a name, tap Demo, Run a live exercise, choose a field role, and scan that QR code (or type the code and PIN). The
  first device's commander screen then shows the second device's casualties. Location and camera permissions are
  optional.`

**Testing tracks:** upload every bundle to **Internal testing** first and install it from Play on a phone. Check it
opens full screen (no address bar, which means `assetlinks.json` matches), works in flight mode, asks for location only
when needed, and that the live exercise above works between two phones. Then promote the same bundle to Production.
A personal developer account made after 13 November 2023 would also need a closed test with at least 12 testers for
14 days in a row; an organisation account does not.

**Store graphics:** icon 512 × 512 (32-bit PNG), feature graphic 1024 × 500 (no transparency), at least 2 phone
screenshots (4 at 1080 × 1920 recommended) that show the current version, with no device frames and no "Best",
"#1" or "Download now". Ready-made files are in the EM Evidence project at
`/mnt/project-files/plans/play-store/major-incident/`. Retake them when the screens change.

**Play Integrity API:** considered and not used. The app has no server-side accounts or paid content; joining an
incident is already gated by its code and PIN, and a tampered copy could only ever send its own triage records. Revisit
if the app is cleared for real incidents and a Trust requires attestation.

## Changing the app

- Site address: `hostName` and `defaultUrl` in `app/build.gradle`, `asset_statements` in `res/values/strings.xml`, the
  shortcut in `res/xml/shortcuts.xml`, and `.well-known/assetlinks.json` on the site.
- Version: `versionProps` in `app/build.gradle`; `code` must rise on every Play upload.
- Icons: generated from the site's `icon-512.png` and `icon-maskable-512.png`.
