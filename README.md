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

## Patient QR schema (v3)

Generated when a sender taps **QR Handover**. Encoded as JSON:

```json
{
  "t": "MIT_P",
  "v": 3,
  "rv": 3,                       // recordVersion (incremented on each save)
  "g": 1715200000000,            // generatedAt (epoch ms)
  "x": 1715228800000,            // expiresAt   (default: 8 hours from generation)
  "sndr": "Medic 1",
  "app": "0.7.0",
  "h": "1f2a3b4c",               // FNV-1a integrity hash over canonicalised payload
  "d": {
    "i": "TST-001", "c": "P1", "a": "Immediate", "r": "Catastrophic Bleeding",
    "tr": "Medic 1", "tm": "12:34", "ts": 1715199999000, "tl": "TST",
    "s": "Inner Cordon", "d": "35M", "al": "Penicillin", "n": "Bleeding right leg",
    "hr": 1, "in": { "Tourniquet": { "time": "12:35", "ts": 1715200060000 } },
    "ev": 0, "ed": "Royal Infirmary", "evv": "AMB-404",
    "l": { "lt": "53.4808000", "lg": "-2.2426000", "ac": 8, "ts": 1715200000000, "so": "gps-watch", "cf": "gps-exact", "sc": "Inner Cordon" },
    "il": { "lt": "53.4807900", "lg": "-2.2426100", "ac": 18, "ts": 1715199999000, "so": "gps-watch" },
    "lh": [{ "lt": "53.4808000", "lg": "-2.2426000", "ac": 8, "at": 1715200000000, "usr": "Medic 1", "rs": "initial capture" }],
    "lc": "gps-exact", "lm": "Bus stop", "fl": "Ground", "ar": "Bay 2"
  }
}
```

- **Versioning:** `v` is the schema version, `rv` increments per save so the receiver can detect newer updates.
- **Expiry:** Receivers reject QRs where `x < now()` and surface a clear error. Default TTL is 8 hours.
- **Integrity:** `h` is an FNV-1a 32-bit hash over the canonical (key-sorted) payload without `h`. Tampering or corruption flags `integrityOk: false` on the preview screen.

Receiver flow: every scanned patient QR opens a **preview/accept** modal showing category, ID, reason, action, interventions, high-risk flag, location/accuracy/history, sender, generated time, expiry countdown and integrity status. Accept is required before merging into the local log.

### Other QR types

| Type | Purpose |
|---|---|
| `MIT_USER` (JSON `{t, v, name, role, g, app}`) | Identity card for bulk handover. Legacy `MIT_USER\|name\|role` pipe format still parsed. |
| `MIT_ACK` (JSON `{t, v, pid, rcv, g, app}`) | Acknowledgement returned by the receiver after accept; sender can scan to log handover-accepted. |
| `MIT_PT\|...` (legacy) | Old pipe-delimited patient export still accepted via the same preview/accept flow. |

## Location accuracy workflow (v0.7.0)

MITT now treats patient location as an operational field that can be confirmed and corrected, not as a hidden GPS overwrite. The browser geolocation watch runs with high accuracy, zero maximum age and a 12-second timeout. During acquisition the app keeps a short buffer of fixes and stores the best fix by lowest reported accuracy.

Stored location metadata includes latitude, longitude, horizontal accuracy, altitude, altitude accuracy, heading, speed, timestamp, source, age, initial location, current location, and a full location history. Operational labels are stored alongside GPS: sector/zone, landmark or treatment area, floor/level, area/bay/room/entrance, and confidence (`gps-exact`, `gps-approximate`, `manual-corrected`, `sector-only`, `unknown`).

The result screen shows live status such as `Getting fix ±45m` or `Good fix ±8m`. Accuracy poorer than 25m is highlighted and nudges the triager to confirm a sector/landmark or manually correct coordinates. GPS failure never blocks triage; users can continue with sector-only or unknown location.

### Manual correction

Open **Confirm / edit patient location** from the result screen or patient details. The mobile-first editor supports:

- sector/zone, landmark/treatment area, floor/level and area/bay/room/entrance;
- confidence selection: GPS exact, GPS approximate, manually corrected, sector only, or unknown;
- editable latitude/longitude and accuracy radius;
- **Use current GPS**, **Found here**, **Moved to sector/area**, **At CCS/loading area**, and **Loaded/evacuated** quick actions;
- copyable latitude/longitude for map-free handover.

Every location change appends to `locationHistory` with timestamp, triager/user, source, action/reason, coordinates/accuracy and operational labels. The patient timeline and audit log include location update events.

### Offline map-free fallback

The map is optional. If map imagery tiles are unavailable offline, MITT still displays the coordinate/accuracy card, age warning, operational labels, manual editor, and copyable/transferable lat/lon. Coordinates and location history are kept in IndexedDB and included in QR, transfer files, CSV and audit exports.

### Coordinate-format limitation

OS Grid Reference and What3Words are intentionally not included in this release. What3Words requires an online/proprietary service, and OS-grid conversion would add a new coordinate dependency; core incident location features must remain offline and low-risk.

## All-patient offline handover (v0.6.0)

A prominent **Sender: Transfer all patients** button is available from the home screen and patient log. The receiver has a separate **Receiver: Receive all patients** path, plus **Import transfer file**.

Before sending, MITT shows an incident-use preflight summary:

- patient count and P1/P2/P3/DEAD counts;
- sectors included;
- whether GPS/position/location data and triager identities are present;
- interventions, structured injuries, notes, allergies, demographics, reassessment, deterioration and handover state coverage;
- transfer method options and fallback plan.

### `MIT_ALL` payload

All-patient transfer uses a typed JSON wrapper with the full local log, not a compressed summary:

```json
{
  "t": "MIT_ALL",
  "v": 1,
  "sv": 3,
  "g": 1715200000000,
  "x": 1715228800000,
  "transferId": "abcdef12",
  "sndr": "Incident Commander",
  "app": "0.7.0",
  "n": 42,
  "patientFields": ["id", "time", "timestamp", "tool", "category", "action", "reason", "triager", "location", "initialLocation", "currentLocation", "locationHistory", "locationConfidence", "sector", "landmark", "floor", "area", "demos", "allergies", "notes", "highRisk", "interventions", "evacuated", "evacDest", "evacVehicle", "injuries", "lastReassessed", "reassessOutcome", "lastDeteriorationAt", "handoverState", "handoverAt", "handoverTo", "_rev"],
  "patients": [],
  "audit": [],
  "incident": {},
  "h": "1f2a3b4c"
}
```

The receiver validates expiry and the full-payload integrity hash before preview/import. Existing local records are never deleted. Exact ID matches are merged with the existing safe merge helper so local interventions are retained; likely duplicates with different IDs are warned about and kept separate unless an operator deliberately merges through the existing duplicate flow.

### Multi-QR chunk protocol

If the all-patient JSON does not fit in one dependable QR, MITT emits numbered `MIT_ALL_CHUNK` QR codes:

```json
{
  "t": "MIT_ALL_CHUNK",
  "v": 1,
  "transferId": "abcdef12",
  "totalChunks": 8,
  "chunkIndex": 0,
  "g": 1715200000000,
  "x": 1715228800000,
  "sndr": "Incident Commander",
  "app": "0.7.0",
  "payloadHash": "1f2a3b4c",
  "chunkHash": "9a8b7c6d",
  "data": "...string slice...",
  "h": "11223344"
}
```

Operational behaviour:

- Sender sees a large QR, chunk `n / total`, transfer ID, overall checksum and manual **Previous / Next** controls. There is no auto-advance.
- Receiver may scan chunks out of order. Duplicate chunks are recognised and ignored.
- Receiver progress shows scanned/missing chunk numbers and only opens the final preview once all chunks validate and the reassembled payload checksum matches.
- The receive flow can be resumed while the app remains open by continuing to scan missing chunk numbers; **Cancel** deliberately clears the in-progress chunk store.

### Offline alternatives and platform limitations

- **Transfer file:** export/import a `.json` file containing the same `MIT_ALL` payload. This is the most robust fallback when cameras struggle.
- **Web Share API:** where available, MITT can hand the transfer file to the OS share sheet for AirDrop, Nearby Share, USB/file managers, or other local options. Internet is not required by MITT, though chosen share targets may have their own policies.
- **Web NFC:** MITT can write the transfer text on supported Android Chrome over HTTPS for small payloads/tags. iPhone Safari and most desktop browsers do not expose Web NFC. Large casualty logs should use QR chunks or the transfer file.
- **Bluetooth:** browsers do not provide reliable direct phone-to-phone Bluetooth file transfer for this use case, so MITT does not present fake Bluetooth support.

All all-patient transfer actions add audit events where feasible: preflight, transfer generated, chunk shown, chunk scanned/duplicate/rejected/complete, file export/import, share attempt/result, NFC attempt/result, accept/decline/import.

## Manual two-phone incident handover QA checklist

1. On phone A, load MITT once online, then enable airplane mode and confirm the app still opens.
2. Create at least three patients: one P1 with GPS/sector/triager, intervention and body-map injury; one P2 with reassessment/deterioration; one P3 with demographics/allergies/notes.
3. Confirm/edit each patient location: one accurate GPS fix, one poor GPS with manual sector/landmark correction, and one sector-only indoor casualty. Check the location-age warning and timeline entry.
4. Open **Sender: Transfer all patients** from the home screen or patient log and verify the preflight summary counts, sectors, GPS/position inclusion, location labels/history and triager identity inclusion.
5. Start QR transfer. If multiple chunks appear, scan them on phone B from **Receiver: Receive all patients** out of order; scan one chunk twice and verify the duplicate message; leave one chunk missing and verify the missing number is displayed.
6. Scan the final missing chunk and verify the "all chunks received and verified" message plus final preview before import.
7. Accept the transfer on phone B and verify no local patients were deleted, exact matches merged safely, likely duplicates were warned about, and positions/GPS metadata, location labels/history, triagers, interventions, injuries, notes, allergies/demographics, reassessment and handover state persisted.
8. Disable network and open the map screen; verify the offline map message appears if tiles cannot load, while coordinate cards and manual location edits still work.
9. Repeat using **Export transfer file** on phone A and **Import transfer file** on phone B while offline.
10. On supported Android Chrome/HTTPS only, try Web NFC with a very small test log; confirm unsupported or oversize devices show clear QR/file fallback guidance.
11. Export the audit trail and casualty register and confirm location-update and all-patient transfer events are present.

## Privacy posture

- **No names, DOB, or NHS numbers are stored by default.** The free-text demographics field accepts anything the user types; teams should set local guidance accordingly.
- All patient data lives in **IndexedDB on the device** (no server). Wipe with **Reset Incident** — auto-exports a snapshot CSV and forensic audit CSV before deletion.
- Offline-first: no analytics, no third-party requests at runtime apart from OpenStreetMap tile fetches when the map view is opened.

## Audit log

Every clinically meaningful event records an audit entry: triage complete, intervention added/removed, location update, evacuation, handover, ID change, QR generated, QR accepted/declined, expired QR rejected, duplicate merge, ACK generated, data wipe. Export via **Forensic Audit Trail (CSV)**.

## Running tests

```bash
node tests/lib.test.js
```

CI runs the same tests on every push (see `.github/workflows/test.yml`).

## Intended-use limitations

- The app is a **prototype** and has not been clinically certified. Do not deploy in live operations without local sign-off, training, and integration with primary triage tags.
- QR transfers are **best-effort**: always also tag the patient physically.
- The service worker aggressively caches; force-refresh after deployments to pick up updates.
- Camera/geolocation/NFC require HTTPS in production browsers. GPS can be poor indoors, underground, near tall buildings, or in dense crowds; always confirm sector/landmark/floor/area when accuracy is degraded.

## Contributing / change log

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
