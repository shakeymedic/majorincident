# Major Incident Triage Tool (MITT)

A mobile-first, offline-first **progressive web app** for documenting major-incident triage and handover. Built as a single-page vanilla JavaScript app — no build step.

> ⚠️ **Clinical safety caveat.** MITT is a *workflow aid*, not a medical device. It does not make clinical decisions. Triage outcomes, interventions and any data exchanged via this app must always be verified against the patient at the point of care. Use only in environments where local clinical-governance approval is in place.

## Purpose

- Run **TST (Ten-Second Triage)** and **MITT** triage flows on a phone or tablet.
- Record interventions, demographics, allergies, notes, sector, evacuation status.
- **Hand over patient data** to another responder via QR code or NFC.
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

## Patient QR schema (v2)

Generated when a sender taps **QR Handover**. Encoded as JSON:

```json
{
  "t": "MIT_P",
  "v": 2,
  "rv": 3,                       // recordVersion (incremented on each save)
  "g": 1715200000000,            // generatedAt (epoch ms)
  "x": 1715228800000,            // expiresAt   (default: 8 hours from generation)
  "sndr": "Medic 1",
  "app": "0.4.0",
  "h": "1f2a3b4c",               // FNV-1a integrity hash over canonicalised payload
  "d": {
    "i": "TST-001", "c": "P1", "a": "Immediate", "r": "Catastrophic Bleeding",
    "tr": "Medic 1", "tm": "12:34", "ts": 1715199999000, "tl": "TST",
    "s": "Inner Cordon", "d": "35M", "al": "Penicillin", "n": "Bleeding right leg",
    "hr": 1, "in": { "Tourniquet": { "time": "12:35", "ts": 1715200060000 } },
    "ev": 0, "ed": "Royal Infirmary", "evv": "AMB-404",
    "l": { "lt": "53.4808", "lg": "-2.2426" }
  }
}
```

- **Versioning:** `v` is the schema version, `rv` increments per save so the receiver can detect newer updates.
- **Expiry:** Receivers reject QRs where `x < now()` and surface a clear error. Default TTL is 8 hours.
- **Integrity:** `h` is an FNV-1a 32-bit hash over the canonical (key-sorted) payload without `h`. Tampering or corruption flags `integrityOk: false` on the preview screen.

Receiver flow: every scanned patient QR opens a **preview/accept** modal showing category, ID, reason, action, interventions, high-risk flag, sender, generated time, expiry countdown and integrity status. Accept is required before merging into the local log.

### Other QR types

| Type | Purpose |
|---|---|
| `MIT_USER` (JSON `{t, v, name, role, g, app}`) | Identity card for bulk handover. Legacy `MIT_USER\|name\|role` pipe format still parsed. |
| `MIT_ACK` (JSON `{t, v, pid, rcv, g, app}`) | Acknowledgement returned by the receiver after accept; sender can scan to log handover-accepted. |
| `MIT_PT\|...` (legacy) | Old pipe-delimited patient export still accepted via the same preview/accept flow. |

## Privacy posture

- **No names, DOB, or NHS numbers are stored by default.** The free-text demographics field accepts anything the user types; teams should set local guidance accordingly.
- All patient data lives in **IndexedDB on the device** (no server). Wipe with **Reset Incident** — auto-exports a snapshot CSV and forensic audit CSV before deletion.
- Offline-first: no analytics, no third-party requests at runtime apart from OpenStreetMap tile fetches when the map view is opened.

## Audit log

Every clinically meaningful event records an audit entry: triage complete, intervention added/removed, evacuation, handover, ID change, QR generated, QR accepted/declined, expired QR rejected, duplicate merge, ACK generated, data wipe. Export via **Forensic Audit Trail (CSV)**.

## Running tests

```bash
node tests/lib.test.js
```

CI runs the same tests on every push (see `.github/workflows/test.yml`).

## Intended-use limitations

- The app is a **prototype** and has not been clinically certified. Do not deploy in live operations without local sign-off, training, and integration with primary triage tags.
- QR transfers are **best-effort**: always also tag the patient physically.
- The service worker aggressively caches; force-refresh after deployments to pick up updates.
- Camera/geolocation/NFC require HTTPS in production browsers.

## Contributing / change log

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

- Bulk handover beyond ~30 patients per QR will exceed safe capacity; CSV export is offered as fallback. Multi-QR chunking is *not* implemented yet — each chunk would need its own ACK and resequencing UI.
- Voice transcription uses on-device Web Speech APIs where supported (most Chromium-based mobile browsers + Safari iOS 14.5+). On unsupported browsers the user is told to type instead.
- Print labels rely on the OS print dialog (`window.print()`); AirPrint and most label printers work, but exotic networked label printers may need a dedicated driver.
- Reassessment intervals are hard-coded defaults (P1=10m, P2=30m, P3=60m). Per-incident overrides are not yet exposed.
