# Major Incident Triage

The app was previously called "MITT". It was renamed so it is not confused with the NHS Major Incident Triage Tool (MITT), which is one of the two triage flows it runs. Internal names (database, QR prefixes, export file names) are unchanged.

A mobile-first, offline-first **progressive web app** for documenting major-incident triage and handover. Built as a single-page vanilla JavaScript app — no build step.

> ⚠️ **Intended purpose: training and exercise use only. Not for use with real patients.** The app is not a medical device and has not been approved for clinical use (no UKCA marking, no DCB0129 clinical safety case yet). Use the same wording in the app, the website, the privacy notice and the Google Play listing. Any change of intended purpose comes only after the clinical safety, regulatory and information governance work in the project plan.

## Purpose

- Run **TST (Ten-Second Triage)** and **MITT** triage flows on a phone or tablet.
- Record interventions, demographics, allergies, notes, sector, evacuation status.
- **Hand over one patient or all patients** to another responder via offline QR codes, transfer file, OS share sheet, or Web NFC where supported.
- Produce a **METHANE** report and export the audit/casualty register as CSV.
- Operate with **no internet connection** once the page has loaded.

## Quick start

The whole app is static. Serve the directory from any HTTP server (HTTPS is required for camera/geolocation/NFC in production).

```bash
# Local dev:
python3 -m http.server 8000        # then open http://localhost:8000
# or:
npx http-server -p 8000
```

## Deployment (Netlify)

Drag-and-drop or `netlify deploy --dir .`. The `_headers` file sets a strict CSP and security headers. The `manifest.json` and `sw.js` are picked up automatically.

## Project layout

```
index.html        Single-page app — UI, triage flows, scanner, log, map, live sharing
commander.html    Incident commander dashboard (code + PIN; reads /api/incident every 30 s)
netlify/functions Serverless backend for live sharing (incident.mjs) and the hourly expiry sweep
netlify/lib       Backend logic, testable in plain Node (incident-core.js)
netlify.toml      Netlify build/functions settings; _redirects keeps tooling paths unpublished
lib.js            Pure helpers shared with the test suite (QR schema, merge, triage logic)
sw.js             Service worker — precaches all local + vendored assets, caches OSM tiles
manifest.json     PWA manifest
icon.svg          App icon (single SVG, scaled by the OS)
_headers          Netlify response headers (CSP, HSTS, Permissions-Policy)
vendor/           Locally-vendored CDN libraries (qrcodejs, html5-qrcode, leaflet, markercluster) for offline use & strict CSP
tests/lib.test.js Node test suite for pure helpers
.github/workflows/test.yml  CI workflow
```

## Clinical content (matches NHS England TST / NHS MITT cards, April 2023)

- **TST:** Walking → P3; Severe bleeding → P1; Talking → penetrating injury to the torso (front or back)? P1 : P2; not talking → Breathing? P1 (recovery position) : **Not Breathing**.
- **MITT:** Catastrophic bleeding → P1; Walking → P3; Breathing? no → **DEAD**; Responds to voice? no → P1; Aged over 2? no → P1; Breathing rate 12–23? no → P1; **Heart rate 100 or more?** yes → P1, no → P2.
- Categories follow NHS England casualty labelling: P1, P2, P3, **Not Breathing (TST only, silver)**, **Dead (MITT only, black)**. **P1 Hold** is hidden unless the incident commander allows it for the incident (from v0.19.0), and then only for clinicians, as a senior decision. "Expectant" is not used.
- Not Breathing casualties are flagged for **healthcare reassessment as soon as possible** (the app's own wording, not a quote from NARU). Dead does not require a time of death at triage (it can be declared when resources allow).
- TST labels/tags use a checked border; MITT uses solid colour (NHSE labelling guidance).
- Care prompts are drawn from the NARU "clinical interventions in the CCP" list, not the in-hospital MPTT-24 page.
- **Needs clinical sign-off:** the TST penetrating-injury wording ("torso — front or back") and the reassessment intervals (local defaults, configurable in ⚙ Settings) are not specified in the source documents.

## Patient identity

- Every record has a permanent random **uid**. Imports match on uid, never on the editable human ID alone.
- Automatic IDs are `DEVICE-TOOL-NNN` (e.g. `K7QX-TST-001`); the 4-character device code is generated once per device so two phones never issue the same ID. IDs already in use are always skipped.
- Same ID but different uid = **a different patient**: imported under `ID~DEVICE` and flagged, never merged.
- Re-triage and "Change last answer" update the same record (with full triage history), never create a blank duplicate.

## Handover

### Single patient (QR)
Sender taps **QR Handover** → receiver taps **Receive (scan)** → preview shows exactly what will change → Accept → receiver shows an **ACK QR** → sender scans it. The ACK carries the hash of the version accepted: if the sender changed the record after showing the QR, the sender is told the receiver has an **older version**. ACKs for unknown patients are refused. QR text is pure ASCII (non-ASCII characters are `\uXXXX`-escaped) and compressed (deflate + base64, prefix `MITZ1:`) when that helps. If a record is still too big for one code it is sent automatically as a multi-part QR.

### Merge rules
- A **more urgent** P1/P2/P3 always propagates. A **less urgent** category, or any change involving Not Breathing / Dead / P1 Hold, is never applied automatically: the receiver chooses (single QR) or it is flagged for review (multi-patient).
- Demographics that differ need the operator's choice. Allergies, interventions, injuries, location history and triage history are unions. Notes never nest (bounded on repeated round trips).
- The sender's handover state is never copied into the receiver's record.
- Every changed field, conflict and operator decision is written to the audit trail.

### Several patients (all / one sector / on-scene only)
**Hand over** on the home screen (Send patients to another device) → choose scope → **Show QR code(s)**. Codes are compressed and split into parts of ≤ 800 characters. The receiver's camera **stays on**; parts can be scanned in any order, repeats are ignored, progress survives an app restart, and a code from a different transfer asks before discarding progress. The sender can auto-cycle parts. After import the receiver shows a **confirmation QR** (MIT_TACK) that the sender scans. Measured sizes (realistic records, audit not included): 10 patients 5 parts, 50 patients 12 parts, 100 patients 21 parts. Compression relies on the browser's CompressionStream; where it is missing, transfers still work but need more parts.

Offline alternatives: **Export transfer file** / **Share file** (AirDrop / Nearby Share / USB) and **Import transfer file**. Web NFC is offered only where supported, only for tags, and only for small records; browsers do not support phone-to-phone NFC or Bluetooth transfer.

### Age and clock checks
Old QRs/files (over 8 h) and clock differences are **warnings, never blocks** — patient data does not become untrue after 8 hours.

### "Hand over care to a colleague"
Scanning a colleague's **My ID** records who took over care (it no longer marks the patient evacuated) and then offers to show the patient QR so they receive the full record.

## Audit trail (for debrief and inquiry)

- Every entry: sequence number, device ID, user, role, system time (epoch ms + ISO 8601 with UTC offset), clinical time, patient ID and uid, details, device position, app version, **SHA-256 hash chained to the previous entry**. Editing, deleting or reordering any stored entry is detected (on start-up and via **Verify audit trail**). This is tamper-*evidence*, not prevention: note the head hash shown on verification/export.
- Audited: user sessions/changes, triage/re-triage/corrections, every field change with old → new values, category changes and deterioration, interventions (removal needs confirmation), body-map marks, location updates, reassessment, evacuation, QR generation, imports field-by-field, conflicts and operator decisions, ACKs, transfers, exports, METHANE versions, settings, migrations, data wipe.
- Other devices' audit rows (only if the sender chose to include them) are stored separately with their own chains and de-duplicated.
- Exports: **Casualty Register (CSV)** — every record, uid, full triage history, ISO times; **Audit Trail (CSV)** — own + imported rows with hashes; **METHANE history (CSV)**; **Full Incident Archive (JSON)** — everything, with chain verification and the file's SHA-256 logged. CSVs are UTF-8 with a BOM and neutralise spreadsheet formulas.
- **Close / Reset Incident** requires saving an archive first, keeps a permanent wipe record (counts, audit head hash, archive SHA-256), and starts the new audit chain with a `DATA_WIPE` entry citing the old head hash.
- **Clear everything and start again** (v0.15.0) wipes without an archive: on a real-use phone with records the user types `CLEAR`; the same wipe record and `DATA_WIPE` entry are kept, with "no archive saved" noted.

## Storage safety

Data is written to IndexedDB after every change (and when the app is hidden or closed). Nothing is written until stored data has loaded, so an early save can never overwrite the log. If IndexedDB is unavailable at start-up, a red banner says so and data is saved to backup browser storage instead. If a write fails (for example, iOS dropping the database connection while the app was in the background), the app reconnects and retries once; if it still fails, a red banner says so and **Export archive now** is offered. The app requests persistent storage. The footer shows when data was last saved.

## iPhone and iPad

MITT is written for Safari on iOS 15 and later; older versions may work but are untested. The automated tests run in Chromium set up to behave like an iPhone (screen size, notch, missing features); they are not a substitute for testing on a real iPhone (see the QA checklist below). Differences from Android:

- **Install it:** Share button → **Add to Home Screen**, before an incident. In Safari (not installed), iOS can delete a site's saved data after 7 days without use; the Home Screen app is exempt. The Home Screen app keeps **its own records, separate from Safari**, so anything triaged in Safari must be sent across (QR or transfer file) before switching. The app shows this tip on iPhones until dismissed.
- **QR handover:** iPhones on iOS older than 16.4 cannot use the browser's built-in decompression, so MITT includes a decompression library (`vendor/pako_inflate.min.js`) and those iPhones can still receive compressed codes. They send uncompressed codes, which may need more QR parts.
- **Saving exports:** on iPhone, exports open the share sheet (**Save to Files**, AirDrop, Mail) instead of a download. A cancelled share is recorded in the audit trail as `FILE_SAVE_CANCELLED`.
- **Not available on iPhone:** vibration feedback, NFC tags (the NFC buttons are hidden), and keeping the screen awake in the Home Screen app before iOS 18.4. Set Auto-Lock to a long interval or **Never** during an incident.
- **Camera:** the Home Screen app may ask for camera permission again after it has been closed.
- **Layout:** the header, dialogs, toasts and bottom bars stay clear of the notch / Dynamic Island and the home bar.

## Manual two-phone QA checklist (do this on your real devices before use)

Use **one iPhone and one Android phone** for at least one full run, and do steps 3, 5 and 6 in both directions.

1. Load MITT on phone A and phone B once online (on the iPhone, from the Home Screen icon), then switch both to airplane mode; confirm both still open.
2. On A, triage a TST patient (tap a quick-injury emoji button, add an allergy with an accent or £), a TST "not breathing" patient, and a MITT patient.
3. QR Handover from A to B: check B's preview, accept, scan B's ACK on A → "Handover accepted".
4. Change A's patient to a more urgent category, hand over again, and confirm B updates. Change it to a less urgent category and confirm B asks you to choose.
5. On A, **Hand over** (Send patients to another device) → All patients → Show QR codes. On B, **Receive (scan)** and hold the camera on the cycling codes; confirm progress, then accept and scan B's confirmation on A.
6. Repeat with **Export transfer file** on A and **Import transfer file** on B.
7. Press the Android back button on several screens; the app should never close.
8. Log → **Verify audit trail**, then export the Casualty Register, Audit Trail and Full Incident Archive and open them on a computer.
9. Record the scan distance, lighting and number of attempts; scanning performance varies by phone camera and screen.

## Live sharing with an incident commander (optional, needs signal)

Off by default. When a phone starts or joins sharing, its triage records go over HTTPS to `/api/incident/<code>/records` on this site, protected by the incident code and PIN. The server keeps only the minimised record (the same fields as a QR handover: no names, no NHS numbers) for 24 hours after the last update, then deletes it. The phones remain the record of truth and keep the audit trail. The commander page is an aid for a live incident, not a clinical record system. From v0.18.0 a phone can also choose to share its own position (asked once when linking, off by default, changeable in Settings): the latest fix rides each report and the commander map shows a 👤 marker per triager, grey once it is over five minutes old. Holding the 🆘 button for two seconds sends a call for help at once (name, time and position, whatever the sharing setting); the commander screen sounds an alarm and shows a red banner until the commander or the phone clears it, and both ends write it to the phone's audit trail. The commander clears it with `POST /api/incident/<code>/duress-clear` (full PIN only). The server functions run in Netlify's London region. The records are kept in Google Cloud Firestore in London (europe-west2) when the three `FIRESTORE_*` settings below are in place (the live site has used Firestore since 17 October 2026); without them they fall back to Netlify Blobs, whose region cannot be chosen. Each API response carries an `X-Incident-Store` header (`firestore` or `netlify-blobs`) saying which is in use. The app is for training and exercise use only.

### UK hosting (Firestore, London)

1. In Google Cloud (or Firebase), create a Firestore database in **Native mode** with location **europe-west2 (London)**. The location cannot be changed later.
2. Create a service account with the **Cloud Datastore User** role and make a JSON key for it.
3. In Netlify › majorincident › Site configuration › Environment variables, add (scope: Functions): `FIRESTORE_PROJECT_ID` (`project_id` from the key), `FIRESTORE_CLIENT_EMAIL` (`client_email`) and `FIRESTORE_PRIVATE_KEY` (`private_key`, pasted as it is, `\n` escapes are fine). Optional: `FIRESTORE_DATABASE` if the database is not `(default)`, `FIRESTORE_COLLECTION` (default `mi_kv`).
4. Redeploy. Check `curl -sI https://majorincident.netlify.app/api/incident/ABCDEF` shows `X-Incident-Store: firestore`.

Switching store does not copy anything across, so any incident being shared at that moment is lost from the commander screen (the phones keep their own records). Switch when nothing is live. Code: `netlify/lib/firestore-store.js`, chosen in `netlify/lib/pick-store.mjs`; tests: `tests/firestore-store.test.js` (runs the whole backend suite through the Firestore store, against a stand-in or, with `FIRESTORE_EMULATOR_HOST`, the Firestore emulator).

## Privacy posture

- **No names, DOB, or NHS numbers are stored by default.** The free-text demographics field accepts anything the user types; teams should set local guidance accordingly.
- All patient data lives in **IndexedDB on the device**; nothing leaves the phone unless live sharing is started (see above). **Close / Reset Incident** requires an archive first (see Audit trail). Transfer and archive files contain patient data: handle them under your local information-governance rules.
- Offline-first: no analytics, no third-party requests at runtime apart from OpenStreetMap tile fetches when the map view is opened.
- **Voice notes** (🎙, optional) use the browser's built-in speech recognition, which may send the recording to the browser maker's online speech service (for example Google for Chrome). Real-use phones show a notice before first use. Do not dictate identifying details; check with your information governance lead before using voice notes with real patients.

## Running tests

```bash
node tests/lib.test.js          # logic: merge, IDs, transfer, audit chain, triage flows (no dependencies)
node tests/incident-core.test.js # live-sharing backend with an in-memory store (no dependencies)
node tests/syntax-compat.js     # fails on JavaScript syntax too new for older iPhones (needs npm install)
npm install && node tests/e2e.js # real app in headless Chromium, simulating two phones
```

The end-to-end suite covers the two-phone handover, the map and location features (pin on map, same place as last patient, exports, blocked-location help, 360 px layout), multi-part transfer, reload persistence, audit tamper detection, legacy migration, storage failure, reset, iPhone behaviour (old-iOS decompression, share-sheet export, notch layout, no zoom-on-tap, database reconnection), and checks the app's QR codes against a reference encoder. CI runs both on every push (see `.github/workflows/test.yml`).

## Intended-use limitations

- The app is a **prototype** and has not been clinically certified. Do not deploy in live operations without local sign-off, training, and integration with primary triage tags.
- QR transfers are **best-effort**: always also tag the patient physically.
- The service worker aggressively caches; force-refresh after deployments to pick up updates.
- Camera/geolocation/NFC require HTTPS in production browsers. GPS can be poor indoors, underground, near tall buildings, or in dense crowds; always confirm sector/landmark/floor/area when accuracy is degraded.

## Contributing / change log

### v0.22.1 build 2026-10-31-ftu — first-time-user fixes (Jake, 31 October 2026)

From a walk-through as a first-time user with no training, and an edge-case test.

- **Typed or counted rates that contradict the answer** (MITT breathing rate and pulse): the phone now asks before taking the answer ("RR 30/min means NO: Answer NO / Keep YES"). Keeping the answer is noted on the record and in the audit. Before, RR 30 + YES and HR 140 + NO gave P2 with "Measured: RR 30, HR 140" on the record.
- **A quick second tap no longer skips the result.** "Next casualty" sits where YES was; taps in the first 0.8 s of the result screen (0.4 s on other screens) are ignored.
- **No "Triage not finished" warning** after a reload when no question had been answered (for example Next casualty, then the phone locked).
- **Linked demo link on a phone in real use** asks first and says how to get back (Settings → Training mode off); before, it switched to training mode silently.
- **Start the commander screen**: says whether the incident will be marked as practice; the pop-up says to tap "Open the commander screen" (it said the screen "opens below") and uses the button names triagers actually see. The commander sign-in page says how to start a new incident.
- **Reassess** says "next check in 15 min", "overdue 5 min" or "needs a clinician now" (was "OK 15m", "CLINICIAN NOW"); the reassess pop-up explains improved / unchanged / worsened.
- **Commander screen**: Needs attention has one row per casualty with all its reasons, and counts casualties; at most 4 alerts shown at once ("Show N more"; calls for help always shown); the Evacuated tile says "of N casualties recorded"; "Overdue 0 min" reads "Due now"; the activity chart starts at the first casualty.
- **Wording and layout**: iPhone "Add to Home Screen" note shortened (details under "Why?"); "Patient log" used throughout; Settings shows Paramedic / Doctor or nurse; result screen says "Patient" like the question screen; the log shows grid references; a missing name is a plain prompt, not a red warning; the last question says "(last)"; the demo auto-play button moved to the top so it no longer covers buttons.
- **Text-direction control characters** are removed from names (they could show reversed text on the commander screen).

Not changed (clinical sign-off needed): the P1 penetrating-injury result says "Open wound to the chest: chest seal if trained" although the question covers neck, abdomen, back, groin and buttocks.

### v0.22.0 build 2026-10-31-commander — commander screen (Jake, 31 October 2026)
- **Casualty IDs tell phones apart:** short IDs keep the phone's code (2XMB MITT 003); two phones' casualties both showed as "MITT 003" in alerts and Needs attention.
- **Needs attention lists the waits:** a P1 still in the field more than 10 minutes after triage (a P2 after 30), and a P1 at the casualty clearing station not evacuated after 30 minutes (a P2 after 60), longest wait first, with tourniquet times in hours and minutes (over 2 hours goes to the top).
- **Is the incident still growing?** Under the counts: new casualties in the last 10 minutes, the longest wait of a P1 in the field, and a bar chart of new casualties every 5 minutes (P1s in red).
- **📋 Copy situation report:** one line with the incident, time, totals by category, where they are and where they went, for the radio or a log.
- Wording: "Tell clinicians to use MITT", "Due soon (HH:MM)", "not yet triaged with MITT", "Open incident", a shorter note under the counts.
- Service worker cache v56. Web change only: no Android rebuild.

### v0.21.0 build 2026-10-31-demo — linked demo: the commander screen and demo phones together (Jake, 31 October 2026)
- **demo.html** (▶ Demo → "🖥 Linked demo", or the link on the commander sign-in page) starts a practice incident on the server and shows the commander screen with 1 to 4 demo phones beside it, all linked to that incident, on one computer. Each phone is a separate copy of the app (index.html#sim=N) with its own storage and database, always in training mode, with a simulated position near the demo site (sim-shim.js).
- **Auto-play** (on by default, three speeds): each demo phone records its made-up casualties from the demo scenario by itself, one every 15–30 seconds at normal speed, through the real TST or MITT questions (it taps the same YES / NO buttons, so the commander screen fills as it would in an incident). Anyone can tap a phone at any time: auto-play waits while it is being used, and the purple 🎬 button on each phone pauses or resumes it.
- **On other devices:** 📱 Other devices shows a QR code per demo crew (and the commander's sign-in details). A phone or tablet that scans one switches to training mode, sets up as that crew, joins the same practice incident, and auto-plays if chosen (demo-phone.js).
- **End demo** (tap twice) ends the practice incident for everyone and clears the demo phones' storage on this computer.
- Pages may now be shown inside a page of the same site (X-Frame-Options SAMEORIGIN, frame-ancestors 'self', frame-src 'self'), which the linked demo needs; other sites still cannot.
- Service worker cache v55 (also stores demo.html, demo.js, demo-phone.js and sim-shim.js). Web change only: no Android rebuild.

### v0.20.0 build 2026-10-31-start — simpler start screen and clearer wording (Jake, 31 October 2026)
- **The start screen asks one thing: Medical or Not medical** (two big buttons), with a smaller "🎖 Running the incident? Start the commander screen" link. The next step asks for the name and, for medical, Paramedic or ambulance clinician / Doctor or nurse. The header shows that role ("Paramedic", "Doctor or nurse", "Not medical").
- **One name for each action.** ⇄ Hand over sends casualties to another phone and 📷 Receive takes them in, everywhere (it was also "Send patients", "QR Handover", "Receive patient", "Receive (scan)"). The receiver's reply is the "confirmation code" (was "ACK"/"acknowledgement"). Recording who took over care is "Record who took over care", not another "hand over".
- **Messages point to things that exist:** the result screen section is now "Change category" (messages said "under Change category" while it was called "Other"); the commander page names the new start-screen link.
- **Reassess box says what really happens:** Worse means the triage questions again; Better means use ↻ Re-triage afterwards (it said "change it on the next screen", which only happens for Worse).
- **Triage errors say what to do** (Cancel, triage again, use the paper tag) instead of showing a technical message; the detail goes to the audit.
- **Dialog buttons say what they do** for calling for help, stopping sharing, ending the incident, changing user and clearing a call for help (no bare "Cancel").
- **Incident full mid-triage:** after the first warning, or in the middle of a triage, a message that does not stop the triage (it opened a box that had to be dismissed each time).
- Smaller wording fixes: "Next casualty →", "Casualty log", "Start triage", "Delete all casualties from this phone…", "Not breathing (clinician must reassess)", the exercise guide no longer mentions capillary refill (the app does not ask it), the demo log card says "newest first".
- **Not changed (clinical sign-off needed):** the wording of the TST/MITT questions and actions. See the review in the test report.
- Service worker cache v54. Web change only: no Android rebuild.

### v0.19.14 build 2026-10-31-signal — fixes from the v0.19.13 stress test (31 October 2026)
- **A call for help says whether it has gone.** With no signal the 🆘 button said "HELP CALLED" and "live on the commander screen" when nothing had been sent. It now shows SENDING HELP… until the server has it, then HELP CALLED ✓ (with a vibration, a message and an audit entry). After a failed attempt it turns amber: HELP NOT SENT, with a warning to use the radio, and the phone tries again every 5 seconds until it goes.
- **Casualties waiting for signal are visible.** While reports are failing, the home screen shows "☁ ✗ N casualties not yet sent to the commander" (tap to try again) and the status button says "N not sent", instead of only a ✗ and a tooltip a phone cannot show.
- **Sending resumes faster when signal returns:** failed reports are retried after 5, 10, 15… seconds up to every 30 seconds (it was up to every 5 minutes), as well as at once when the phone reports being back online.
- **The commander's "nearly full" figure is not inflated:** the screen shows the smaller of the server's running figure (which a batch sent twice at once can push up until the next real count) and the casualties it actually holds.
- Service worker cache v53. Web change only: no Android rebuild.

### v0.19.13 build 2026-10-31-count — fixes from the v0.19.12 check (31 October 2026)
- **The casualty count can no longer drift and call an incident full early.** The running total could only ever run high (a batch resent after a phone timed out, two copies of the same new casualty at once, a write that failed after being counted) and nothing recounted, so an incident could refuse casualties well before it held 3,000. Nothing is now refused on the running total alone: near the limit the stored casualties are counted for real, together with those other reports are still writing, and that count is kept beside the total (replaced whole, so two reports correcting at once cannot take anything off twice; at most one real count a minute while the incident stays full). Reports sent at the same moment still cannot take an incident past its limit; near the limit they may refuse a little too much, and the phones send those again with their next report. The commander's "nearly full" figure uses the corrected count.
- **Incidents started before v0.19.12** are counted once, safely, even if two reports arrive together (before, both added the whole incident, so one holding 1,600 could read as 3,200 and refuse everything new).
- **Map bubbles: Not Breathing now ranks straight after P1** (P1, Not Breathing, P1 Hold, P2, P3, Dead), so a bubble of 9 P3s and 1 Not Breathing is grey, not green.
- **The phones' map now has the same bubbles as the commander screen** (most urgent colour, a count per category). It still had the map library's default bubbles, coloured by size.
- Service worker cache v52. Web change only: no Android rebuild.

### v0.19.12 build 2026-10-31-scale — fixes from Jake's 120-to-3,000-casualty and map test (31 October 2026)
- **The 3,001st casualty is no longer lost.** When an incident holds its limit (3,000), the server says "incident full" for each casualty it refuses. The phone keeps them queued as not sent (☁ ⚠ FULL on the pill, a red card on the home screen, a warning with vibration and an audit entry) and tries again with later reports, after everything else, so changes to casualties already sent still go. The commander screen shows a red "INCIDENT FULL" box listing the refused casualties (category, ID, sector, phone, time), with an alert sound when more are refused, and an amber "nearly full" box from 90%.
- **Stored casualty count.** Each incident keeps a counter (added to atomically), so a report that adds casualties no longer reads every record to check the limit. Reports sent at the same moment cannot take an incident past its limit.
- **Commander refreshes send only what changed.** The server keeps change numbers for casualties, phones and decisions, and a change feed of which casualties changed. An unchanged incident answers in a few document reads whatever its size; a change sends only the changed casualties (plus the phones, and the decisions if they changed). A first load comes in parts of about 2 MB, so long notes cannot make one reply too big or too slow. Older commander screens still work the old way.
- **Map bubbles take the colour of the most urgent casualty inside them** (P1, P1 Hold, P2, P3, Not Breathing, Dead, in the app's priority order), with a count for each category. Evacuated casualties only colour a bubble that holds nobody else.
- **An open pop-up on the commander map stays open** through refreshes: markers are kept and updated in place, not redrawn. Triager markers and map markings likewise.
- **Lighter commander page:** the casualty list draws 200 rows at a time (Show more / Show all), Needs attention draws its first 100 (most urgent first), the map adds markers in bulk, and accuracy circles are drawn only round casualties shown on their own and in view (so they group with the bubbles).
- **Needs attention lists a Not Breathing casualty once**, with any overdue time on the same line.
- **Ending a big incident is quicker:** deletes go in several batches at once.
- **Earlier rounds:** access keys from before v0.19.8 now count as view-only (no longer at triager level). Each decision document carries its own log entry, so the decision log stays complete even where a decision and its log entry cannot be saved together (Netlify Blobs). Phones on an incident from before v0.19.6 (one PIN) show that PIN for linking phones. Each casualty records which phone first sent it, and the commander screen shows "first sent by" when another phone changed it. New tests for a joined phone changing another phone's casualty, the 409 shut-outs (device code taken, phone limit), the incident limit under concurrent reports, changes-only refreshes and paged loads.
- **Not changed:** any joined phone can still change any casualty (re-triage by another responder is needed, and the role is self-declared, so a server rule would add no real protection).
- Service worker cache v51. Web change only: no Android rebuild.

### v0.19.11 build 2026-10-31-retest — fixes from Jake's v0.19.10 retest (30 October 2026)
- **One person can no longer lock new phones out.** An address with no wrong PINs of its own that day gets one try again, even past the incident's daily limit. Past that limit, those one-try addresses can only get 100 wrong between them that day, so guessing from many addresses stays capped: the incident limit is now 300 wrong a day (a calendar day, UTC), so at most 400 checked guesses a day (800 across midnight), about a 0.12% (0.24%) chance a day of hitting one of the 3 PINs.
- **Wrong-PIN counts are atomic across server copies.** They are now counters the store adds to (Firestore increments), counted before the verdict is read back, so guesses sent together are all counted. (Netlify Blobs, used only before Firestore is set up, has no atomic increment.)
- **A linked phone or screen is never held up by its address's wrong-PIN count** (another device behind the same mobile network address may have guessed wrong). Only requests without a key covering their PIN are counted and limited.
- **Clock correction only above 10 seconds** (2 s in v0.19.10 treated a slow delivery as a wrong clock). A phone 30 or 45 seconds out is still corrected; one less than 10 seconds out is not.
- **A full phone store no longer stops the app opening**: the page from the network is used even if storing it fails.
- **Dead set by hand is held back** from the commander until its time-of-death box is answered, so an undone Dead is never seen. Reports and calls for help still go meanwhile.
- **Map limit:** markings added at the same moment can no longer take the map past 30 (the later change is taken back with a message), so none is hidden.
- **Decision log:** entries are no longer deleted; the commander screen shows the newest 200.
- Two more unconfirmed source credits removed from the README ("NHS England guidance" on the MITT reminder and "NHSE B0128" on time of death), and one from a code comment. Wording unchanged.
- Service worker cache v50. Web change only: no Android rebuild.

### v0.19.10 build 2026-10-30-stress2 — fixes from the v0.19.9 stress test (Jake, 30 October 2026)
- **PIN guessing spread over many addresses is stopped.** Each incident now also counts wrong PINs over a day: after 500, only phones and screens that already hold the incident's key get in (a clean address no longer gets its one try). At most 500 guesses a day against 3 PINs out of 1,000,000 is about a 0.15% chance a day. Addresses in the same IPv6 /64 block count as one address.
- **Phones on v0.19.7 or earlier are asked to update** instead of joining unkeyed ("Close the app fully and open it again to update it, then join again"), so nobody with the triagers' PIN can send under, rename or take over another phone's device code. Only a phone that has joined and holds its device key can send; a report from a device code that never joined is refused (and no longer creates an unlabelled phone on the commander screen).
- **Clock skew of more than 2 seconds is corrected** (was 60 seconds), so a phone up to a minute slow no longer loses a genuine later update. Records are still only labelled with the skew when it is more than a minute.
- **"Change the last answer"** still fixes a mis-tap in the triage just saved, but a non-clinician cannot use it to move a casualty out of Not breathing, Dead or P1 Hold once anything newer has been recorded for them (same rule as re-triage).
- **Setting Dead by hand:** the time-of-death box says the category was set by hand (not the MITT airway wording), Back undoes the change (back to the previous category, logged as CATEGORY_CHANGE_UNDONE), and the "Share your position?" question waits until the box is answered.
- **Map markings:** each marking is its own document and the commander screen sends only what changed, so two people marking the map at once both keep their edits. An older commander screen that sends the whole list still works (it replaces the list, as before).
- **Fewer reads:** a phone's report only fetches the map markings when they have changed; incidents started from v0.19.10 skip the older single decision and markings documents; the decision log is pruned to its newest 200 entries.
- **The commander screen updates like the app:** commander.html and commander.js are fetched from the network first with index.html and lib.js, all four stored as one set; when a stored copy has to be used, the new set is stored 15 seconds later so a page already loading cannot pick up newer scripts than itself.
- **Source credits:** two unconfirmed credits removed from code comments ("NHS England TST card" for the healthcare-professional rule, and "NARU / NHSE B0128" for the P1 Hold label). The wording itself is unchanged.
- Service worker cache v49. Web change only: no Android rebuild.

### v0.19.9 build 2026-10-30-wording — source wording (Jake, 30 October 2026)
- **Not Breathing wording no longer credited to NARU.** "Must be reassessed by a healthcare responder as soon as possible" stays in the app, but the README and code no longer say it is a NARU quote (the tester could not find it in the NARU documents).
- **MITT reassessment timers (P1 10, P2 30, P3 60 minutes) are labelled as suggested timings**, not taken from a published source, in Settings, the code and the README. Jake confirmed them for now as suggested timings.
- Jake signed off the v0.19.7 and v0.19.8 clinical wording (under-2 severe bleeding step, follow-on care such as the recovery position after a tourniquet, and the time-of-death prompt).

### v0.19.8 build 2026-10-30-stress — fixes from the v0.19.7 stress test (Jake, 30 October 2026)
- **Phones on an old app version can still send.** A phone that joins without saying it uses device keys (v0.19.5 or earlier) is accepted unkeyed and its casualties arrive; the commander screen labels it "Old app version" and says to close and reopen the app, then join again. Once it joins from a current version it gets a device key and the old rule (no key, no report) applies again.
- **Opening the app fetches the current version first.** The service worker tries the network for the page and lib.js (as a pair) for up to 3 seconds and uses the stored copy only if that fails, so the first load after a release shows the new version when there is signal. Offline still opens at once from the stored copy.
- **Commander actions at the same moment no longer overwrite each other.** Each decision field (P1 Hold, MITT prompt) is now its own small document and each decision-log entry its own document, so nothing reads and rewrites a shared document. (Firestore transactions were tried first: twelve at once on one document retried for longer than a function is allowed and gave 504s on the deploy preview.) Incidents started before v0.19.8 keep their single decisions document underneath.
- **Non-clinicians cannot re-triage a casualty out of Not breathing, Dead or P1 Hold** (whichever route starts the re-triage), and cannot pick a less urgent incoming category when importing a handover. The same rule as changing the category by hand.
- **PIN lock-out.** The access key is tied to the PIN level it was given for, so a triager's or observer's key cannot be used to guess the commander PIN past the incident's 100-wrong-PIN lock-out, and every wrong PIN counts whoever sends it. An address with no wrong PINs of its own is let through the incident lock-out once with a right PIN, so strangers' guesses cannot keep out a new commander screen or a re-joining phone.
- **A phone joined with the commander PIN does not hand it out:** its details sheet, QR and "Copy link and PIN" show no triagers' PIN and say to ask the commander for it.
- **Clock skew.** METHANE and the casualty clearing station position are compared by what the phone sent, not the corrected time, so a phone with a wrong clock no longer makes the same METHANE look new on every report (which kept the incident alive and forced commander reloads). Triage and creation times are corrected along with the update time.
- **Smaller fixes:** the commander screen says "Incident ended" (not expired) for an ended incident; a typed time of death later than now is dated yesterday; setting Dead by hand asks for the time of death; the incident-creation limit is counted in memory before anything is awaited; one store error no longer stops the hourly clean-up. Service worker cache v46. Web change only: no Android rebuild.

### v0.19.7 build 2026-10-30-under2-bleeding — under 2s are asked about severe bleeding; follow-on care on P1 results (Jake, 30 October 2026)
- TST "👶 Child under 2? Tap: always P1" no longer ends the triage straight away: it goes on to **Severe bleeding?** so bleeding is found and treated first. Either answer gives P1; YES records the reason "Severe Bleeding, Child Under 2" with the bleeding treatment, NO records "Child Under 2". Back and "Change last answer" work through the extra question.
- The card stops at the first P1 answer, so the result's action line now also says what else may be needed once the first treatment is done. For example TST severe bleeding: "Then, if they are not talking but are breathing: open the airway and place them in the recovery position (leave the tourniquet on)". Also added: chest seal for an open chest wound (TST penetrating injury, MITT catastrophic bleeding), and keep warm / with carer for under 2s. The care prompts list matches. Records triaged before this version keep their old action text.
- Quick reference card updated to match. This wording needs clinical sign-off with the rest of the card text. Service worker cache v45. Web change only: no Android rebuild.

### v0.19.6 build 2026-10-30-findings — fixes from the v0.19.5 test (Jake, 30 October 2026)
- **Three PINs** for each new incident: the triagers' PIN (link phones and send casualties), the **commander PIN** (commander screen decisions, map markings, clearing a call for help, ending the incident) and the view-only PIN. The triagers' PIN opens the commander screen as view only, labelled "View only (triagers' PIN)". Incidents started before v0.19.6 keep their single PIN with full access until they expire.
- **Every decision is named**: P1 Hold allowed or withdrawn, MITT prompts, map markings and cleared calls for help need the name and role of who made them (asked once on the commander screen), and a decision log shows who did what.
- **Phone reports can no longer undo commander decisions**: decisions, markings and cleared calls for help are stored apart from what phones write, so a report sent at the same moment cannot write an older copy back.
- **Wrong phone clocks**: phones send their clock with each report; the server moves record times onto its own clock and never accepts a time in the future, so a phone a year fast cannot block a later real change.
- **Storage errors** are now server errors (phones retry), not "incident not found". Phones only unlink when the server says the incident has **ended** or **expired** (ended incidents leave a marker for 48 hours, so phones and screens are told "ended").
- **Wrong PINs**: guesses sent in parallel are counted (25 per address per 15 minutes), and an incident that gets 100 wrong PINs from anywhere refuses strangers for 15 minutes while linked phones and screens carry on with a key the server gave them. A wrong code and a wrong PIN get the same reply.
- **Device codes**: a phone gets a device key when it links, so another phone cannot report under its device code, rename it or clear its call for help.
- **Expiry**: only new information (casualties, CCS position, METHANE, decisions) keeps an incident alive; heartbeats with nothing new no longer reset the 24-hour clock. Starting incidents is limited to 10 an hour from one address.
- **Linking asks before sending any casualty already on the phone** (unless already marked with that incident's code).
- **Category changes by hand**: non-clinicians can only make a casualty more urgent, never change to or from Not breathing, Dead or P1 Hold; re-triage with the questions is still open to all. A changed category replaces the old instruction text.
- **Time of death** is cleared when a casualty is no longer Dead, and is recorded with the date.
- **Correcting a mis-tap** ("Change the last answer") is no longer flagged as deteriorating.
- **Stab-wound question**: the card wording is unchanged; the hint underneath now names the neck, chest, belly, back, armpits, groin and buttocks (NARU guidance; Jake's choice).
- **🏠 during triage** asks before leaving, like Cancel, and logs it. The update banner never covers YES / NO / Back during triage. A new version found in the first 15 seconds after opening is switched to at once.
- **Leaving the demo** returns the phone to the mode it was in before (training stays on if it was on); casualties triaged during the demo are cleared with the demo ones.
- **Dialogs** wait their turn instead of replacing each other; Escape and Android Back close the most recently opened one.
- **MITT counting help**: a counted rate within 4 a minute of a cut-off says so ("count for longer or type the rate").
- Smaller: no "Non-clinical" label before a role is chosen; Back ignores a double tap; white-on-orange MITT badge and Demo button darker (4.6:1); questions announced to screen readers; reassessment interval selects labelled.
- Tests: cut-offs, time-of-death clearing and category-change permissions now have unit tests.
- Service worker cache v44.

### v0.19.5 build 2026-10-30-retest — fixes from Jake's retest of v0.19.4 (30 October 2026)
- **↩ Back** on the question screen shows the previous question again (it used to leave the screen unchanged and upset the question counter; the final category was not affected in the case tested).
- **Reload part-way through a triage**: the app now says the triage was not finished and nothing was saved for that ID, logs it (TRIAGE_NOT_FINISHED), and does not give that ID to the next casualty.
- **Linking to a commander**: casualties already on the phone that look older (over 3 hours old with no matching incident code, another incident's code, or demo casualties outside the demo) are only sent if the phone says "Yes, send them too". Re-linking to the same incident keeps the earlier answer.
- **Demo leftovers**: demo phones keep their own ID prefix (no more TRAIN-DEMO-FR-… IDs or duplicate IDs across phones). After leaving the demo, the DEMO-KESTREL incident code, DEMO prefixes, demo names and demo casualties are cleared; a different person setting up during the demo ends it.
- **Commander's phone** header says "Incident commander", not "Clinician".
- **Training mismatch** when joining now says what to do (turn Training mode on or off at the top of Settings, then join again).
- **Start page**: "Patients already on this phone (N)" is a small button under the commander status instead of the biggest button; plainer subtitle and note (no "Ten Second Triage" / "MITT" jargon up front).
- **P1 Hold** set from the patient screen asks for confirmation and says whose name the decision is recorded under.
- **"How to use this"** card comes back when a different person sets up on the phone.
- **Commander screen**: "View only" label is amber and first in the header.
- **Messages**: a damaged or nonsense handover code says "That code isn't a valid handover… ask them to show it again" (the technical reason goes to the audit trail); a wrong or ended incident code gets one message, "No incident with that code. It may have ended, or the code may be mistyped." (the server cannot tell ended from never-existed, as ended incidents are deleted).
- Service worker cache v43.

### v0.19.4 build 2026-10-30-chrome-test — fixes from the Claude in Chrome practice test of v0.19.3 (Jake, 30 October 2026)
- **Join an incident** and **Show code, PIN and link** no longer open behind Settings (Settings closes, and every dialog now sits above Settings).
- **Reassess → ↓ Worsened** goes straight into the triage questions again for the same casualty (clinicians choose TST or MITT). Until the re-triage is done (or the category is changed), the reassessment shows as due now, not "OK 15m". Not breathing has no questions to repeat: a clinician sets the new category.
- A patient reopened from the Patient log leads with a big **⏱ Reassess** button; Next Patient steps back. The result header shows the latest triage time, with the first one in brackets after a re-triage.
- **🆘 Hold for help** sits in the header (always in view once linked, also in Simple mode), shortened to "🆘 Hold" on narrow phones.
- Commander screen: every browser pop-up (MITT prompt, P1 Hold, clearing a call for help, error messages) is now an in-app dialog, so the page keeps refreshing. The commander's own phone is labelled "Incident commander" and not counted as a clinician for prompts. After an incident ends, the last figures are greyed and labelled as not live.
- Plain words: "Not breathing (Needs clinician)" tally, "CLINICIAN NOW" instead of "HCP NOW", TST "Not sure?" lines say what the answer means, the penetrating question's instruction names stab and gunshot wounds to the chest, belly or back (question wording unchanged), police see "Simple yes/no questions" on START TRIAGE, "No, or not sure: carry on".
- **Hand over patients** sheet leads with "Show the QR to the person taking over"; file export, audit trail and other technical options moved under "More options".
- Training mode has its own line at the top of Settings. Leaving the demo with ↩ Start page now says "You are now in real use".
- The "Two quick questions" link prompt comes back whenever someone goes back to the start page to set up; the home "Not linked" reminder stays (smaller) after "No".
- The patient log no longer flags a Dead casualty as DETERIORATING.
- The app checks for a new version on every start and when it comes back to the front (at most every 5 minutes).
- Server: phones send `commander: true|false`; stored as `dev.commander`.
- Service worker cache v42.

### v0.19.3 build 2026-10-30-paramedic — a paramedic button on the start screen (Jake, 30 October 2026)
- "2. Who are you?" now has **🚑 Paramedic or ambulance medic** and **🩺 Doctor or nurse** side by side (both the clinician role), under **🚒 Police, fire or first aider**, with one line: clinicians start with Ten Second Triage and switch to MITT when the commander asks.
- Clinicians get their own first-use "How to use this" card: START TRIAGE starts with TST, tag the casualty, use the MITT button when the commander asks (their card offers "Switch to MITT" to make it the big button), and reassess from the Patient log.
- Service worker cache v41.

### v0.19.2 build 2026-10-30-walkthrough — simpler first run for first responders, faster big incidents (Jake, 30 October 2026)
- Start screen in plain words with numbered steps: "1. Your name or call sign", "2. Who are you?" with **🚒 Police, fire or first aider** first, then **🩺 Doctor, nurse or paramedic**. Starting as incident commander is a smaller dashed button ("Running the incident?"). "Options" is now "Extra settings — most people can skip this".
- After the role, one sheet asks two quick questions: **Where are you working?** (Inner cordon, Casualty clearing station, Loading point, Not sure yet; optional, one tap, audit `SECTOR_SET`) and **Has someone set up a commander screen?** ("Yes: scan their code", "Yes: type their code and PIN", "No, or not sure: start triage").
- The first time the home screen opens on a device, a "How to use this" card says: tap START TRIAGE, answer YES or NO, put the matching colour tag on (the app does not replace the paper tag). Tap it to hide it for good (not shown on the commander's phone).
- The offline pill just says "✓ Ready offline".
- Server: pushes read and write all records in one bulk Firestore call each (getAll / batched writes), repeated IDs in one push keep the newer copy, and closing an incident deletes in batches with the incident's main record last. Found by a live load test (25 phones, 1,000 casualties): reads took 6–8 s and closing took about 22 s.
- Service worker cache v40.

### v0.19.1 build 2026-10-29-under2 — under-2 rule in TST (G3), one name for the casualty clearing station (G7), voice notes training-only (G9) (Jake, 29 October 2026)
- The first TST question (Walking?) has a "👶 Child under 2? Tap for P1" button. It gives P1 with the reason "Child Under 2", following the NARU TST supplementary information ("any child under 2 should be automatically triaged as a P1"), which the printed TST card does not show. MITT already gives P1 to anyone aged 2 or under. Quick reference updated.
- G7: "casualty clearing station" is spelled out on every screen; "CCS" is kept only on small labels (map marker, filter buttons, summary chips). CCZ and CCP are gone from the app text. The sector preset and the demo/exercise phones use "Casualty clearing station"; older labels such as "Casualty Clearing", "CCS", "CCP" or "casualty clearing zone" are still recognised.
- G9: voice notes work in training mode only. In real use the 🎙 button is hidden and dictation is refused, so no recording about a real casualty goes to a browser maker's speech service. Privacy notice updated.
- Service worker cache v39.

### v0.19.0 build 2026-10-29-decisions — clinical decisions G2, G5 and G6 (Jake, 29 October 2026)
- **P1 Hold (G2):** hidden on every phone by default (not nationally signed off). The commander screen's new "Clinical decisions for this incident" card can allow it for the incident, recording who made the decision, and withdraw it. Clinicians' phones offer it only while it is allowed; records already in P1 Hold still show it. Audit: `P1_HOLD_ALLOWED` / `P1_HOLD_WITHDRAWN`.
- **TST reassessment (G5):** a casualty whose latest triage was TST (P1, P2 or P3) is due every 15 minutes (NARU TST supplementary information); MITT keeps P1 10, P2 30, P3 60 minutes (suggested timings, not from a published source). Settings → Reassessment timers has a TST row. Not Breathing is still due at once.
- **Switch to MITT (G6):** the commander can send a "MITT now in use" prompt to all clinicians, chosen sectors (for example Casualty Clearing) or every phone. A clinician's phone shows a card to switch its main button to MITT; a non-clinical phone is told to carry on with TST. Clinicians can also switch at any time in Settings → You → Main triage button. MITT stays clinicians-only. Audit: `MITT_PROMPT`, `MITT_PROMPT_ANSWERED`, `TOOL_MODE`.
- Server: phones send their sector and role with each report (shown in the commander's phones list); `POST /api/incident/<code>/policy` (full PIN only) with `{ p1Hold: { on, by } }` or `{ mitt: { groups } }`; `policy` and `policyAt` come back on every report and commander read. Client IP addresses are no longer written to the server log.
- G1 (role stays self-declared) and G4 (no "Talking?" hint) unchanged by decision. G3 (under-2 in TST) waits on a question. Service worker cache v38. Web change only: the Android app (a Trusted Web Activity) needs no rebuild.

### v0.18.0 build 2026-10-23-positions — triager positions (opt-in) and a call-for-help button
- Phones: a one-off question when linking to an incident, "Share your position with the commander?", off unless answered yes; a switch in Settings → Share live; the latest position (lat, lng, accuracy, time) goes with each report while on, and the server forgets it when turned off. Audit: `POSITION_SHARE_ON` / `POSITION_SHARE_OFF`.
- Phones: a 🆘 "Hold for help" button in the top bar while linked. Hold for 2 seconds (keyboard: Enter or Space, then confirm) to send an immediate report with a duress flag and the current position. Tap again to cancel. Audit: `DURESS_RAISED`, `DURESS_CLEARED` (by the phone or by the commander).
- Commander screen: a Teams layer on the map (👤 name and age per phone that shares, grey over 5 minutes old, red with 🆘 while calling for help), 📍 position age in the phones list, a red banner that stays until cleared with "Clear: help is on its way" (full PIN only; view-only cannot), a red alert with a longer alarm, and a "Show on map" button. The demo incident shows every phone's position.
- Server: `position` and `duress` on `PUT /records` (stored per phone; `null` removes), `duress` echoed in the reply so a phone learns when the commander cleared it, and `POST /api/incident/<code>/duress-clear`. Clinical rules unchanged.
- Privacy notice and accessibility statement updated. Service worker cache v36.

### v0.17.6 build 2026-10-21-london — review items 1 to 8
- Commander page script moved to `commander.js` with a strict content security policy; service worker, scanner, accessibility and server fixes from the review (PR #29).

### v0.17.5 build 2026-10-17-london — shared records now in London
- Live sharing on majorincident.netlify.app now keeps its records in Google Cloud Firestore, London (europe-west2): the live server reports `X-Incident-Store: firestore` (checked 17 October 2026). The privacy notice says so instead of "we are moving". Triage rules unchanged.

### v0.17.4 build 2026-10-17-reassess — reassessment for every role; data controller named
- Non-clinical users can record a reassessment check (Jake's decision, 17 October 2026); clinical-only actions unchanged. Triage rules unchanged.
- Privacy notice names West Midlands Evidence Based Emergency Medicine Ltd (company number 16644703) as data controller.

### v0.17.3 build 2026-10-16-review — full review fixes
Triage rules unchanged.
- Handover QR and all-patient transfer: `ccsAt` now has its own short key (`cca`); it used to share `ca` with `createdAt`, so a casualty handed over from the CCS arrived with the wrong creation time and every received casualty gained a CCS arrival time (wrong debrief and commander CCS timings). Older QR codes still decode.
- Patients saved while the device database was unavailable (backup browser storage) are brought back into the database on the next start instead of staying invisible (audit `FALLBACK_RECOVERED`).
- Commander screen: record ids are escaped in the alerts list and hospital names no longer build script in the capacity boxes (two cross-site scripting routes closed); `#CODE/wall` on a screen that is not signed in now shows the sign-in card and switches to wall mode after sign-in; a half-typed hospital capacity survives the 30-second poll; a link to another incident wins over this tab's saved sign-in; corrected the fallback wording in the "server unreachable" message.
- Printed-number reader (Tesseract) kept in its own cache so app updates no longer throw it away.
- "At CCS/loading area" quick action keeps the sector in step with the record; "Reviewed — mark resolved" no longer collapses the open sections; stray duplicate `style` attribute, dead code and a typo removed; live-sharing wording now says the call sign and notes are sent.
- Privacy notice: camera covers tag barcodes and the printed-number reader; new microphone/voice notes section. README contradictions on reassessment intervals and "no server" fixed. Android `versionName` brought into step with the app version.

### v0.17.2 build 2026-10-15-uk-hosting — live sharing can be kept in the UK
- The two server functions run in Netlify's London region (`region: 'lhr'`).
- New Firestore store (`netlify/lib/firestore-store.js`), used when the `FIRESTORE_*` settings are present, so the shared records can sit in Google Cloud europe-west2 (London). Netlify Blobs stays as the fallback. `X-Incident-Store` response header says which is in use. Triage rules unchanged.

### v0.17.1 build 2026-10-15-intended-purpose — one intended-purpose statement
- "Training and exercise use only. Not for use with real patients." on the start screen, footer, Settings › Help, commander page, quick reference, privacy notice, manifest and Play listing text.

### v0.17.0 build 2026-10-15-back-to-basics — back to basics phone layout
- Hand over and Receive on the home screen and Hand over on the result screen; patient details in a More panel; setup items moved into a grouped Settings screen; YES above NO with a double-tap guard. Triage rules unchanged.

### v0.16.0 build 2026-10-15-shared-picture — ideas from Pulsara, Peak Response and Chronosoft

Changes taken from a review of comparable products (Pulsara, Peak Response, KatApp, EMTrack, Chronosoft); the review is in the project files as `majorincident/competitor-review-2026-10-15.md`.

- **Pick up a patient another phone recorded.** When a linked phone scans a tag it does not have (📷 Receive patient, or Scan tag when starting a patient), it asks the commander server whether another phone in the same incident recorded that tag. A match (exact patient ID or triage card number only) opens the normal review-and-accept screen, marked as copied from the server; accepting adds the record with the same uid, so later changes from either phone merge as usual. No signal or no sharing: the app carries on as before. Audited as `SERVER_LOOKUP` and `SERVER_PICKUP`. New endpoint `POST /api/incident/<code>/lookup` (full PIN only; the view-only PIN is refused; at most 5 matches).
- **Shared map markings.** On the commander screen, *Mark the map for every phone* places an inner or outer cordon (circle with a radius), RVP, ambulance loading point, forward command post or hazard. Every linked phone receives them with its next report (within a minute) and shows them on its map; a toast says the map changed and the change is audited (`COMMANDER_MARKS`). Hidden on the wall display and for the view-only PIN. New endpoint `POST /api/incident/<code>/marks`; marks also come back in every push reply. In the commander demo, markings stay in the page.
- **Debrief timings.** Patient log → Records & exports → **⏱ Debrief timings** (this phone's records) and a **Debrief timings** card on the commander screen (every linked phone; also in the printed summary): first casualty, first P1, last new casualty, everyone sorted with MITT, first at the CCS, first and last living casualty to leave, and the median P1 time on scene. Worked out from the records (`MITTLib.debriefTimings`), so no audit trail has to leave the phone.
- **Rough count before triage.** On the METHANE screen, **🧮 Count** (next to Auto-Fill) opens a one-row tally (🚶 Walking, 🛌 Lying, Dead?, ↶ undo, → N) for the first crew on scene; it is folded away by default so the screen still fits without scrolling; → N writes "Rough count, not yet triaged: about N (walking, lying, apparently dead)" into N. Audited as `ROUGH_COUNT`; cleared with the incident.
- **Voice notes privacy.** Browsers turn speech into text with their maker's online service, so a voice note can leave the phone. In real use the 🎙 button now explains this once and asks before first use (`VOICE_NOTICE_ACCEPTED` in the audit trail), and it refuses with no connection. Training mode does not ask.

### v0.15.0 build 2026-10-15-tags-and-calmer-screens — tag and wristband scanning, clear and restart, calmer screens

- **Triage tag / wristband codes**: the app now links its record to the paper tag. Start screen → Options → Patient ID mode has a third choice, **Scan tag**: Start triage opens the camera, and the barcode or QR on the tag becomes the patient ID (a tag the phone already has offers a re-triage of that patient instead of a duplicate). The manual-ID box has a **📷 Scan** button, the patient screen's ID has a 📷 to rescan, and the **Triage card / tag number** field has its own 📷. **📷 Receive patient** (the home tile) now also accepts any plain code: a tag the phone knows opens that patient; an unknown one offers to start triage with it. Every read is audited (`TAG_SCANNED`). Codes are uppercased and limited to letters, digits, space, `. _ / -`.
- **Printed numbers** with no barcode: in the scanner, **🔤 No barcode? Read the printed number** photographs the central band and reads it with Tesseract.js **on the phone** (`vendor/tesseract/`, about 6 MB, fetched on first use and then cached; ⚙ Settings → About has *Store the printed-number reader* to fetch it in advance). It offers the numbers it found for the user to confirm against the wristband. Reads clean printed codes reliably in testing (see `tests/e2e.js`); handwriting is not supported. CSP gained `'wasm-unsafe-eval'` for the WebAssembly engine.
- **Clear everything and start again** (home → More, and ⚙ Settings → Incident & training): one step, no archive demanded. A real-use phone with records asks for `CLEAR` to be typed and reminds about the archive; training phones just confirm. Live sharing from that phone stops; name, role and settings stay; the wipe is still recorded (`DATA_WIPE`, `wipeHistory`). **Reset this phone completely** (⚙ Settings → About) deletes both databases, every setting, the cached app files and the service worker. *Close / Reset Incident* (archive first) is unchanged.
- **Calmer patient screen**: the category counts strip is hidden while a patient is open; one big **Next Patient**, then Handover / Re-triage / Reassess; *MITT this patient now* and the high-risk toggle share a row (clinicians, TST only); "tapped the wrong button" is a small link under the action line; ATMIST lives in the Handover section; *Change category* and *More* are one **Other** section. **Patient log**: the five large count cards are replaced by the normal strip showing on scene / total plus the Field / CCS / Evacuated line. The footer shows only the version and the save time (the build is in ⚙ Settings → About).
- The scanner's Paste button reads **Type it** in tag modes.

### v0.14.0 build 2026-10-15-commander-reliability — commander reliability, alerts, timeline, METHANE, hospital board, Google Play

- **Server** (`netlify/lib/incident-core.js`): the commander screen's "has anything changed" check is now a fingerprint of every stored record and phone (the blob etags), not a shared counter, so two phones sending at the same moment can no longer leave the screen a change behind. Records and phones are fetched in parallel batches of 25 instead of one at a time. The wrong-PIN lock-out is kept in storage (hashed address, 15 minutes) so it survives a cold start and is shared across server copies; the hourly sweep clears it. A new **view-only PIN** is created with every incident: it opens the commander screen but cannot join, send or end. Phones send their latest **METHANE** with every push; the newest one is returned to the commander screen. New `tests/load.test.js` (30 phones × 10 records pushed at once while the commander polls; full read of 300 records; run in CI) and five new backend tests.
- **Commander screen**: **alerts with a sound** (new P1 / P1 Hold / not breathing, a casualty whose category got worse, a tourniquet on for over an hour, a phone silent for 5 minutes; 🔔 button or S to mute), an **incident timeline** built from the records (triage, re-triage, interventions, CCS arrival, handover, evacuation; tap to open the casualty), a **METHANE** card, a **hospital board** (P1/P2/P3 sent to each hospital, vehicles, a typed-in agreed capacity that turns red when exceeded) and **🖨 Print summary** (P): counts, METHANE, hospitals, phones, every casualty and the timeline, for the incident log or the debrief. The server-unreachable banner now says what to do. View-only sessions are marked in the header.
- **Phones**: a **triage card / tag number** field on the patient screen (kept through QR handover and shown on the commander screen, CSV and print summary, so the app record and the card on the casualty carry the same number); a **battery warning** at 20 % and 10 % with a 🔋 pill in the header, and the level is sent to the commander screen, which flags phones at 10 % (Android Chrome only: iPhones do not expose battery level to web apps); evacuation records its time (`evacAt`); the live-sharing panel shows the view-only PIN and *Copy link and PIN* includes it; saving METHANE sends it to the commander at once; 🔒 Privacy notice in About & help.
- **Demo**: casualties found at or moved to the clearing station and loading point are marked *at CCS* with a time, evacuations carry a time and use the hospital names from the default list, so the demo exercises the field / CCS / evacuated split, the timeline and the hospital board.
- **Google Play**: `android/` holds a Trusted Web Activity wrapper (package `org.emevidence.mitriage`, target API 36, location delegation, no backup, launcher shortcut to the commander screen) built by the new `android` workflow; `.well-known/assetlinks.json` (fingerprints to fill in after Play App Signing); `privacy.html`; Play Console answers in `android/README.md`. The Android project has not been compiled or installed on a device yet.
- Facilitator guide updated for the new commander features and the server-down fallback.

### v0.13.1 build 2026-10-15-exercise — live-action exercise mode

- **🎯 Run a live exercise** in the ▶ Demo picker, for a real-people exercise with a control room, field triagers and a casualty clearing zone. Roles: 🎖 **Control room** (set up first: creates a practice incident and shows its code, PIN and QR, with *Open the commander screen*), 🩺 **Field triager (clinician)**, 🚒 **Field triager (non-clinical)** and 🏥 **CCZ** (sector Casualty Clearing, so everything it receives counts as at the CCS). Each phone starts in training mode with no casualties, asks for a name if none was typed, then offers to scan the control room's code. The orange bar shows the role ("EXERCISE — CCZ") with ↩ Start page.
- **📖 Facilitator guide** in the app: what to prepare, a two-minute set-up, who does what during the exercise, inject ideas, and how to finish and debrief.
- Starting a new demo or exercise unlinks the phone from the previous practice incident; the control room starts blank (no made-up METHANE or incident number).
### v0.13.0 build 2026-10-15-commander-wall — commander screen and wall display redesign

- **commander.html** restyled: a slimmer header with the incident name, code, incident number and how long it has been running as chips, a live status pill with a pulsing dot and "updated N s ago", a centred sign-in card with wide code and PIN boxes, cleaner count tiles, a "Needs attention" list as cards (colour bar by urgency, short ID such as "TST 006", the reason, the place and when it was last updated, with a green "Nothing outstanding" when the list is empty), phone tiles with a green or red dot, and a casualty table that highlights rows updated in the last 90 seconds.
- **Wall display** (button, the W key, or `commander.html#CODE/wall`) rebuilt for a TV in the command post: dark theme (less glare), everything sized in viewport units so a 1080p and a 4K screen both read from across the room, seven count tiles with very large numbers, a darkened map with bigger markers and no zoom buttons, the attention list and phones on the right, a category legend along the bottom, and a ⛶ **full screen** button (or the F key). The Refresh button is hidden on the wall (it refreshes itself every 30 seconds). 4:3 and tablet screens stack the map above the attention list.
- **Field / CCS / evacuated**: casualties are split into *in the field*, *at the casualty clearing station (CCS)* and *evacuated*. On the phone, the Handover section has **Mark as AT CCS**; the "At CCS/loading area" move button sets it too; a phone whose sector is "Casualty Clearing" marks every patient it creates or receives by QR as at the CCS. The commander shows a field / CCS / evacuated strip under the counts (each count tile also says "n field • n CCS"), a CCS tag on every row, a **Where casualties are** card (field by sector, CCS, evacuated by hospital) and On scene / Field / CCS / Evacuated / All filters on the table. Records from older phones fall back to the sector label (`patientStage` in lib.js). New record fields `atCcs` and `ccsAt` travel in handover QRs, bulk transfers and to the server.
- **Destination hospital**: marking a casualty evacuated opens a hospital chooser (editable list in ⚙ Settings → Incident & training, defaults to the West Midlands acute hospitals; any text is allowed, or "Not known yet"). The commander counts evacuated casualties by hospital and shows the hospital on each evacuated row.
- No change to the server code; it already stores the new fields.
- **Tap any casualty** on the commander screen (table row, needs-attention item or the map popup's "Full details") for everything the phone sent: the triage history (each TST sieve and MITT sort, who and when), reassessment status, interventions with times, injuries on a body outline, where they are with the full location history, CCS / evacuation / handover, notes, demographics and allergies, and who recorded it. "Show on map" jumps to their marker; Escape closes.
- **TST only vs MITT**: every row, attention item and marker says **MITT** (has had the sort) or **TST only** (sieve only, no MITT yet); a fourth box under the counts gives the number still awaiting MITT by category, and the table has a "TST only" filter.

### v0.12.2 build 2026-10-15-demo-flow — simpler demo and role flow

- **▶ Demo** is now one orange button at the top of the start screen. It opens **Demo: pick your role**: 🎖 Incident commander (opens the commander screen demo in the same window), one of the four phones, or everything on this phone. The live commander for several devices sits under "Practising with several devices?". No "are you sure" questions on the way in.
- **↩ Start page** replaces "Leave demo" in the orange bar, in the demo guide and on the commander screen demo. One tap goes straight back to the start screen in normal use (no question), where ▶ Demo picks another role. The commander demo's button opens `index.html#start`, which leaves the demo on that device if it was on.
- The guide's "Be someone else" and separate commander-screen buttons are gone; the start page is the one place to change role.

### v0.12.0 build 2026-10-15-demo-roles — demo roles and transfer practice

- **Try the demo incident** now asks **who you are**: everything on this device; one of the four phones (HART 1, Medic 2, MERIT doctor, Fire crew 3), which loads only that phone's casualties with its name, role, sector and ID prefix; the **commander screen** for this device only (`commander.html#DEMO`); or the **commander of a live practice**, which creates a training incident (needs internet) that other devices link to by scanning its code, so their demo casualties, handovers and new patients appear on the commander screen.
- **Transfer practice** in the demo guide: *Practise receiving a patient* (a casualty from another phone arrives as a real patient QR through the normal review-and-accept screen) and *Practise handing a patient over* (shows the real handover QR; the demo-only button "the receiver scanned it" sends back the confirmation a receiving phone would). With two devices, real QR handovers work as normal.
- **One screen, no scrolling** on a normal-size phone (checked at 412×915, 390×844 and 360×740): the start screen (no casualty counts there, shorter buttons), home, the triage questions, the patient screen (smaller tag, care prompts folded to one line, the six sections as a two-column grid of tiles; an opened section spans the width) and METHANE fit without scrolling. Large phones fit the patient screen down to the last section; the View Log button below may need a scroll on smaller phones. Gloved mode keeps its bigger targets. Section titles shortened to "Injuries & notes" and "Handover".
- **✕ Leave demo**: a black button in the orange DEMO banner at the top of every screen (and in the demo guide) leaves the demo in one tap, switches training mode off and goes straight back to the start screen with the real name and role. Practice records stay in the training database.
- Training mode now keeps its own name, role, sector and ID prefix (starting from the real-use values), so the demo's phone names never carry back into real use.

### v0.11.1 build 2026-10-15-location-help — "Location off" in the installed app

- An installed web app has no address bar, so the old "tap the padlock" instruction could not be followed, and an app installed from Firefox or Samsung Internet keeps *that* browser's permissions, not Chrome's. The location pill now shows **Location off** as soon as the permission is found to be off (not only after a failed fix), and tapping it gives numbered steps for the exact case: installed or in the browser, Chrome / Firefox / Samsung Internet on Android, Safari or Home Screen app on iPhone, including the phone's own app permission and the phone-wide location toggle. "Try again" re-checks the permission and says plainly if it is still off instead of pretending to search. Confirmed on a Firefox install on Android (15 Oct 2026): allowing location for the site in the Firefox browser itself is what fixes the installed app, so that step comes first.

### v0.11.0 build 2026-10-15-demo — demo incident for showing the app

- **Try the demo incident** (bottom of the start screen, or ⚙ Settings → Incident & training) switches to **training mode** and loads a made-up incident: a grandstand collapse at a fictional festival in Cannon Hill Park, Birmingham. 24 casualties recorded on four phones (HART 1, Medic 2, MERIT doctor, Fire crew 3) across every category (P1, P1 Hold, P2, P3, Not Breathing, Dead), with GPS positions, a CCS, interventions with times (tourniquets, TXA, chest seal, pelvic binder), body-map injuries, a re-triage that got worse, overdue reassessments, three evacuations and handovers, and a METHANE report. All times are relative to when the demo is opened.
- A **demo guide** (and an orange card on the home screen) jumps to the log, the map, a P1 patient and triaging a new casualty, and opens the **commander screen demo** (`commander.html#DEMO`, or `#DEMO/wall` for the wall display). That page builds the same incident itself, with no sign-in and no network traffic, and plays scripted events over the first few minutes (a casualty arrives, one deteriorates, the Not Breathing casualty is reassessed, ambulances leave).
- The demo only ever loads in training mode, so it lives in the separate training database; real records are untouched and come back when Training mode is unticked. Restarting the demo asks before replacing practice records. Live sharing from a demo phone, if started, creates a training incident on the server as before.
- Data: `MITTLib.buildDemoScenario({ now, elapsedMs })` and `MITTLib.isDemoRecord` in lib.js (fixed uids `demoNNNNkestrel`). Tests: 6 unit tests, 2 end-to-end tests.

### v0.10.0 build 2026-10-15-commander — incident commander dashboard (live sharing)

- **Start screen roles**: a third button, **"I'm the incident commander"**, creates the incident on the spot (needs signal once), shows the code, PIN and join QR, and offers **Open the commander screen**, which signs in by itself on that phone. Everyone else is asked, right after picking their role, **"Is there an incident commander?"** with *Scan the commander's code*, *Type the code and PIN* or *No commander / not now*; an unlinked phone also shows a tappable reminder on the home screen until it links or the question is dismissed for the session. Once linked, everything the phone records is sent in the background.
- **Share with commander** (⚙ Settings → Incident & training): one phone starts sharing and gets a 6-character incident code and a 6-digit PIN; other phones join by typing them or by scanning the join QR with 📷 Receive patient. From then on each phone sends its triage records in the background whenever it has signal (3 seconds after a change, plus a heartbeat every minute); nothing in the triage flow waits for the network, and a phone with no signal queues changes and sends them later. The blue bar shows a ☁ pill with the code and ✓ / … / ✗.
- **commander.html**: any browser, tablet or laptop. Code + PIN sign-in, counts by category (on scene and total), a map with clustered markers, accuracy circles and the CCS, a "needs attention" list (overdue reassessments, tourniquets with their time, high risk, breathing not detected), the casualty table priority-first with place, OS grid reference, interventions, reassessment due time and which phone reported it, a by-sector breakdown, phones reporting with "not heard from" after 5 minutes, and GPX / KML / GeoJSON / CSV downloads. Refreshes every 30 seconds (cheap when nothing changed). **Wall display** (button, the W key, or `commander.html#CODE/wall`) fits the counts, map, needs-attention list and phones on one screen with large type for a screen in the command post.
- **Backend**: a Netlify Function (`netlify/functions/incident.mjs`, logic in `netlify/lib/incident-core.js`) with Netlify Blobs (Firestore London from v0.17.2, see UK hosting above). What leaves the phone is the same minimised record as the QR transfer (no names or NHS numbers; field caps enforced again server-side). Code and PIN are both needed for every request (PIN hashed with a salt, constant-time compare, 25 wrong PINs lock a client out for 15 minutes), an older copy of a record never overwrites a newer one, the server copy is deleted 24 hours after the last update (on access and by an hourly sweep), and the phone that started can "End incident for everyone" to delete it at once. Every start / join / push / failure / stop is in the phone's audit chain; the function logs create / read / close events.
- **Training mode** incidents are marked as such on the commander screen, and a training phone cannot join a real incident (or the reverse).
- 15 backend unit tests (`node tests/incident-core.test.js`) and 13 new end-to-end tests that run the real function code in-process behind the test web server.

### v0.9.0 build 2026-10-15-location-map — location, map and phone layout

- **Location engine:** two position watches (satellite and coarse) plus a 20-second heartbeat, so a phone standing still indoors keeps a current position instead of "GPS unavailable". A position is reused for up to 2 minutes. The blue-bar pill now says what the phone knows (e.g. "±8 m", "±60 m Wi-Fi", "Location off") and tapping it explains the state in plain English, with the iPhone / Android steps to allow location and a Try again button.
- **Indoor fallbacks:** "Pin on map" (tap exactly where the patient is; stored as manually corrected), "Same place as last patient", and the floor / room fields. Rough fixes are labelled as such.
- **OS grid references:** every position is also shown as an Ordnance Survey grid reference (e.g. SJ 83997 98258) for radio and control-room use. The conversion follows the OS transformation (Helmert WGS84→OSGB36, Airy 1830), checked against the OS worked example; accuracy is a few metres, which is fine for this purpose.
- **Map screen:** reachable from the home screen. Clustered colour-coded markers with accuracy circles, your own position, an On scene / All switch, a legend, a nearest-first casualty list with distance and bearing, and Set CCS. Tapping a marker offers Open record, Move pin and walking directions. Map tiles seen while online are cached for offline use.
- **Open in Google Maps / other apps:** one casualty opens as a pin in Google Maps, Apple Maps, OpenStreetMap or the phone's default maps app, or as walking directions. Several casualties open as a Google Maps walking route through the nearest 10 (Google cannot show plain pins from a link), or save as a GPX, KML or GeoJSON file for OsmAnd, Organic Maps, Google Earth / My Maps, Garmin or control-room GIS. "Copy list" copies ID, category, grid reference and coordinates for every casualty.
- **METHANE:** "Add my position" fills the exact-location line with the grid reference and coordinates.
- **ATMIST:** Copy text and Share… (phone share sheet) buttons.
- **Calmer result screen:** detail sections start closed for each new patient; location moves (found here, moved, at CCS, loaded) are folded away; the Log screen's exports and reset are under one heading; Settings is grouped into Display, Incident & training, Reassessment and About.
- **Phones:** the status bar wraps instead of pushing the location pill off-screen; the user name is hidden on narrow screens; map chips fit a 360 px screen. 20 new unit tests and 11 new end-to-end tests cover the above.

### v0.8.1 build 2026-10-14-usability — usability review

- **YES / NO always on screen:** the answer buttons are pinned to the bottom of the question screen, side by side, with Back / Cancel under them. Previously NO was below the bottom of the screen on every question on iPhone SE-sized and common Android phones. The counters are hidden while a question is showing. A test checks every TST and MITT question at 375×667 and 360×740.
- **Question first:** the question card comes first, with the instruction under it in plain text, then the "Not sure?" hint.
- **Header on one row:** Night mode and Blackout moved into ⚙ Settings with labels (Blackout shows "Tap to wake").
- **MITT counting help:** on the breathing-rate and heart-rate questions, a 15-second timer with an optional tap counter, or a typed rate. It suggests YES or NO; the clinician still answers. Measured rates are added to the result's action text (e.g. "Measured: RR 28/min").
- **MITT this patient now:** clinicians get a one-tap button on any TST result to run MITT on the same record, and TST results remind clinicians to reassess with MITT as soon as possible.
- **Handover:** the "Handover details look thin" confirmation now appears only for a clinician's MITT patient, not for every TST handover.
- **Non-clinical role:** ATMIST, thoracostomy, TXA and IO access buttons are hidden for non-clinical users. Reassess is available to every role (a non-clinical responder records the check and is told to ask a clinician if the category needs changing).
- **Readability:** the role is shown as a white-on-colour pill before the user name; the counters show patients still on scene with a one-line legend (totals remain in the Patient log).
- **Result screen:** Next Patient and QR Handover sit directly under the category; MITT P3 result reminds that walking patients may be compensating.
- **Quick reference card:** now includes the TST and MITT flowcharts.

### v0.8.0 build 2026-09-27-first-use — usable in seconds by a first-time user

- **Start screen:** only a name and a tap on a role are needed. The incident code, sector and patient-ID settings are under "Options".
- **Home screen:** one large **START TRIAGE** (TST) button, then MITT (clinicians only), **Receive patient** and **Patient log**. Everything else is under "More".
- **Questions:** each shows "Question N of up to 4" (TST) or "…of up to 7" (MITT), plus a "Not sure?" hint that always points to the answer giving the more urgent priority. A test checks this for every question. The hint wording needs clinical sign-off along with the questions.
- **Training mode** (⚙ Settings): a separate practice log in its own database, with its own counters and backup storage. It shows an orange banner, and patient IDs start `TRAIN-`. Export file names start `MITT_TRAINING_`, and training QR codes are marked inside the integrity hash. A real-mode phone refuses training codes and a training phone refuses real ones. Switching mode in either direction is recorded in the real audit trail. "Delete all training data" clears only practice records.
- **Incident code:** typed once per phone (start screen Options or Settings). It is stamped on every new record, shown in the status bar, included in transfers, the casualty register (`Incident_Code`), the archive and export file names. Receiving a patient from a different incident shows a warning.
- **Ready offline:** the status bar shows "✓ Ready offline" only once the offline worker confirms every file the app needs is stored on the phone. On Android, an **Install** button appears when the browser offers installation.
- **Guided handover:** the sender's QR, the receiver's confirmation code and the sender's final screen each show numbered steps (1–3) and what to tap next.
- **Quick reference card** (`quick-reference.html`, linked from Settings, works offline): one printable A4 page for the kit bag.

### v0.8.0 build 2026-09-26-full-check — full line-by-line check

- Handover: scanning the same ACK twice no longer reports "receiver has an older version"; the check now compares the record's clinical content, not its last-changed time.
- Handover: allergies, notes and other text are no longer cut on the receiving phone (previously allergies over 300 and notes over 4,000 characters were silently shortened). Input boxes now have limits below what a receiver keeps, and anything over the limit is shown as a warning instead of being dropped silently.
- Exports: negative numbers (longitudes west of Greenwich) are no longer turned into text in the CSV files.
- Deterioration: any change to Dead, and P1 Hold to Not Breathing, is now flagged as deterioration.
- Paste box opened from the scanner now appears on top of it; dialogs taller than the screen can be scrolled to the top; dashboard counters stay on one line on phones.
- Reset also removes any copy of patients kept in backup browser storage.
- iPhone: transfer files open the share sheet straight from the tap.
- Android: a proper "maskable" home-screen icon, so the round icon mask no longer crops the artwork.

### v0.8.0 — safety review (handover, data integrity, audit, clinical alignment)

- **Data loss fixed:** IDs could be reused (leaving via Home), hiding the earlier patient from the log/dashboard/exports; editing the ID on the question screen renamed the previous patient; re-triage created a blank duplicate hiding interventions/allergies; the "time of event" offset silently back-dated all later records; typed destination/vehicle could be lost; background field saves overwrote imported data and handover notes.
- **Handover fixed:** any non-ASCII character (including the app's own emoji buttons, accents, £) broke the QR (vendored library byte bug fixed and all QR text made ASCII); location history grew on every field visit until the QR was too big; receivers ignored newer urgent categories because merge used edit counts; categories could be silently downgraded; notes nested on each round trip; different patients with the same ID were merged; duplicate warnings fired for almost every casualty; ACKs were unverifiable; transfers of real incidents needed hundreds of QR codes; files older than 8 hours could not be imported.
- QR codes are drawn with whole-pixel modules and a quiet zone; the output is verified identical to a reference encoder.
- **Audit:** hash-chained, complete field-level history, ISO timestamps with offset, device IDs, imported rows separated, archive export, safe reset.
- **Clinical:** TST "Not Breathing" and MITT "Dead" per NHSE labelling; "Expectant" removed; P1 Hold added; MITT heart-rate question worded as the card; scene-appropriate care prompts; time of death optional.
- **Ergonomics:** back button never exits; log search/filter and alerts; "Change last answer"; confirmation to remove an intervention; blocking dialogs for failures; no layout overflow on phones; first install no longer reloads the page; stale GPS fixes are not stamped on patients.

### v0.7.0 — GPS/location accuracy

- High-accuracy GPS watch with short best-fix selection by lowest accuracy, live acquisition status, poor-accuracy warning and graceful fallback when GPS fails.
- Mobile-first patient location editor with operational labels, confidence, editable coordinates/accuracy, current-GPS use, quick movement actions and copyable lat/lon.
- `initialLocation`, `currentLocation` and `locationHistory` preserved across patient QR, bulk QR, all-patient QR/chunks, transfer files, merges, CSV and audit exports.
- Duplicate matching now considers coordinate proximity from current locations and operational label overlap when coordinates are absent.
- Offline map fallback message documents that map tiles may be unavailable while stored coordinates remain usable.

### v0.6.0 — all-patient offline handover

- Prominent home/log controls for **Sender: Transfer all patients** and **Receiver: Receive all patients**.
- Full `MIT_ALL` payload includes every stored patient field, audit context and schema/app metadata.
- Multi-QR `MIT_ALL_CHUNK` batching with manual navigation, progress, duplicate chunk handling, missing chunk display, chunk and overall integrity checks, and receiver preview before import.
- Offline transfer file export/import and Web Share fallback for local device transfer; Web NFC exposed honestly only where supported and small enough; browser Bluetooth peer-to-peer is documented as unsupported.
- Non-destructive all-patient merge path with duplicate warnings and audit events for transfer lifecycle actions.

### v0.5.0 — second enhancement pass

- **Guided two-way handover.** After a sender shows a patient QR and the receiver accepts, the sender sees a `Step 1 / Step 2 / Step 3` flow that explicitly waits for the receiver's ACK QR, then renders a "Handover Accepted" confirmation. Each patient now carries `handoverState` (`pending` / `accepted`) which is surfaced as a pill in the log.
- **Structured body-map injuries.** Marks are stored as `{region, side, x, y, label, severity, time, ts}` with normalised coordinates so they survive re-render, export, QR handover, import and merges. Free-text notes are still appended for backwards compatibility. Helpers: `buildInjuryMark`, `injuriesToText`, `sanitiseInjuries` in `lib.js`.
- **Bulk sector handover.** `MIT_BULK` QR type compresses an entire sector's patients into one payload. Receiver gets a preview of every patient, with duplicate hints, before accepting. Oversize batches detected via `bulkPayloadFits` and fall back to CSV export with audit. Helpers: `buildBulkPayload`, `validateBulkWrapper`.
- **Better patient identity matching.** `similarityScore` and `findDuplicateCandidates` weigh demographics, sector, category, time and GPS proximity. The receiver preview now warns about possible duplicates with different IDs and lets the operator choose: keep separate, merge into a selected existing record, or cancel. Never silent.
- **Service-worker update UX.** A new SW version no longer auto-activates mid-incident. Users see an in-app banner — "A new version of MITT is ready: Reload Now / Later" — and can apply it explicitly. Falls back to manual reload if `postMessage` is unavailable.
- **Triage reassessment workflow.** P1/P2/P3 patients have intervals (10/30/60 min, suggested timings). Pills on the result screen and log show `OK Xm` / `Due Xm` / `OVERDUE Xm`. The reassess modal records `improved` / `unchanged` / `worsened` and resets the next-due timer. Helpers: `reassessmentStatus`, `applyReassessment`.
- **Deterioration alerts.** Category worsening (e.g. P2 → P1) is auto-detected, audit-logged as `DETERIORATION`, and surfaced as a flag in the log. `categoryWorsened` is tested.
- **Treatment timeline.** Per-patient chronological view that combines triage, interventions, body-map injuries, reassessments, evac, handover, voice notes and audit events. Helper: `buildPatientTimeline`.
- **Gloved-use mode.** Toggle in `⚙ Modes` enlarges all controls, increases contrast, and uses thicker borders. Persists across sessions.
- **Panic / simple mode.** Hides MITT, dashboards, secondary buttons, footer and status bar so the fastest TST path is one tap away.
- **One-handed mode.** Sticky bottom action bar with `Triage / Scan / Log` always in thumb reach. Adapts to result screen (becomes `Next Patient`).
- **QR label / print support.** Result screen has a `🖨 Print Label` action that produces a wristband-style printable card with category chip, ID, QR, short transfer code (Crockford base32), demographics and generation timestamp.
- **Voice note transcription.** Web Speech API with a clear "Listening…" prompt; transcripts get a `[Voice HH:MM]` tag, are appended to notes and audit-logged. Falls back gracefully when unsupported.
- **Better no-camera workflow.** Existing paste-code modal kept; printed wristbands now include a 6-character transfer code generated from the FNV integrity hash.
- **Dark/night mode refinements.** Reworked palette: brighter blues, less black-on-black, refined modal contrast, accent buttons readable on glare.

### Existing safety baseline (preserved)

- P0 safety: receiver preview/accept; non-destructive duplicate merge; expiry/versioning; integrity hash; sanitised DOM rendering everywhere.
- P0 reliability: scanner Cancel always closes; modal z-index hierarchy; camera-toggle and paste-code fallback; scan debounce.
- P1 UX: larger QR with brightness/full-screen prompt; sender summary and expiry countdown; ACK QR with correct receiver identity; in-app confirm/prompt replacing native dialogs.
- Security: CSP via meta + `_headers`; CDN scripts vendored locally; `user-scalable=no` removed; `aria-live` regions for status and alerts.
- Reduced motion respected; modals support Escape and back-button to close.

## Limitations / deferred

- Very large casualty logs can require many QR chunks; use the transfer-file fallback if camera scanning becomes operationally slow.
- Voice transcription uses on-device Web Speech APIs where supported (most Chromium-based mobile browsers + Safari iOS 14.5+). On unsupported browsers the user is told to type instead.
- Print labels rely on the OS print dialog (`window.print()`); AirPrint and most label printers work, but exotic networked label printers may need a dedicated driver.
