# Major Incident Triage Tool (MITT)

A mobile-first, offline-first **progressive web app** for documenting major-incident triage and handover. Built as a single-page vanilla JavaScript app — no build step.

> ⚠️ **Clinical safety caveat.** MITT is a *workflow aid*, not a medical device. It does not make clinical decisions. Triage outcomes, interventions and any data exchanged via this app must always be verified against the patient at the point of care. Use only in environments where local clinical-governance approval is in place.

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
index.html        Single-page app — UI, triage flows, scanner, log, map
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
- Categories follow NHS England casualty labelling: P1, P2, P3, **Not Breathing (TST only, silver)**, **Dead (MITT only, black)**. **P1 Hold** is available to clinicians as a senior decision. "Expectant" is not used.
- Not Breathing casualties are flagged for **healthcare reassessment as soon as possible** (NARU). Dead does not require a time of death at triage ("declare when resources allow", NHSE B0128).
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
**Send patients to another device** → choose scope → **Show QR code(s)**. Codes are compressed and split into parts of ≤ 800 characters. The receiver's camera **stays on**; parts can be scanned in any order, repeats are ignored, progress survives an app restart, and a code from a different transfer asks before discarding progress. The sender can auto-cycle parts. After import the receiver shows a **confirmation QR** (MIT_TACK) that the sender scans. Measured sizes (realistic records, audit not included): 10 patients 5 parts, 50 patients 12 parts, 100 patients 21 parts. Compression relies on the browser's CompressionStream; where it is missing, transfers still work but need more parts.

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
5. On A, **Send patients to another device** → All patients → Show QR codes. On B, **Receive (scan)** and hold the camera on the cycling codes; confirm progress, then accept and scan B's confirmation on A.
6. Repeat with **Export transfer file** on A and **Import transfer file** on B.
7. Press the Android back button on several screens; the app should never close.
8. Log → **Verify audit trail**, then export the Casualty Register, Audit Trail and Full Incident Archive and open them on a computer.
9. Record the scan distance, lighting and number of attempts; scanning performance varies by phone camera and screen.

## Privacy posture

- **No names, DOB, or NHS numbers are stored by default.** The free-text demographics field accepts anything the user types; teams should set local guidance accordingly.
- All patient data lives in **IndexedDB on the device** (no server). **Close / Reset Incident** requires an archive first (see Audit trail). Transfer and archive files contain patient data: handle them under your local information-governance rules.
- Offline-first: no analytics, no third-party requests at runtime apart from OpenStreetMap tile fetches when the map view is opened.

## Running tests

```bash
node tests/lib.test.js          # logic: merge, IDs, transfer, audit chain, triage flows (no dependencies)
node tests/syntax-compat.js     # fails on JavaScript syntax too new for older iPhones (needs npm install)
npm install && node tests/e2e.js # real app in headless Chromium, simulating two phones
```

The end-to-end suite covers the two-phone handover, multi-part transfer, reload persistence, audit tamper detection, legacy migration, storage failure, reset, iPhone behaviour (old-iOS decompression, share-sheet export, notch layout, no zoom-on-tap, database reconnection), and checks the app's QR codes against a reference encoder. CI runs both on every push (see `.github/workflows/test.yml`).

## Intended-use limitations

- The app is a **prototype** and has not been clinically certified. Do not deploy in live operations without local sign-off, training, and integration with primary triage tags.
- QR transfers are **best-effort**: always also tag the patient physically.
- The service worker aggressively caches; force-refresh after deployments to pick up updates.
- Camera/geolocation/NFC require HTTPS in production browsers. GPS can be poor indoors, underground, near tall buildings, or in dense crowds; always confirm sector/landmark/floor/area when accuracy is degraded.

## Contributing / change log

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
- **Triage reassessment workflow.** P1/P2/P3 patients have intervals (10/30/60 min). Pills on the result screen and log show `OK Xm` / `Due Xm` / `OVERDUE Xm`. The reassess modal records `improved` / `unchanged` / `worsened` and resets the next-due timer. Helpers: `reassessmentStatus`, `applyReassessment`.
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
- Reassessment intervals are hard-coded defaults (P1=10m, P2=30m, P3=60m). Per-incident overrides are not yet exposed.
