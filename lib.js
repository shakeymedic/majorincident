// Pure helpers shared by the app and tests.
// IMPORTANT: keep this file dependency-free and side-effect-free.
(function (root) {
    const QR_SCHEMA_VERSION = 3;
    const QR_DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
    const QR_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
    // Single-patient QR text above this size switches to the multi-part (chunked) transfer.
    const PATIENT_QR_MAX_CHARS = 1200; // after compression; keeps a single code at or below ~QR version 25
    // Number of location-history items carried inside a single-patient QR (full history travels in transfer files / multi-part QR).
    const PATIENT_QR_LOCATION_HISTORY_MAX = 5;

    // ---------- Triage categories ----------
    // NHS England casualty labelling (2023): P1/P2/P3; "Not breathing" is TST only (silver);
    // "Dead" is MITT only (black). "P1 Hold" (NARU / NHSE B0128) is a senior clinical decision.
    const CATEGORIES = ['P1', 'P2', 'P3', 'NOT_BREATHING', 'DEAD', 'P1_HOLD'];
    const CATEGORY_INFO = {
        P1:            { short: 'P1', label: 'IMMEDIATE', colour: '#DA291C', text: '#FFFFFF' },
        P2:            { short: 'P2', label: 'URGENT', colour: '#FAE100', text: '#000000' },
        P3:            { short: 'P3', label: 'DELAYED', colour: '#007F3B', text: '#FFFFFF' },
        NOT_BREATHING: { short: 'Not Breathing', label: 'BREATHING NOT DETECTED', colour: '#A7A9AC', text: '#000000' },
        DEAD:          { short: 'DEAD', label: 'DECEASED', colour: '#000000', text: '#FFFFFF' },
        P1_HOLD:       { short: 'P1 Hold', label: 'P1 HOLD', colour: '#00AEEF', text: '#FFFFFF' },
    };
    function isValidCategory(c) { return CATEGORIES.indexOf(c) > -1; }
    function categoryShort(c) { return (CATEGORY_INFO[c] && CATEGORY_INFO[c].short) || String(c || ''); }
    function categoryLabel(c) { return (CATEGORY_INFO[c] && CATEGORY_INFO[c].label) || String(c || ''); }

    // ---------- ASCII-safe JSON ----------
    // QR payloads are always pure ASCII: every non-ASCII character is written as a \uXXXX
    // escape. JSON.parse restores the identical string, so hashes still match, and no QR
    // library or scanner can mangle UTF-8 (accents, £, emoji from the quick-injury buttons).
    function toAsciiJSON(value) {
        return JSON.stringify(value).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
    }

    // ---------- Identifiers ----------
    const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    function randomBytes(n) {
        const out = new Uint8Array(n);
        const c = (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') ? crypto : null;
        if (c) c.getRandomValues(out);
        else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
        return out;
    }
    // Globally unique record identity. The human-facing patient ID can be edited or collide
    // between devices; the uid never changes and is what imports match on.
    function makeUid() {
        return Array.from(randomBytes(12)).map(b => ('0' + b.toString(16)).slice(-2)).join('');
    }
    // Short device code used as the default patient-ID prefix so two devices never both issue "TST-001".
    function makeDeviceCode() {
        return Array.from(randomBytes(4)).map(b => CROCKFORD[b % 32]).join('');
    }
    function _pad3(n) { n = String(n); while (n.length < 3) n = '0' + n; return n; }
    // Next unused automatic ID. Skips any ID already present so a patient can never be hidden by a reused ID.
    function nextAutoId(prefix, tool, counter, existingIds) {
        const taken = new Set(existingIds || []);
        let n = Math.max(1, parseInt(counter, 10) || 1);
        const base = [prefix, tool].filter(Boolean).join('-');
        let id = `${base}-${_pad3(n)}`;
        while (taken.has(id)) { n++; id = `${base}-${_pad3(n)}`; }
        return { id, counter: n };
    }

    // ---------- Incoming data sanitising ----------
    function _str(v, max) {
        if (v === undefined || v === null) return '';
        if (typeof v === 'object') return '';
        return String(v).slice(0, max || 200);
    }
    function _num(v) {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    function sanitiseInterventions(obj) {
        const out = {};
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
        Object.keys(obj).slice(0, 60).forEach(k => {
            const key = _str(k, 60).trim();
            if (!key) return;
            const v = obj[k] && typeof obj[k] === 'object' ? obj[k] : {};
            const item = { time: _str(v.time, 16), ts: _num(v.ts) };
            if (v.by) item.by = _str(v.by, 80);
            out[key] = item;
        });
        return out;
    }
    function sanitiseTriageHistory(list) {
        if (!Array.isArray(list)) return [];
        return list.slice(-50).filter(x => x && typeof x === 'object').map(x => ({
            ts: _num(x.ts), category: _str(x.category, 20), reason: _str(x.reason, 120), action: _str(x.action, 200),
            tool: _str(x.tool, 16), by: _str(x.by, 80), kind: _str(x.kind, 30),
        }));
    }
    function sanitiseFieldTimes(obj) {
        const out = {};
        if (!obj || typeof obj !== 'object') return out;
        Object.keys(obj).slice(0, 40).forEach(k => { const n = _num(obj[k]); if (n !== null) out[_str(k, 40)] = n; });
        return out;
    }
    // Type-check every field of a record received from another device. Never trust a QR/file.
    function sanitisePatientRecord(rec) {
        if (!rec || typeof rec !== 'object') return null;
        const out = {
            id: _str(rec.id, 80).trim(),
            uid: _str(rec.uid, 64),
            time: _str(rec.time, 16),
            timestamp: _num(rec.timestamp),
            createdAt: _num(rec.createdAt),
            createdBy: _str(rec.createdBy, 80),
            deviceId: _str(rec.deviceId, 16),
            tool: _str(rec.tool, 16),
            category: isValidCategory(rec.category) ? rec.category : '',
            action: _str(rec.action, 200),
            reason: _str(rec.reason, 120),
            triager: _str(rec.triager, 80),
            locationConfidence: _str(rec.locationConfidence, 40),
            sector: _str(rec.sector, 80), landmark: _str(rec.landmark, 80), floor: _str(rec.floor, 40), area: _str(rec.area, 80),
            demos: _str(rec.demos, 120),
            allergies: _str(rec.allergies, 300),
            notes: _str(rec.notes, 4000),
            highRisk: !!rec.highRisk,
            interventions: sanitiseInterventions(rec.interventions),
            evacuated: !!rec.evacuated,
            evacDest: _str(rec.evacDest, 120),
            evacVehicle: _str(rec.evacVehicle, 120),
            hospitalId: _str(rec.hospitalId, 60),
            tod: _str(rec.tod, 16),
            injuries: sanitiseInjuries(rec.injuries),
            lastReassessed: _num(rec.lastReassessed),
            reassessOutcome: _str(rec.reassessOutcome, 20),
            lastDeteriorationAt: _num(rec.lastDeteriorationAt),
            handoverState: _str(rec.handoverState, 20),
            handoverAt: _num(rec.handoverAt),
            handoverTo: _str(rec.handoverTo, 80),
            triageHistory: sanitiseTriageHistory(rec.triageHistory),
            fts: sanitiseFieldTimes(rec.fts),
            updatedAt: _num(rec.updatedAt),
            _rev: _num(rec._rev) || 0,
        };
        const cur = normaliseLocation(rec.currentLocation || rec.location);
        const init = normaliseLocation(rec.initialLocation || rec.location || rec.currentLocation);
        out.currentLocation = cur; out.location = cur; out.initialLocation = init;
        out.locationHistory = Array.isArray(rec.locationHistory) ? mergeLocationHistory([], rec.locationHistory.filter(x => x && typeof x === 'object').slice(-200)) : [];
        const lhn = _num(rec.locationHistoryTotal);
        if (lhn !== null) out.locationHistoryTotal = lhn;
        return out;
    }

    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fnv1a(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('00000000' + h.toString(16)).slice(-8);
    }

    // Stable canonical JSON: recursively sort object keys so equivalent objects
    // produce identical strings regardless of insertion order. Arrays preserve order.
    function canonicalJSON(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) {
            return '[' + value.map(canonicalJSON).join(',') + ']';
        }
        const keys = Object.keys(value).sort();
        const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k]));
        return '{' + parts.join(',') + '}';
    }

    function buildPatientPayload(entry, opts, ctx) {
        opts = opts || {};
        ctx = ctx || {};
        const now = ctx.now || Date.now();
        const ttlMs = opts.ttlMs || QR_DEFAULT_TTL_MS;
        const recordVersion = (entry._rev || 0) + 0;
        const short = {};
        if (entry.id) short.i = entry.id;
        if (entry.time) short.tm = entry.time;
        if (entry.timestamp) short.ts = entry.timestamp;
        if (entry.tool) short.tl = entry.tool;
        if (entry.category) short.c = entry.category;
        if (entry.action) short.a = entry.action;
        if (entry.reason) short.r = entry.reason;
        if (entry.triager) short.tr = entry.triager;
        const currentLoc = normaliseLocation(entry.currentLocation || entry.location);
        const initialLoc = normaliseLocation(entry.initialLocation || entry.location);
        if (currentLoc) short.l = compactLocation(currentLoc);
        if (initialLoc) short.il = compactLocation(initialLoc);
        if (Array.isArray(entry.locationHistory) && entry.locationHistory.length) {
            // Keep the QR small enough to scan: most recent items only, plus the true total.
            const hist = entry.locationHistory;
            short.lh = hist.slice(-PATIENT_QR_LOCATION_HISTORY_MAX).map(compactLocationHistoryItem).filter(Boolean);
            if (hist.length > PATIENT_QR_LOCATION_HISTORY_MAX) short.lhn = hist.length;
        }
        if (entry.uid) short.u = entry.uid;
        if (entry.createdAt) short.ca = entry.createdAt;
        if (entry.createdBy) short.cb = entry.createdBy;
        if (entry.deviceId) short.dv = entry.deviceId;
        if (entry.updatedAt) short.up = entry.updatedAt;
        if (entry.fts && Object.keys(entry.fts).length) short.ft = entry.fts;
        if (Array.isArray(entry.triageHistory) && entry.triageHistory.length) short.th = entry.triageHistory.slice(-5);
        if (entry.hospitalId) short.hid = entry.hospitalId;
        if (entry.tod) short.tod = entry.tod;
        if (entry.locationConfidence) short.lc = entry.locationConfidence;
        if (entry.landmark) short.lm = entry.landmark;
        if (entry.floor) short.fl = entry.floor;
        if (entry.area) short.ar = entry.area;
        if (entry.sector) short.s = entry.sector;
        if (entry.demos) short.d = entry.demos;
        if (entry.allergies) short.al = entry.allergies;
        if (entry.notes) short.n = entry.notes;
        if (entry.highRisk) short.hr = 1;
        if (entry.interventions && Object.keys(entry.interventions).length > 0) short.in = entry.interventions;
        if (entry.evacuated) short.ev = 1;
        if (entry.evacDest) short.ed = entry.evacDest;
        if (entry.evacVehicle) short.evv = entry.evacVehicle;
        if (Array.isArray(entry.injuries) && entry.injuries.length) short.inj = entry.injuries;
        if (entry.lastReassessed) short.lr = entry.lastReassessed;
        if (entry.reassessOutcome) short.ro = entry.reassessOutcome;
        if (entry.handoverState) short.hs = entry.handoverState;
        if (entry.handoverAt) short.ha = entry.handoverAt;
        if (entry.handoverTo) short.ht = entry.handoverTo;
        if (entry.lastDeteriorationAt) short.ld = entry.lastDeteriorationAt;
        const wrapper = {
            t: 'MIT_P',
            v: QR_SCHEMA_VERSION,
            rv: recordVersion,
            g: now,
            x: now + ttlMs,
            sndr: ctx.sender || '',
            app: ctx.appVersion || '',
            d: short,
        };
        const canonical = canonicalJSON(wrapper);
        wrapper.h = fnv1a(canonical);
        return wrapper;
    }

    function decompressData(short) {
        const raw = {
            id: short.i || '',
            uid: short.u || '',
            createdAt: short.ca || null,
            createdBy: short.cb || '',
            deviceId: short.dv || '',
            updatedAt: short.up || null,
            fts: short.ft || {},
            triageHistory: short.th || [],
            hospitalId: short.hid || '',
            tod: short.tod || '',
            locationHistoryTotal: short.lhn || undefined,
            time: short.tm || '',
            timestamp: short.ts || null,
            tool: short.tl || '',
            // Never default a missing category (previously defaulted to P3 — the least urgent).
            category: short.c || '',
            action: short.a || '',
            reason: short.r || '',
            triager: short.tr || 'Unknown',
            location: short.l ? expandCompactLocation(short.l) : null,
            initialLocation: short.il ? expandCompactLocation(short.il) : (short.l ? expandCompactLocation(short.l) : null),
            currentLocation: short.l ? expandCompactLocation(short.l) : null,
            locationHistory: Array.isArray(short.lh) ? short.lh.map(expandCompactLocationHistoryItem).filter(Boolean) : [],
            locationConfidence: short.lc || '',
            landmark: short.lm || '',
            floor: short.fl || '',
            area: short.ar || '',
            sector: short.s || '',
            demos: short.d || '',
            allergies: short.al || '',
            notes: short.n || '',
            highRisk: !!short.hr,
            interventions: short.in || {},
            evacuated: !!short.ev,
            evacDest: short.ed || '',
            evacVehicle: short.evv || '',
            injuries: Array.isArray(short.inj) ? short.inj : [],
            lastReassessed: short.lr || null,
            reassessOutcome: short.ro || '',
            handoverState: short.hs || '',
            handoverAt: short.ha || null,
            handoverTo: short.ht || '',
            lastDeteriorationAt: short.ld || null,
        };
        return sanitisePatientRecord(raw);
    }

    // Age / clock checks never block a patient handover — the clinical data does not become
    // untrue after a number of hours. They produce warnings the receiver must see.
    function _applyTimeChecks(meta, now) {
        meta.warnings = meta.warnings || [];
        if (meta.expiresAt && now > meta.expiresAt) {
            meta.expired = true;
            const ageMin = meta.generatedAt ? Math.round((now - meta.generatedAt) / 60000) : null;
            meta.warnings.push(`Older than the ${Math.round(QR_DEFAULT_TTL_MS / 3600000)}-hour freshness window${ageMin !== null ? ` (generated ${ageMin} min ago)` : ''}. The patient's condition may have changed — confirm with the sender or reassess.`);
        }
        if (meta.generatedAt && meta.generatedAt > now + QR_MAX_FUTURE_SKEW_MS) {
            meta.clockSkew = true;
            meta.warnings.push(`Sender's clock is ${Math.round((meta.generatedAt - now) / 60000)} min ahead of this device. Times on this record may be inaccurate.`);
        }
        return meta;
    }

    function validatePatientWrapper(wrapper, ctx) {
        ctx = ctx || {};
        if (!wrapper || typeof wrapper !== 'object') return { ok: false, reason: 'Invalid payload' };
        if (wrapper.t !== 'MIT_P') return { ok: false, reason: 'Not a MITT patient QR' };
        const meta = {
            schemaVersion: wrapper.v || 1,
            recordVersion: wrapper.rv || 0,
            generatedAt: wrapper.g || null,
            expiresAt: wrapper.x || null,
            sender: wrapper.sndr || '',
            app: wrapper.app || '',
            integrityOk: null,
        };
        if (wrapper.h) {
            const copy = Object.assign({}, wrapper);
            const givenHash = copy.h;
            delete copy.h;
            const canonical = canonicalJSON(copy);
            meta.integrityOk = (fnv1a(canonical) === givenHash);
        }
        const now = ctx.now || Date.now();
        _applyTimeChecks(meta, now);
        if (!wrapper.d || typeof wrapper.d !== 'object' || Array.isArray(wrapper.d)) return { ok: false, reason: 'No patient data in payload', meta };
        const data = decompressData(wrapper.d);
        if (!data.id) return { ok: false, reason: 'Missing patient ID', meta };
        if (!isValidCategory(data.category)) return { ok: false, reason: 'Missing or invalid triage category', meta };
        return { ok: true, data, meta };
    }

    // ---------- Record merge ----------
    // Rules (clinical safety first):
    //  * Identity is by uid where both sides have one (see matchIncomingRecord).
    //  * Category: a MORE urgent incoming P1/P2/P3 is always taken; a less urgent one, or any change
    //    involving Not Breathing / Dead / P1 Hold, is never applied automatically — it is kept as a
    //    conflict for the operator (unless the operator already chose via meta.resolutions).
    //  * Nothing is silently lost: interventions, injuries, allergies, location history and
    //    triage history are unions; flags (high risk, evacuated) are OR-ed.
    //  * Notes never nest: if one side already contains the other, the superset is kept.
    //  * Every change and conflict is reported so the app can audit it field by field.
    const CATEGORY_URGENCY = { P1: 0, P2: 1, P3: 2 };
    const LOW_RISK_TEXT_FIELDS = ['sector', 'landmark', 'floor', 'area', 'evacDest', 'evacVehicle', 'hospitalId', 'locationConfidence', 'tod'];

    function resolveCategoryMerge(localCat, incCat, resolution) {
        if (!incCat || incCat === localCat) return { take: false };
        if (!localCat) return { take: true, why: 'local empty' };
        if (resolution === 'incoming') return { take: true, why: 'operator chose incoming' };
        if (resolution === 'local') return { take: false, why: 'operator kept local' };
        if (localCat in CATEGORY_URGENCY && incCat in CATEGORY_URGENCY) {
            if (CATEGORY_URGENCY[incCat] < CATEGORY_URGENCY[localCat]) return { take: true, why: 'incoming more urgent' };
            return { take: false, conflict: true, why: 'incoming less urgent — not downgraded automatically' };
        }
        return { take: false, conflict: true, why: 'change involves Not Breathing / Dead / P1 Hold — needs a clinician' };
    }
    function mergeNotesText(localNotes, incNotes, sender) {
        const loc = localNotes || '', inc = incNotes || '';
        if (!inc || inc === loc) return { text: loc, changed: false };
        if (!loc) return { text: inc, changed: true };
        if (loc.includes(inc)) return { text: loc, changed: false };
        if (inc.includes(loc)) return { text: inc, changed: true };
        return { text: `${loc} [Imported from ${sender || 'Unknown'}: ${inc}]`, changed: true };
    }
    function mergeAllergiesText(loc, inc) {
        loc = loc || ''; inc = inc || '';
        if (!inc || inc === loc) return { text: loc, changed: false };
        if (!loc) return { text: inc, changed: true };
        if (loc.toLowerCase().includes(inc.toLowerCase())) return { text: loc, changed: false };
        if (inc.toLowerCase().includes(loc.toLowerCase())) return { text: inc, changed: true };
        return { text: `${loc}; ${inc}`, changed: true };
    }
    function _fieldTime(rec, f) { return (rec && rec.fts && typeof rec.fts[f] === 'number') ? rec.fts[f] : null; }

    function mergePatientRecordsDetailed(local, incoming, meta) {
        meta = meta || {};
        const resolutions = meta.resolutions || {};
        const sender = meta.sender || incoming.triager || 'Unknown';
        const out = Object.assign({}, local);
        out.fts = Object.assign({}, local.fts || {});
        const changes = [], conflicts = [], decisions = [];
        const note = (field, from, to) => changes.push({ field, from, to });
        // Operator choices on differing values are part of the record of what happened.
        ['category', 'demos'].forEach(f => {
            if (resolutions[f] && incoming[f] && local[f] && incoming[f] !== local[f]) decisions.push({ field: f, chose: resolutions[f], local: local[f], incoming: incoming[f] });
        });

        // Category (+ its action/reason)
        const cat = resolveCategoryMerge(local.category, incoming.category, resolutions.category);
        if (cat.take) {
            note('category', local.category || '', incoming.category);
            out.category = incoming.category;
            if (incoming.action && incoming.action !== local.action) { note('action', local.action || '', incoming.action); out.action = incoming.action; }
            if (incoming.reason && incoming.reason !== local.reason) { note('reason', local.reason || '', incoming.reason); out.reason = incoming.reason; }
            out.fts.category = Math.max(_fieldTime(incoming, 'category') || 0, Date.now());
        } else if (cat.conflict) {
            conflicts.push({ field: 'category', local: local.category, incoming: incoming.category, why: cat.why });
        }
        // Demographics: identity-critical — fill if empty, otherwise conflict unless operator chose.
        if (incoming.demos && incoming.demos !== local.demos) {
            if (!local.demos || resolutions.demos === 'incoming') { note('demos', local.demos || '', incoming.demos); out.demos = incoming.demos; }
            else if (resolutions.demos !== 'local') conflicts.push({ field: 'demos', local: local.demos, incoming: incoming.demos, why: 'demographics differ — confirm identity' });
        }
        // Allergies: union — never drop an allergy.
        const al = mergeAllergiesText(local.allergies, incoming.allergies);
        if (al.changed) { note('allergies', local.allergies || '', al.text); out.allergies = al.text; }
        // Notes: bounded, no nesting.
        const nt = mergeNotesText(local.notes, incoming.notes, sender);
        if (nt.changed) { note('notes', local.notes || '', nt.text); out.notes = nt.text; }
        // Low-risk operational text: fill if empty, else newer field edit wins.
        LOW_RISK_TEXT_FIELDS.forEach(f => {
            const inc = incoming[f];
            if (!inc || inc === local[f]) return;
            const incT = _fieldTime(incoming, f), locT = _fieldTime(local, f);
            if (!local[f] || (incT !== null && (locT === null || incT > locT))) {
                note(f, local[f] || '', inc); out[f] = inc;
                if (incT !== null) out.fts[f] = incT;
            }
        });
        if (incoming.highRisk && !local.highRisk) { note('highRisk', false, true); out.highRisk = true; }
        if (incoming.evacuated && !local.evacuated) { note('evacuated', false, true); out.evacuated = true; }
        if (!out.tool && incoming.tool) out.tool = incoming.tool;
        if (!out.uid && incoming.uid) out.uid = incoming.uid;
        if (incoming.createdAt && (!out.createdAt || incoming.createdAt < out.createdAt)) out.createdAt = incoming.createdAt;
        if (!out.createdBy && incoming.createdBy) out.createdBy = incoming.createdBy;

        // Location history always preserved; incoming current location wins only when it is newer.
        const locTs = (normaliseLocation(local.currentLocation || local.location) || {}).timestamp || 0;
        const incTs = (normaliseLocation(incoming.currentLocation || incoming.location) || {}).timestamp || 0;
        const beforeLoc = JSON.stringify(normaliseLocation(out.currentLocation || out.location) || null);
        mergeLocationFieldsInto(out, incoming, { preferIncoming: incTs > locTs, user: sender, reason: incTs > locTs ? 'import-merge' : 'import-history' });
        if (JSON.stringify(normaliseLocation(out.currentLocation || out.location) || null) !== beforeLoc) note('location', '', 'updated from import');

        // Interventions: union, earliest time kept.
        out.interventions = Object.assign({}, local.interventions || {});
        const added = [];
        Object.entries(incoming.interventions || {}).forEach(([k, v]) => {
            if (!out.interventions[k]) { out.interventions[k] = v; added.push(k); }
            else if (v && v.ts && out.interventions[k].ts && v.ts < out.interventions[k].ts) out.interventions[k] = v;
        });
        if (added.length) note('interventions', '', 'added ' + added.join(', '));
        // Injuries: union by ts|region|label.
        if (Array.isArray(incoming.injuries) && incoming.injuries.length) {
            const seen = new Set((out.injuries || []).map(m => `${m.ts}|${m.region}|${m.label}`));
            const merged = (out.injuries || []).slice();
            let n = 0;
            incoming.injuries.forEach(m => { const k = `${m.ts}|${m.region}|${m.label}`; if (!seen.has(k)) { merged.push(m); seen.add(k); n++; } });
            out.injuries = merged;
            if (n) note('injuries', '', `added ${n} mark(s)`);
        }
        // Triage history: union.
        if (Array.isArray(incoming.triageHistory) && incoming.triageHistory.length) {
            const seen = new Set((out.triageHistory || []).map(t => `${t.ts}|${t.category}`));
            const merged = (out.triageHistory || []).slice();
            incoming.triageHistory.forEach(t => { const k = `${t.ts}|${t.category}`; if (!seen.has(k)) { merged.push(t); seen.add(k); } });
            merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
            out.triageHistory = merged;
        }
        if (incoming.lastReassessed && (!out.lastReassessed || incoming.lastReassessed > out.lastReassessed)) {
            note('lastReassessed', out.lastReassessed || '', incoming.lastReassessed);
            out.lastReassessed = incoming.lastReassessed;
            if (incoming.reassessOutcome) out.reassessOutcome = incoming.reassessOutcome;
        }
        if (incoming.lastDeteriorationAt && (!out.lastDeteriorationAt || incoming.lastDeteriorationAt > out.lastDeteriorationAt)) out.lastDeteriorationAt = incoming.lastDeteriorationAt;
        if (incoming.updatedAt && (!out.updatedAt || incoming.updatedAt > out.updatedAt)) out.updatedAt = incoming.updatedAt;
        // Local handover state is this device's own business; never overwritten by a sender's state.

        if (conflicts.length) {
            const at = meta.now || Date.now();
            out.importConflicts = (Array.isArray(local.importConflicts) ? local.importConflicts : []).concat(conflicts.map(c => Object.assign({ from: sender, at }, c)));
        }
        out._rev = Math.max(out._rev || 0, (meta && meta.recordVersion) || 0, incoming._rev || 0) + 1;
        return { record: out, changes, conflicts, decisions };
    }
    function mergePatientRecords(local, incoming, meta) {
        return mergePatientRecordsDetailed(local, incoming, meta).record;
    }

    // Which local record (if any) is the same patient as an incoming record?
    // uid match = same patient. Same human ID but different uids = a COLLISION (different patients).
    function matchIncomingRecord(incoming, list) {
        list = list || [];
        if (incoming.uid) {
            const byUid = list.findIndex(e => e && e.uid === incoming.uid);
            if (byUid > -1) return { index: byUid, how: 'uid' };
        }
        const byId = list.findIndex(e => e && e.id === incoming.id);
        if (byId === -1) return { index: -1, how: 'none' };
        const local = list[byId];
        if (incoming.uid && local.uid && incoming.uid !== local.uid) return { index: -1, how: 'collision', collidesWith: byId };
        return { index: byId, how: incoming.uid && local.uid ? 'uid' : 'legacy-id' };
    }
    function collisionSafeId(id, incoming, list) {
        const taken = new Set((list || []).map(e => e && e.id));
        const tag = (incoming.deviceId || (incoming.uid || '').slice(0, 4) || 'IMP').toUpperCase();
        let candidate = `${id}~${tag}`, n = 2;
        while (taken.has(candidate)) candidate = `${id}~${tag}${n++}`;
        return candidate;
    }

    // ACK payload builder. The receiver name MUST be the local user accepting
    // receipt — never the sender's name — so that when the sender scans the
    // ACK and logs HANDOVER_ACCEPTED, the audit trail records the correct
    // identity.
    function buildAckPayload(patientId, receiverName, ctx) {
        ctx = ctx || {};
        const ack = {
            t: 'MIT_ACK',
            v: 2,
            pid: patientId || '',
            rcv: receiverName || '',
            g: ctx.now || Date.now(),
            app: ctx.appVersion || '',
        };
        // Which exact version was accepted: lets the sender detect "receiver has an older copy".
        if (ctx.uid) ack.uid = ctx.uid;
        if (ctx.payloadHash) ack.ph = ctx.payloadHash;
        if (ctx.recordVersion !== undefined) ack.rv = ctx.recordVersion;
        if (ctx.device) ack.dev = ctx.device;
        ack.h = fnv1a(canonicalJSON(ack));
        return ack;
    }
    // Transfer-level ACK for multi-patient (all / sector) transfers.
    function buildTransferAckPayload(transferId, payloadHash, count, receiverName, ctx) {
        ctx = ctx || {};
        const ack = { t: 'MIT_TACK', v: 1, tid: transferId || '', ph: payloadHash || '', n: count || 0, rcv: receiverName || '', g: ctx.now || Date.now(), app: ctx.appVersion || '' };
        if (ctx.device) ack.dev = ctx.device;
        if (ctx.imported !== undefined) ack.imp = ctx.imported;
        if (ctx.merged !== undefined) ack.mrg = ctx.merged;
        ack.h = fnv1a(canonicalJSON(ack));
        return ack;
    }
    function verifyAckIntegrity(ack) {
        if (!ack || typeof ack !== 'object' || !ack.h) return null; // legacy ACK without hash
        const copy = Object.assign({}, ack); const h = copy.h; delete copy.h;
        return fnv1a(canonicalJSON(copy)) === h;
    }

    // ---------- Structured body-map injuries ----------
    // Each mark is { region, side, x, y, label, severity, time, ts }.
    // x/y are normalised 0..1 against the SVG viewBox for resolution-independent
    // re-render. region is derived from y (head/torso/legs); side from x.
    const BODYMAP_VIEWBOX = { w: 200, h: 400 };
    function classifyBodymapPoint(x, y) {
        const region = y < 80 ? 'Head/Neck' : (y > 200 ? 'Legs' : 'Torso/Arms');
        const side = x < 100 ? 'Left' : 'Right';
        return { region, side };
    }
    function buildInjuryMark(opts) {
        opts = opts || {};
        const x = +opts.x, y = +opts.y;
        const cls = classifyBodymapPoint(x, y);
        const ts = opts.ts || Date.now();
        const time = opts.time || new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return {
            region: opts.region || cls.region,
            side: opts.side || cls.side,
            x: Math.max(0, Math.min(1, x / BODYMAP_VIEWBOX.w)),
            y: Math.max(0, Math.min(1, y / BODYMAP_VIEWBOX.h)),
            label: opts.label || '',
            severity: opts.severity || 'unspecified',
            time, ts,
        };
    }
    function injuriesToText(marks) {
        if (!Array.isArray(marks) || !marks.length) return '';
        return marks.map(m => {
            const lbl = m.label ? ' ' + m.label : '';
            const sev = m.severity && m.severity !== 'unspecified' ? ` (${m.severity})` : '';
            return `[${m.side ? m.side + ' ' : ''}${m.region}${lbl}${sev} @ ${m.time}]`;
        }).join(' ');
    }
    function sanitiseInjuries(marks) {
        if (!Array.isArray(marks)) return [];
        const out = [];
        for (const m of marks) {
            if (!m || typeof m !== 'object') continue;
            const x = typeof m.x === 'number' ? m.x : 0;
            const y = typeof m.y === 'number' ? m.y : 0;
            out.push({
                region: typeof m.region === 'string' ? m.region.slice(0, 32) : '',
                side: typeof m.side === 'string' ? m.side.slice(0, 16) : '',
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y)),
                label: typeof m.label === 'string' ? m.label.slice(0, 64) : '',
                severity: typeof m.severity === 'string' ? m.severity.slice(0, 16) : 'unspecified',
                time: typeof m.time === 'string' ? m.time.slice(0, 16) : '',
                ts: typeof m.ts === 'number' ? m.ts : Date.now(),
            });
        }
        return out;
    }

    // ---------- Bulk handover ----------
    const BULK_QR_SOFT_LIMIT = 1800; // approx safe QR capacity for level M
    function buildBulkPayload(entries, opts, ctx) {
        opts = opts || {};
        ctx = ctx || {};
        const now = ctx.now || Date.now();
        const ttlMs = opts.ttlMs || QR_DEFAULT_TTL_MS;
        // Compress each entry's data via the same buildPatientPayload short form
        const items = (entries || []).map(e => {
            const w = buildPatientPayload(e, { ttlMs }, ctx);
            return { rv: w.rv, d: w.d };
        });
        const wrapper = {
            t: 'MIT_BULK',
            v: 1,
            g: now,
            x: now + ttlMs,
            sndr: ctx.sender || '',
            sec: opts.sector || '',
            app: ctx.appVersion || '',
            n: items.length,
            items,
        };
        const canonical = canonicalJSON(wrapper);
        wrapper.h = fnv1a(canonical);
        return wrapper;
    }
    function validateBulkWrapper(wrapper, ctx) {
        ctx = ctx || {};
        if (!wrapper || typeof wrapper !== 'object') return { ok: false, reason: 'Invalid payload' };
        if (wrapper.t !== 'MIT_BULK') return { ok: false, reason: 'Not a MITT bulk handover QR' };
        const meta = {
            schemaVersion: wrapper.v || 1,
            generatedAt: wrapper.g || null,
            expiresAt: wrapper.x || null,
            sender: wrapper.sndr || '',
            sector: wrapper.sec || '',
            count: wrapper.n || 0,
            integrityOk: null,
        };
        if (wrapper.h) {
            const copy = Object.assign({}, wrapper);
            const givenHash = copy.h;
            delete copy.h;
            meta.integrityOk = (fnv1a(canonicalJSON(copy)) === givenHash);
        }
        const now = ctx.now || Date.now();
        _applyTimeChecks(meta, now);
        if (!Array.isArray(wrapper.items)) return { ok: false, reason: 'No items', meta };
        const decodedAll = wrapper.items.map(it => {
            const decoded = decompressData((it && it.d) || {});
            decoded._rev = (it && it.rv) || 0;
            return decoded;
        });
        const data = decodedAll.filter(d => d.id && isValidCategory(d.category));
        if (data.length !== decodedAll.length) meta.warnings.push(`${decodedAll.length - data.length} record(s) skipped: missing ID or category.`);
        return { ok: true, data, meta };
    }
    function bulkPayloadFits(wrapper) {
        try { return JSON.stringify(wrapper).length <= BULK_QR_SOFT_LIMIT; } catch (_) { return false; }
    }

    // ---------- Full all-patient offline transfer ----------
    const ALL_TRANSFER_SCHEMA_VERSION = 1;
    const ALL_QR_CHUNK_SOFT_LIMIT = 800; // ~QR version 19-20 at level L: easier phone-to-phone scanning
    const ALL_PATIENT_FIELD_ORDER = [
        'id','time','timestamp','tool','category','action','reason','triager','location','initialLocation','currentLocation','locationHistory','locationConfidence','sector','landmark','floor','area',
        'demos','allergies','notes','highRisk','interventions','evacuated','evacDest','evacVehicle',
        'injuries','lastReassessed','reassessOutcome','lastDeteriorationAt','handoverState','handoverAt','handoverTo','_rev',
        'uid','createdAt','createdBy','deviceId','updatedAt','fts','triageHistory','hospitalId','tod','importConflicts'
    ];

    function jsonClone(value) {
        if (value === undefined) return undefined;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
    }

    function _numOrNull(v) {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    function _roundCoord(v) {
        const n = _numOrNull(v);
        return n === null ? null : Math.round(n * 1e7) / 1e7;
    }
    function _roundMetric(v) {
        const n = _numOrNull(v);
        return n === null ? null : Math.round(n * 10) / 10;
    }
    function _stringOrEmpty(v, max) {
        if (v === undefined || v === null) return '';
        return String(v).trim().slice(0, max || 80);
    }
    function normaliseLocation(location, opts) {
        opts = opts || {};
        if (!location || typeof location !== 'object') return null;
        const lat = _roundCoord(location.lat !== undefined ? location.lat : location.latitude);
        const lng = _roundCoord(location.lng !== undefined ? location.lng : (location.lon !== undefined ? location.lon : location.longitude));
        const out = {};
        if (lat !== null) out.lat = lat.toFixed(7);
        if (lng !== null) out.lng = lng.toFixed(7);
        const accuracy = _roundMetric(location.accuracy !== undefined ? location.accuracy : location.acc);
        if (accuracy !== null) { out.accuracy = accuracy; out.acc = accuracy; }
        const altitude = _roundMetric(location.altitude);
        if (altitude !== null) out.altitude = altitude;
        const altitudeAccuracy = _roundMetric(location.altitudeAccuracy);
        if (altitudeAccuracy !== null) out.altitudeAccuracy = altitudeAccuracy;
        const heading = _roundMetric(location.heading);
        if (heading !== null) out.heading = heading;
        const speed = _roundMetric(location.speed);
        if (speed !== null) out.speed = speed;
        const ts = _numOrNull(location.timestamp !== undefined ? location.timestamp : opts.timestamp);
        if (ts !== null) out.timestamp = ts;
        const source = _stringOrEmpty(location.source || opts.source || '', 40);
        if (source) out.source = source;
        const age = _roundMetric(location.age !== undefined ? location.age : (out.timestamp ? ((opts.now || Date.now()) - out.timestamp) : null));
        if (age !== null && age >= 0) out.age = age;
        const confidence = _stringOrEmpty(location.confidence || opts.confidence || '', 40);
        if (confidence) out.confidence = confidence;
        const sector = _stringOrEmpty(location.sector || opts.sector || '', 80);
        if (sector) out.sector = sector;
        const landmark = _stringOrEmpty(location.landmark || opts.landmark || '', 80);
        if (landmark) out.landmark = landmark;
        const floor = _stringOrEmpty(location.floor || opts.floor || '', 40);
        if (floor) out.floor = floor;
        const area = _stringOrEmpty(location.area || opts.area || '', 80);
        if (area) out.area = area;
        return Object.keys(out).length ? out : null;
    }
    function compactLocation(loc) {
        const n = normaliseLocation(loc);
        if (!n) return null;
        const out = {};
        if (n.lat !== undefined) out.lt = n.lat;
        if (n.lng !== undefined) out.lg = n.lng;
        if (n.acc !== undefined) out.ac = n.acc;
        if (n.altitude !== undefined) out.al = n.altitude;
        if (n.altitudeAccuracy !== undefined) out.aa = n.altitudeAccuracy;
        if (n.heading !== undefined) out.hd = n.heading;
        if (n.speed !== undefined) out.sp = n.speed;
        if (n.timestamp !== undefined) out.ts = n.timestamp;
        if (n.source) out.so = n.source;
        if (n.age !== undefined) out.ag = n.age;
        if (n.confidence) out.cf = n.confidence;
        if (n.sector) out.sc = n.sector;
        if (n.landmark) out.lm = n.landmark;
        if (n.floor) out.fl = n.floor;
        if (n.area) out.ar = n.area;
        return out;
    }
    function expandCompactLocation(c) {
        if (!c || typeof c !== 'object') return null;
        return normaliseLocation({
            lat: c.lt !== undefined ? c.lt : c.lat,
            lng: c.lg !== undefined ? c.lg : c.lng,
            accuracy: c.ac !== undefined ? c.ac : c.accuracy,
            altitude: c.al !== undefined ? c.al : c.altitude,
            altitudeAccuracy: c.aa !== undefined ? c.aa : c.altitudeAccuracy,
            heading: c.hd !== undefined ? c.hd : c.heading,
            speed: c.sp !== undefined ? c.sp : c.speed,
            timestamp: c.ts !== undefined ? c.ts : c.timestamp,
            source: c.so !== undefined ? c.so : c.source,
            age: c.ag !== undefined ? c.ag : c.age,
            confidence: c.cf !== undefined ? c.cf : c.confidence,
            sector: c.sc !== undefined ? c.sc : c.sector,
            landmark: c.lm !== undefined ? c.lm : c.landmark,
            floor: c.fl !== undefined ? c.fl : c.floor,
            area: c.ar !== undefined ? c.ar : c.area,
        });
    }
    function compactLocationHistoryItem(item) {
        if (!item || typeof item !== 'object') return null;
        const loc = compactLocation(item.location || item);
        const out = loc || {};
        if (item.at || item.timestamp) out.at = item.at || item.timestamp;
        if (item.user || item.triager) out.usr = _stringOrEmpty(item.user || item.triager, 60);
        if (item.reason || item.action) out.rs = _stringOrEmpty(item.reason || item.action, 80);
        if (item.action) out.act = _stringOrEmpty(item.action, 80);
        return Object.keys(out).length ? out : null;
    }
    function expandCompactLocationHistoryItem(item) {
        if (!item || typeof item !== 'object') return null;
        const loc = expandCompactLocation(item);
        const out = Object.assign({}, loc || {});
        if (item.at) out.at = item.at;
        if (item.usr) out.user = item.usr;
        if (item.rs) out.reason = item.rs;
        if (item.act) out.action = item.act;
        return out;
    }
    // opts.maxAgeMs: ignore fixes older than this (relative to opts.now) so a patient is never
    // stamped with where the triager stood several minutes ago.
    function selectBestLocationFix(fixes, opts) {
        opts = opts || {};
        if (!Array.isArray(fixes) || !fixes.length) return null;
        const now = opts.now || Date.now();
        let best = null;
        for (const f of fixes) {
            const n = normaliseLocation(f);
            if (!n || n.lat === undefined || n.lng === undefined) continue;
            if (opts.maxAgeMs && (n.timestamp === undefined || now - n.timestamp > opts.maxAgeMs)) continue;
            if (!best) { best = n; continue; }
            const ba = _numOrNull(best.acc);
            const na = _numOrNull(n.acc);
            if (ba === null || (na !== null && na < ba)) best = n;
        }
        return best;
    }
    function classifyLocationAccuracy(acc) {
        const n = _numOrNull(acc);
        if (n === null) return { level:'unknown', label:'Unknown', warning:true, className:'unknown' };
        if (n <= 10) return { level:'exact', label:'GPS exact', warning:false, className:'good' };
        if (n <= 25) return { level:'approximate', label:'GPS approximate', warning:false, className:'ok' };
        if (n <= 50) return { level:'poor', label:'Poor GPS', warning:true, className:'warn' };
        return { level:'very-poor', label:'Very poor GPS', warning:true, className:'bad' };
    }
    function formatLocationAge(timestamp, now) {
        const ts = _numOrNull(timestamp);
        if (ts === null) return 'unknown age';
        const diff = Math.max(0, (now || Date.now()) - ts);
        if (diff < 60 * 1000) return 'just now';
        const mins = Math.round(diff / 60000);
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
        const days = Math.round(hrs / 24);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }
    function locationHistoryKey(item) {
        const loc = normaliseLocation(item.location || item) || {};
        return [item.at || item.timestamp || loc.timestamp || '', loc.lat || '', loc.lng || '', loc.acc || '', item.reason || item.action || '', item.user || item.triager || ''].join('|');
    }
    function appendLocationHistory(entry, location, meta) {
        meta = meta || {};
        const out = Object.assign({}, entry || {});
        const loc = normaliseLocation(location, { source: meta.source, confidence: meta.confidence, sector: meta.sector, landmark: meta.landmark, floor: meta.floor, area: meta.area });
        if (!loc) return out;
        const at = meta.at || loc.timestamp || Date.now();
        const item = Object.assign({}, loc, {
            at,
            user: meta.user || out.triager || '',
            source: loc.source || meta.source || '',
            reason: meta.reason || meta.action || 'location-update',
            action: meta.action || meta.reason || 'location-update',
            confidence: meta.confidence || loc.confidence || out.locationConfidence || '',
            sector: meta.sector !== undefined ? meta.sector : (loc.sector || out.sector || ''),
            landmark: meta.landmark !== undefined ? meta.landmark : (loc.landmark || out.landmark || ''),
            floor: meta.floor !== undefined ? meta.floor : (loc.floor || out.floor || ''),
            area: meta.area !== undefined ? meta.area : (loc.area || out.area || ''),
        });
        out.locationHistory = mergeLocationHistory(out.locationHistory || [], [item]);
        if (!out.initialLocation) out.initialLocation = normaliseLocation(item);
        out.currentLocation = normaliseLocation(item);
        out.location = out.currentLocation;
        if (item.confidence) out.locationConfidence = item.confidence;
        if (item.sector) out.sector = item.sector;
        if (item.landmark) out.landmark = item.landmark;
        if (item.floor) out.floor = item.floor;
        if (item.area) out.area = item.area;
        return out;
    }
    function mergeLocationHistory(a, b) {
        const out = [];
        const seen = new Set();
        for (const item of ([]).concat(a || [], b || [])) {
            const loc = normaliseLocation(item.location || item);
            if (!loc && !item) continue;
            const merged = Object.assign({}, loc || {}, item || {});
            const k = locationHistoryKey(merged);
            if (!seen.has(k)) { seen.add(k); out.push(merged); }
        }
        out.sort((x,y) => ((x.at || x.timestamp || 0) - (y.at || y.timestamp || 0)));
        return out;
    }
    function mergeLocationFieldsInto(out, incoming, meta) {
        meta = meta || {};
        const incHist = Array.isArray(incoming.locationHistory) ? incoming.locationHistory : [];
        out.locationHistory = mergeLocationHistory(out.locationHistory || [], incHist);
        if (!out.initialLocation) out.initialLocation = normaliseLocation(incoming.initialLocation || incoming.location || incoming.currentLocation);
        else if (incoming.initialLocation) out.locationHistory = mergeLocationHistory(out.locationHistory, [Object.assign({ reason:'incoming-initial-location' }, incoming.initialLocation)]);
        const incCurrent = normaliseLocation(incoming.currentLocation || incoming.location);
        if (incCurrent && meta.preferIncoming) {
            const updated = appendLocationHistory(out, incCurrent, {
                user: meta.user || incoming.triager || '', source: incCurrent.source || 'import', reason: meta.reason || 'import-location',
                confidence: incoming.locationConfidence || incCurrent.confidence || '', sector: incoming.sector, landmark: incoming.landmark, floor: incoming.floor, area: incoming.area,
            });
            Object.assign(out, updated);
        }
        if (incoming.locationConfidence && (meta.preferIncoming || !out.locationConfidence)) out.locationConfidence = incoming.locationConfidence;
        if (incoming.landmark && (meta.preferIncoming || !out.landmark)) out.landmark = incoming.landmark;
        if (incoming.floor && (meta.preferIncoming || !out.floor)) out.floor = incoming.floor;
        if (incoming.area && (meta.preferIncoming || !out.area)) out.area = incoming.area;
        if (out.currentLocation) out.location = out.currentLocation;
        return out;
    }

    function clonePatientRecord(entry) {
        const src = entry || {};
        const out = {};
        ALL_PATIENT_FIELD_ORDER.forEach(k => {
            if (k === 'location' || k === 'initialLocation' || k === 'currentLocation') {
                const loc = normaliseLocation(src[k]);
                if (loc) out[k] = loc;
            } else if (k === 'locationHistory') {
                const hist = mergeLocationHistory([], src.locationHistory || []);
                if (hist.length) out.locationHistory = hist;
            } else if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) {
                out[k] = jsonClone(src[k]);
            }
        });
        // Preserve any future/offline fields added by the app without requiring a schema change.
        Object.keys(src).sort().forEach(k => {
            if (!Object.prototype.hasOwnProperty.call(out, k) && src[k] !== undefined && typeof src[k] !== 'function') {
                out[k] = jsonClone(src[k]);
            }
        });
        if (!out.currentLocation && out.location) out.currentLocation = normaliseLocation(out.location);
        if (!out.location && out.currentLocation) out.location = normaliseLocation(out.currentLocation);
        if (!out.initialLocation && out.currentLocation) out.initialLocation = normaliseLocation(out.currentLocation);
        if (!Array.isArray(out.locationHistory)) out.locationHistory = [];
        if (!out.id && src.i) out.id = src.i;
        if (!out.category && src.c) out.category = src.c;
        return out;
    }

    function buildAllPatientsPayload(entries, opts, ctx) {
        opts = opts || {};
        ctx = ctx || {};
        const now = ctx.now || Date.now();
        const ttlMs = opts.ttlMs || QR_DEFAULT_TTL_MS;
        const patients = (entries || []).map(clonePatientRecord);
        const audit = Array.isArray(opts.auditLog) ? opts.auditLog.map(jsonClone).filter(Boolean) : [];
        const wrapper = {
            t: 'MIT_ALL',
            v: ALL_TRANSFER_SCHEMA_VERSION,
            sv: QR_SCHEMA_VERSION,
            g: now,
            x: now + ttlMs,
            transferId: opts.transferId || fnv1a(`${now}|${ctx.sender || ''}|${patients.length}|${canonicalJSON(patients)}`),
            sndr: ctx.sender || '',
            app: ctx.appVersion || '',
            n: patients.length,
            patientFields: ALL_PATIENT_FIELD_ORDER.slice(),
            patients,
            audit,
            incident: jsonClone(opts.incident || {}) || {},
        };
        if (opts.scope) wrapper.scope = jsonClone(opts.scope);
        if (ctx.device) wrapper.dev = ctx.device;
        const canonical = canonicalJSON(wrapper);
        wrapper.h = fnv1a(canonical);
        return wrapper;
    }

    function validateAllPatientsWrapper(wrapper, ctx) {
        ctx = ctx || {};
        if (!wrapper || typeof wrapper !== 'object') return { ok: false, reason: 'Invalid payload' };
        if (wrapper.t !== 'MIT_ALL') return { ok: false, reason: 'Not an all-patient transfer' };
        const meta = {
            schemaVersion: wrapper.v || 1,
            patientSchemaVersion: wrapper.sv || 1,
            generatedAt: wrapper.g || null,
            expiresAt: wrapper.x || null,
            transferId: wrapper.transferId || '',
            sender: wrapper.sndr || '',
            senderDevice: wrapper.dev || '',
            app: wrapper.app || '',
            count: wrapper.n || 0,
            scope: wrapper.scope || null,
            payloadHash: wrapper.h || '',
            auditCount: Array.isArray(wrapper.audit) ? wrapper.audit.length : 0,
            integrityOk: null,
            warnings: [],
        };
        if (wrapper.h) {
            const copy = Object.assign({}, wrapper);
            const givenHash = copy.h;
            delete copy.h;
            meta.integrityOk = (fnv1a(canonicalJSON(copy)) === givenHash);
            if (!meta.integrityOk) return { ok: false, reason: 'All-patient payload integrity check failed (data corrupted in transit)', meta };
        }
        const now = ctx.now || Date.now();
        _applyTimeChecks(meta, now);
        if (!Array.isArray(wrapper.patients)) return { ok: false, reason: 'No patients in transfer', meta };
        const cleaned = wrapper.patients.map(p => sanitisePatientRecord(clonePatientRecord(p)));
        const data = cleaned.filter(d => d && d.id && isValidCategory(d.category));
        const skipped = cleaned.length - data.length;
        if (skipped) meta.warnings.push(`${skipped} record(s) cannot be imported: missing patient ID or triage category.`);
        if (!data.length) return { ok: false, reason: 'No valid patient records in transfer', meta, data };
        return { ok: true, data, skipped, audit: Array.isArray(wrapper.audit) ? wrapper.audit.map(jsonClone).filter(Boolean) : [], incident: wrapper.incident || {}, meta };
    }

    // Chunk a transport body. body is ASCII JSON ("json") or "MITZ1:" + base64 deflate ("z1").
    function buildAllPatientsChunks(payload, opts) {
        opts = opts || {};
        const maxChars = Math.max(400, opts.maxChars || ALL_QR_CHUNK_SOFT_LIMIT);
        const body = opts.body || ((typeof payload === 'string') ? payload : toAsciiJSON(payload));
        const enc = opts.enc || 'json';
        const transferId = (payload && payload.transferId) || fnv1a(body);
        const payloadHash = fnv1a(body);
        const generatedAt = (payload && payload.g) || Date.now();
        const expiresAt = (payload && payload.x) || (generatedAt + QR_DEFAULT_TTL_MS);
        const sender = (payload && payload.sndr) || '';
        const app = (payload && payload.app) || '';
        const overheadSample = { t:'MIT_ALL_CHUNK', v:1, transferId, totalChunks:999, chunkIndex:999, g:generatedAt, x:expiresAt, sndr:sender, app, payloadHash, chunkHash:'12345678', data:'', enc, h:'12345678' };
        const overhead = toAsciiJSON(overheadSample).length + 16;
        // Slice so that the ESCAPED chunk (quotes/backslashes double up) stays within maxChars.
        const budget = Math.max(100, maxChars - overhead);
        const slices = [];
        let pos = 0;
        while (pos < body.length) {
            let len = Math.min(budget, body.length - pos);
            while (len > 1 && JSON.stringify(body.slice(pos, pos + len)).length - 2 > budget) len = Math.floor(len * 0.9);
            slices.push(body.slice(pos, pos + len));
            pos += len;
        }
        if (!slices.length) slices.push('');
        const total = slices.length;
        return slices.map((data, i) => {
            const chunk = { t:'MIT_ALL_CHUNK', v:1, transferId, totalChunks:total, chunkIndex:i, g:generatedAt, x:expiresAt, sndr:sender, app, payloadHash, chunkHash:fnv1a(data), data };
            if (enc !== 'json') chunk.enc = enc;
            chunk.h = fnv1a(canonicalJSON(chunk));
            return chunk;
        });
    }

    function validateAllPatientChunk(chunk, ctx) {
        ctx = ctx || {};
        if (!chunk || typeof chunk !== 'object') return { ok:false, reason:'Invalid chunk' };
        if (chunk.t !== 'MIT_ALL_CHUNK') return { ok:false, reason:'Not an all-patient chunk' };
        const meta = {
            transferId: chunk.transferId || '', totalChunks: chunk.totalChunks || 0, chunkIndex: chunk.chunkIndex,
            generatedAt: chunk.g || null, expiresAt: chunk.x || null, sender: chunk.sndr || '', app: chunk.app || '',
            payloadHash: chunk.payloadHash || '', chunkHash: chunk.chunkHash || '', enc: chunk.enc || 'json', integrityOk: null, warnings: []
        };
        if (!meta.transferId) return { ok:false, reason:'Chunk missing transfer ID', meta };
        if (!Number.isInteger(meta.totalChunks) || meta.totalChunks < 1) return { ok:false, reason:'Chunk total invalid', meta };
        if (!Number.isInteger(meta.chunkIndex) || meta.chunkIndex < 0 || meta.chunkIndex >= meta.totalChunks) return { ok:false, reason:'Chunk number invalid', meta };
        if (typeof chunk.data !== 'string') return { ok:false, reason:'Chunk data missing', meta };
        if (chunk.chunkHash && fnv1a(chunk.data) !== chunk.chunkHash) return { ok:false, reason:'Chunk checksum failed', meta };
        if (chunk.h) {
            const copy = Object.assign({}, chunk); const givenHash = copy.h; delete copy.h;
            meta.integrityOk = (fnv1a(canonicalJSON(copy)) === givenHash);
            if (!meta.integrityOk) return { ok:false, reason:'Chunk wrapper integrity check failed', meta };
        }
        _applyTimeChecks(meta, ctx.now || Date.now());
        return { ok:true, chunk, meta };
    }

    // Join validated chunks. Does not decode/decompress.
    function reassembleChunkBody(chunks, ctx) {
        ctx = ctx || {};
        const seen = new Map();
        let firstMeta = null;
        for (const c of chunks || []) {
            const r = validateAllPatientChunk(c, ctx);
            if (!r.ok) return { ok:false, reason:r.reason, meta:r.meta || firstMeta };
            const m = r.meta;
            if (!firstMeta) firstMeta = m;
            if (m.transferId !== firstMeta.transferId || m.totalChunks !== firstMeta.totalChunks || m.payloadHash !== firstMeta.payloadHash) {
                return { ok:false, reason:'Chunk belongs to a different transfer', meta:m };
            }
            if (!seen.has(m.chunkIndex)) seen.set(m.chunkIndex, c);
        }
        if (!firstMeta) return { ok:false, reason:'No chunks scanned', received:0, total:0 };
        const total = firstMeta.totalChunks;
        if (seen.size < total) {
            const missing = []; for (let i = 0; i < total; i++) if (!seen.has(i)) missing.push(i);
            return { ok:false, incomplete:true, reason:`Need ${total - seen.size} more chunk(s)`, received:seen.size, total, missing, meta:firstMeta };
        }
        let body = '';
        for (let i = 0; i < total; i++) body += seen.get(i).data;
        if (fnv1a(body) !== firstMeta.payloadHash) return { ok:false, reason:'Overall transfer checksum failed', received:seen.size, total, meta:firstMeta };
        return { ok:true, body, enc:firstMeta.enc, received:seen.size, total, meta:firstMeta };
    }
    function _finishReassembly(text, joined, ctx) {
        let payload;
        try { payload = JSON.parse(text); } catch (_) { return { ok:false, reason:'Reassembled payload is not valid JSON', received:joined.received, total:joined.total, meta:joined.meta }; }
        const valid = validateAllPatientsWrapper(payload, ctx);
        if (!valid.ok) return Object.assign({ received:joined.received, total:joined.total }, valid);
        valid.received = joined.received; valid.total = joined.total; valid.wrapper = payload;
        return valid;
    }
    function reassembleAllPatientChunks(chunks, ctx) {
        const joined = reassembleChunkBody(chunks, ctx);
        if (!joined.ok) return joined;
        if (joined.enc !== 'json') return { ok:false, reason:'Compressed transfer: use reassembleAllPatientChunksAsync', received:joined.received, total:joined.total, meta:joined.meta };
        return _finishReassembly(joined.body, joined, ctx);
    }
    async function reassembleAllPatientChunksAsync(chunks, ctx) {
        const joined = reassembleChunkBody(chunks, ctx);
        if (!joined.ok) return joined;
        let text;
        try { text = await decodeTransportText(joined.body); }
        catch (e) { return { ok:false, reason:'Could not decompress transfer: ' + (e && e.message ? e.message : e), received:joined.received, total:joined.total, meta:joined.meta }; }
        return _finishReassembly(text, joined, ctx);
    }

    function _transferResult(payload, transport, enc, jsonText, maxChars) {
        if (transport.length <= maxChars) return { mode:'single', payload, text: jsonText, qrText: transport, enc, chunks:[], transferId:payload.transferId, totalChunks:1, byteLength:transport.length, jsonLength: jsonText.length };
        const chunks = buildAllPatientsChunks(payload, { maxChars, body: transport, enc });
        return { mode:'chunked', payload, text: jsonText, qrText: null, enc, chunks, transferId:payload.transferId, totalChunks:chunks.length, byteLength:transport.length, jsonLength: jsonText.length };
    }
    function buildAllPatientsTransfer(entries, opts, ctx) {
        opts = opts || {}; ctx = ctx || {};
        const payload = buildAllPatientsPayload(entries, opts, ctx);
        const text = toAsciiJSON(payload);
        return _transferResult(payload, text, 'json', text, opts.maxChars || ALL_QR_CHUNK_SOFT_LIMIT);
    }
    // Same as above but compresses (deflate + base64) where the platform supports it — typically 5-10x fewer QR codes.
    async function buildAllPatientsTransferAsync(entries, opts, ctx) {
        opts = opts || {}; ctx = ctx || {};
        const payload = buildAllPatientsPayload(entries, opts, ctx);
        const text = toAsciiJSON(payload);
        let transport = text, enc = 'json';
        if (opts.compress !== false) {
            const z = await encodeTransportText(text);
            if (z && z.length < text.length) { transport = z; enc = 'z1'; }
        }
        return _transferResult(payload, transport, enc, text, opts.maxChars || ALL_QR_CHUNK_SOFT_LIMIT);
    }

    // Import plan: uid-aware matching, field-level merge report, collisions renamed (never merged).
    function mergeAllPatientRecords(existingList, incomingList, meta) {
        const records = (existingList || []).map(clonePatientRecord);
        let imported = 0, merged = 0;
        const nearDuplicates = [], collisions = [], report = [];
        for (const raw of (incomingList || [])) {
            const incoming = Object.assign({}, raw);
            const recordMeta = Object.assign({}, meta || {}, { recordVersion: incoming._rev || (meta && meta.recordVersion) || 0 });
            const match = matchIncomingRecord(incoming, records);
            if (match.index > -1) {
                const res = mergePatientRecordsDetailed(records[match.index], incoming, recordMeta);
                records[match.index] = res.record;
                merged++;
                report.push({ id: res.record.id, uid: res.record.uid, action: 'merged', how: match.how, changes: res.changes, conflicts: res.conflicts });
                continue;
            }
            const entry = clonePatientRecord(incoming);
            if (match.how === 'collision') {
                const newId = collisionSafeId(incoming.id, incoming, records);
                collisions.push({ originalId: incoming.id, newId });
                entry.id = newId;
                entry.importConflicts = (entry.importConflicts || []).concat([{ field: 'id', local: incoming.id, incoming: newId, why: 'Same patient ID as a different local patient — imported under a new ID. Check the physical tag.', from: (meta && meta.sender) || '', at: (meta && meta.now) || Date.now() }]);
            }
            const cands = findDuplicateCandidates(entry, records, { threshold: 0.7 });
            if (cands.length) nearDuplicates.push({ incoming: entry, candidates: cands });
            if (!entry.uid) entry.uid = makeUid(); // legacy senders: give the record a permanent identity here
            entry.handoverState = 'received';
            entry.receivedFrom = (meta && meta.sender) || '';
            entry.receivedAt = (meta && meta.now) || Date.now();
            entry._rev = (incoming._rev || 0) + 1;
            records.push(entry);
            imported++;
            report.push({ id: entry.id, uid: entry.uid, action: match.how === 'collision' ? 'imported-renamed' : 'imported', how: match.how });
        }
        return { records, imported, merged, nearDuplicates, collisions, report };
    }

    // ---------- Transport encoding (compression) ----------
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function bytesToBase64(bytes) {
        let out = '', i = 0;
        for (; i + 2 < bytes.length; i += 3) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
            out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
        }
        if (i < bytes.length) {
            const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
            out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
        }
        return out;
    }
    function base64ToBytes(str) {
        const clean = String(str).replace(/[^A-Za-z0-9+/]/g, '');
        const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
        let o = 0;
        for (let i = 0; i < clean.length; i += 4) {
            const a = B64.indexOf(clean[i]), b = B64.indexOf(clean[i + 1]);
            const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : -1, d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : -1;
            const n = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
            if (o < out.length) out[o++] = (n >> 16) & 255;
            if (c >= 0 && o < out.length) out[o++] = (n >> 8) & 255;
            if (d >= 0 && o < out.length) out[o++] = n & 255;
        }
        return out.slice(0, o);
    }
    function compressionSupported() {
        return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' && typeof Response !== 'undefined';
    }
    async function encodeTransportText(text) {
        if (!compressionSupported()) return null;
        try {
            const stream = new Blob([utf8Bytes(text)]).stream().pipeThrough(new CompressionStream('deflate'));
            const buf = new Uint8Array(await new Response(stream).arrayBuffer());
            return 'MITZ1:' + bytesToBase64(buf);
        } catch (_) { return null; }
    }
    function isCompressedTransport(text) { return typeof text === 'string' && text.indexOf('MITZ1:') === 0; }
    // Pure-JS inflate (vendor/pako_inflate.min.js) for browsers without DecompressionStream,
    // e.g. iPhones on iOS < 16.4, so they can still receive compressed QR handovers.
    function _jsInflate() {
        const g = (typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null));
        return g && g.pako && typeof g.pako.inflate === 'function' ? g.pako.inflate : null;
    }
    async function decodeTransportText(text) {
        if (!isCompressedTransport(text)) return text;
        const bytes = base64ToBytes(text.slice(6));
        if (!compressionSupported()) {
            const inflate = _jsInflate();
            if (!inflate) throw new Error('This browser cannot decompress transfers — use the transfer file instead');
            return new TextDecoder().decode(inflate(bytes));
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
        const buf = new Uint8Array(await new Response(stream).arrayBuffer());
        return new TextDecoder().decode(buf);
    }

    // ---------- Patient identity / duplicate matching ----------
    // Returns a 0..1 similarity score for two records using ID, demographics,
    // sector, category, time-of-triage and GPS proximity. Never returns 1.0
    // unless IDs match exactly; near-matches are surfaced for human review.
    function distanceMeters(a, b) {
        a = normaliseLocation(a); b = normaliseLocation(b);
        if (!a || !b || !a.lat || !b.lat) return null;
        const toRad = (d) => d * Math.PI / 180;
        const lat1 = parseFloat(a.lat), lng1 = parseFloat(a.lng);
        const lat2 = parseFloat(b.lat), lng2 = parseFloat(b.lng);
        if ([lat1,lng1,lat2,lng2].some(v => isNaN(v))) return null;
        const R = 6371000;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const s = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
        return 2 * R * Math.asin(Math.sqrt(s));
    }
    function _normaliseDemos(d) {
        return String(d || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    function similarityScore(a, b) {
        if (!a || !b) return 0;
        if (a.id && b.id && a.id === b.id) return 1;
        let score = 0, used = 0;
        // Demographics (age band / sex blob)
        const da = _normaliseDemos(a.demos), db = _normaliseDemos(b.demos);
        if (da || db) {
            used += 0.30;
            if (da && db && da === db) score += 0.30;
            else if (da && db && (da.includes(db) || db.includes(da))) score += 0.20;
        }
        // Operational location labels (sector/landmark/floor/area) when coordinates are absent or weak.
        const labelA = [a.sector, a.landmark, a.floor, a.area].map(_normaliseDemos).filter(Boolean);
        const labelB = [b.sector, b.landmark, b.floor, b.area].map(_normaliseDemos).filter(Boolean);
        if (labelA.length || labelB.length) {
            used += 0.20;
            const overlap = labelA.filter(x => labelB.includes(x)).length;
            if (overlap) score += Math.min(0.20, 0.10 + 0.05 * overlap);
        }
        // Category
        if (a.category && b.category) {
            used += 0.10;
            if (a.category === b.category) score += 0.10;
        }
        // Time proximity (within 10 min)
        if (a.timestamp && b.timestamp) {
            used += 0.15;
            const dt = Math.abs(a.timestamp - b.timestamp);
            if (dt < 10*60*1000) score += 0.15 * (1 - dt / (10*60*1000));
        }
        // GPS proximity (within 30m strong, 100m weak)
        const dist = distanceMeters(a.currentLocation || a.location, b.currentLocation || b.location);
        if (dist !== null) {
            used += 0.30;
            if (dist < 30) score += 0.30;
            else if (dist < 100) score += 0.30 * (1 - (dist - 30) / 70);
        }
        const raw = used > 0 ? score / used : 0;
        // Category, sector and triage time alone are shared by many different casualties in a
        // mass-casualty incident. Without matching demographics or GPS within 100 m there is no
        // real evidence of identity, so the score is capped below every warning threshold.
        const demosMatch = !!(da && db && (da === db || da.includes(db) || db.includes(da)));
        const gpsNear = dist !== null && dist < 100;
        if (!demosMatch && !gpsNear) return Math.min(raw, 0.5);
        return raw;
    }
    function findDuplicateCandidates(incoming, existingList, opts) {
        opts = opts || {};
        const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.65;
        const out = [];
        for (const cand of existingList || []) {
            if (!cand || cand.id === incoming.id) continue;
            const s = similarityScore(incoming, cand);
            if (s >= threshold) out.push({ candidate: cand, score: s });
        }
        out.sort((a, b) => b.score - a.score);
        return out;
    }

    // ---------- Reassessment scheduling ----------
    // Local defaults (not specified by NHSE B0128, which says "reassess regularly") — require clinical sign-off.
    // Not Breathing (TST) is due immediately: NARU — "must be re-assessed by a Healthcare responder as soon as possible".
    const REASSESS_INTERVALS = { P1: 10*60*1000, P2: 30*60*1000, P3: 60*60*1000, P1_HOLD: 30*60*1000, NOT_BREATHING: 5*60*1000, DEAD: null };
    function nextReassessmentDue(entry, now, intervals) {
        if (!entry) return null;
        const table = Object.assign({}, REASSESS_INTERVALS, intervals || {});
        const interval = table[entry.category];
        if (interval === null || interval === undefined) return null;
        if (entry.category === 'NOT_BREATHING' && entry.lastReassessed == null) {
            return (entry.timestamp != null) ? entry.timestamp : ((now != null) ? now : Date.now());
        }
        const last = (entry.lastReassessed != null) ? entry.lastReassessed
                  : (entry.timestamp != null) ? entry.timestamp
                  : (now != null) ? now : Date.now();
        return last + interval;
    }
    function reassessmentStatus(entry, now, intervals) {
        const t = now || Date.now();
        const due = nextReassessmentDue(entry, t, intervals);
        if (due === null) return { state: 'na', dueAt: null, overdueMs: 0 };
        const overdueMs = t - due;
        if (overdueMs >= 0 && entry && entry.category === 'NOT_BREATHING') return { state: 'overdue', dueAt: due, overdueMs, hcp: true };
        if (overdueMs > 0) return { state: 'overdue', dueAt: due, overdueMs };
        if (overdueMs > -2 * 60 * 1000) return { state: 'due-soon', dueAt: due, overdueMs };
        return { state: 'ok', dueAt: due, overdueMs };
    }
    function applyReassessment(entry, outcome, now) {
        const t = now || Date.now();
        const out = Object.assign({}, entry);
        out.lastReassessed = t;
        out.reassessOutcome = outcome || 'unchanged';
        out._rev = (out._rev || 0) + 1;
        return out;
    }

    // ---------- Deterioration detection ----------
    const CATEGORY_RANK = { P1: 0, P2: 1, P3: 2 };
    function categoryWorsened(prev, next) {
        if (prev === next || !next) return false;
        const terminal = ['DEAD', 'NOT_BREATHING', 'P1_HOLD'];
        if (terminal.indexOf(next) > -1) return terminal.indexOf(prev) === -1 || (prev === 'NOT_BREATHING' && next === 'DEAD');
        const rp = CATEGORY_RANK[prev], rn = CATEGORY_RANK[next];
        if (rp === undefined || rn === undefined) return false;
        return rn < rp;
    }

    // ---------- Patient timeline ----------
    // Builds a chronological timeline for a patient by combining entry-level
    // events (triage complete, reassessments, evac, handover-out) with audit
    // log rows for the same patient ID and any structured injuries.
    function buildPatientTimeline(entry, auditLog) {
        const events = [];
        if (!entry) return events;
        if (Array.isArray(entry.triageHistory) && entry.triageHistory.length) {
            for (const t of entry.triageHistory) {
                events.push({ ts: t.ts || 0, kind: 'triage', label: `${t.kind === 'retriage' ? 'Re-triage' : (t.kind === 'correction' ? 'Triage corrected' : 'Triage')}: ${categoryShort(t.category)}${t.reason ? ' — ' + t.reason : ''}`, detail: [t.tool, t.by].filter(Boolean).join(' • ') });
            }
        } else if (entry.timestamp) {
            events.push({
                ts: entry.timestamp, kind: 'triage',
                label: `Triage: ${categoryShort(entry.category)}${entry.reason ? ' — ' + entry.reason : ''}`,
                detail: entry.tool || '',
            });
        }
        if (entry.interventions) {
            for (const [k, v] of Object.entries(entry.interventions)) {
                if (v && v.ts) events.push({ ts: v.ts, kind: 'intervention', label: k, detail: v.time || '' });
            }
        }
        if (Array.isArray(entry.injuries)) {
            for (const inj of entry.injuries) {
                events.push({ ts: inj.ts || 0, kind: 'injury', label: `Injury: ${inj.side ? inj.side + ' ' : ''}${inj.region}${inj.label ? ' — ' + inj.label : ''}`, detail: inj.severity || '' });
            }
        }
        if (entry.lastReassessed) {
            events.push({ ts: entry.lastReassessed, kind: 'reassess', label: `Reassessed: ${entry.reassessOutcome || 'unchanged'}`, detail: '' });
        }
        if (Array.isArray(entry.locationHistory)) {
            for (const loc of entry.locationHistory) {
                const parts = [];
                if (loc.sector) parts.push(loc.sector);
                if (loc.landmark) parts.push(loc.landmark);
                if (loc.floor) parts.push(`Floor ${loc.floor}`);
                if (loc.area) parts.push(loc.area);
                if (loc.lat && loc.lng) parts.push(`${loc.lat}, ${loc.lng}${loc.acc ? ' ±' + loc.acc + 'm' : ''}`);
                const conf = loc.confidence ? ` (${loc.confidence})` : '';
                events.push({ ts: loc.at || loc.timestamp || 0, kind: 'location', label: `Location: ${loc.reason || loc.action || 'updated'}${conf}`, detail: parts.join(' • ') });
            }
        }
        if (Array.isArray(auditLog)) {
            for (const a of auditLog) {
                if (!a) continue;
                // Match on the permanent uid where the audit row has one (survives ID changes); else on the ID.
                if (a.patientUid ? a.patientUid !== entry.uid : a.patientId !== entry.id) continue;
                if (['TRIAGE_COMPLETE','RETRIAGE_COMPLETE','TRIAGE_CORRECTED','INTERVENTION_ADDED','INTERVENTION_REMOVED','LOCATION_UPDATE','REASSESS'].includes(a.action)) continue; // already covered by record fields
                events.push({
                    ts: a.clinTime || a.sysTime, kind: 'audit',
                    label: String(a.action || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
                    detail: a.details || '',
                });
            }
        }
        events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        return events;
    }

    // ---------- Short transfer code ----------
    // Encode a short, human-typeable code (Crockford base32) for paste fallback.
    // 6-char codes give ~1B combinations — sufficient for in-room handover.
    function shortCodeFromHash(hash) {
        const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        let n = parseInt(hash || '0', 16) >>> 0;
        let s = '';
        for (let i = 0; i < 6; i++) { s = alphabet[n % 32] + s; n = Math.floor(n / 32); }
        return s;
    }

    // Triage flow logic (TST + MITT) — pure decision functions, matching the NHS England
    // TST and NHS MITT flowcharts (April 2023). The app's question text mirrors the cards.
    function tstNext(stepId, answer) {
        const flow = {
            walking: { yes: { type: 'result', category: 'P3', reason: 'Walking' }, no: { type: 'next', step: 'bleeding' } },
            bleeding: { yes: { type: 'result', category: 'P1', reason: 'Severe Bleeding' }, no: { type: 'next', step: 'talking' } },
            talking: { yes: { type: 'next', step: 'penetrating' }, no: { type: 'next', step: 'breathing' } },
            penetrating: { yes: { type: 'result', category: 'P1', reason: 'Penetrating Injury' }, no: { type: 'result', category: 'P2', reason: 'Talking, No Penetrating Injury' } },
            breathing: { yes: { type: 'result', category: 'P1', reason: 'Not Talking, Breathing' }, no: { type: 'result', category: 'NOT_BREATHING', reason: 'Not Breathing' } },
        };
        if (!flow[stepId]) return null;
        return answer ? flow[stepId].yes : flow[stepId].no;
    }
    function mittNext(stepId, answer) {
        const flow = {
            cat_bleed: { yes: { type: 'result', category: 'P1', reason: 'Catastrophic Bleeding' }, no: { type: 'next', step: 'walking' } },
            walking: { yes: { type: 'result', category: 'P3', reason: 'Walking' }, no: { type: 'next', step: 'breathing' } },
            breathing: { yes: { type: 'next', step: 'voice' }, no: { type: 'result', category: 'DEAD', reason: 'Not Breathing' } },
            voice: { yes: { type: 'next', step: 'age' }, no: { type: 'result', category: 'P1', reason: 'Does Not Respond to Voice' } },
            age: { yes: { type: 'next', step: 'rr' }, no: { type: 'result', category: 'P1', reason: 'Aged 2 or Under' } },
            rr: { yes: { type: 'next', step: 'hr' }, no: { type: 'result', category: 'P1', reason: 'Breathing Rate Outside 12-23' } },
            // Card: "Heart Rate 100 or More" — YES -> P1, NO -> P2.
            hr: { yes: { type: 'result', category: 'P1', reason: 'Heart Rate 100 or More' }, no: { type: 'result', category: 'P2', reason: 'Heart Rate Under 100' } },
        };
        if (!flow[stepId]) return null;
        return answer ? flow[stepId].yes : flow[stepId].no;
    }

    // ---------- SHA-256 (audit hash chain) ----------
    function utf8Bytes(str) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(str));
        const s = unescape(encodeURIComponent(String(str)));
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }
    const _SHA_K = (() => {
        const k = [], primes = [];
        for (let n = 2; primes.length < 64; n++) { if (primes.every(p => n % p)) primes.push(n); }
        primes.forEach(p => k.push((Math.cbrt(p) % 1) * 4294967296 >>> 0));
        return { k, h: primes.slice(0, 8).map(p => (Math.sqrt(p) % 1) * 4294967296 >>> 0) };
    })();
    function sha256Hex(str) {
        const bytes = utf8Bytes(str);
        const l = bytes.length;
        const total = ((l + 9 + 63) >> 6) << 6;
        const m = new Uint8Array(total);
        m.set(bytes); m[l] = 0x80;
        const bitsHi = Math.floor(l / 0x20000000), bitsLo = (l << 3) >>> 0;
        m[total - 8] = (bitsHi >>> 24) & 255; m[total - 7] = (bitsHi >>> 16) & 255; m[total - 6] = (bitsHi >>> 8) & 255; m[total - 5] = bitsHi & 255;
        m[total - 4] = (bitsLo >>> 24) & 255; m[total - 3] = (bitsLo >>> 16) & 255; m[total - 2] = (bitsLo >>> 8) & 255; m[total - 1] = bitsLo & 255;
        const H = _SHA_K.h.slice(), K = _SHA_K.k, W = new Array(64);
        const rotr = (x, n) => (x >>> n) | (x << (32 - n));
        for (let off = 0; off < total; off += 64) {
            for (let i = 0; i < 16; i++) W[i] = ((m[off + i*4] << 24) | (m[off + i*4 + 1] << 16) | (m[off + i*4 + 2] << 8) | m[off + i*4 + 3]) >>> 0;
            for (let i = 16; i < 64; i++) {
                const s0 = rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3);
                const s1 = rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10);
                W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
            }
            let [a, b, c, d, e, f, g, h] = H;
            for (let i = 0; i < 64; i++) {
                const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                const ch = (e & f) ^ (~e & g);
                const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
                const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const t2 = (S0 + maj) >>> 0;
                h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
            }
            H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
            H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
        }
        return H.map(x => ('00000000' + x.toString(16)).slice(-8)).join('');
    }

    // ---------- Tamper-evident audit log ----------
    // Each entry carries seq, prevHash and hash = SHA-256(canonical entry without hash).
    // Editing, deleting or reordering any stored entry breaks the chain from that point.
    // (Evidence of tampering, not prevention: record the head hash externally — it is printed on every export.)
    const AUDIT_GENESIS = '0'.repeat(64);
    function sealAuditEntry(entry, prev) {
        const e = jsonClone(entry) || {};
        delete e.hash;
        e.seq = prev ? (prev.seq || 0) + 1 : 1;
        e.prevHash = prev ? prev.hash : AUDIT_GENESIS;
        e.hash = sha256Hex(canonicalJSON(e));
        return e;
    }
    function verifyAuditChain(entries) {
        const list = Array.isArray(entries) ? entries : [];
        let prev = null;
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            const why = (reason) => ({ ok: false, count: list.length, verified: i, brokenAt: i, brokenSeq: e && e.seq, reason, headHash: list.length ? list[list.length - 1].hash : AUDIT_GENESIS });
            if (!e || !e.hash) return why('entry has no hash');
            if (e.seq !== (prev ? prev.seq + 1 : 1)) return why('sequence gap or reordering');
            if (e.prevHash !== (prev ? prev.hash : AUDIT_GENESIS)) return why('previous-hash link broken');
            const copy = Object.assign({}, e); delete copy.hash;
            if (sha256Hex(canonicalJSON(copy)) !== e.hash) return why('entry content altered');
            prev = e;
        }
        return { ok: true, count: list.length, verified: list.length, headHash: prev ? prev.hash : AUDIT_GENESIS };
    }
    // Seal pre-existing (unchained) entries once, preserving their content and marking them legacy.
    function sealLegacyAudit(entries) {
        const out = [];
        (entries || []).forEach(e => { out.push(sealAuditEntry(Object.assign({}, e, { legacyUnsealed: true }), out[out.length - 1] || null)); });
        return out;
    }
    function auditKey(a) {
        if (!a) return '';
        if (a.deviceId && a.seq && a.hash) return `${a.deviceId}|${a.seq}|${a.hash}`;
        return [a.sysTime, a.user, a.action, a.patientId, a.details].join('|');
    }
    // Other devices' audit rows are kept separately (they have their own chains) and de-duplicated.
    function mergeImportedAudit(existing, incoming, source) {
        const out = (existing || []).slice();
        const seen = new Set(out.map(auditKey));
        let added = 0;
        (incoming || []).forEach(a => {
            if (!a || typeof a !== 'object') return;
            const k = auditKey(a);
            if (seen.has(k)) return;
            seen.add(k);
            out.push(Object.assign({}, jsonClone(a), { importedVia: source || '' }));
            added++;
        });
        return { list: out, added };
    }

    // ---------- Export helpers ----------
    // CSV cell with formula-injection guard (cells starting = + - @ tab CR are prefixed with ').
    function csvCell(v) {
        if (v === undefined || v === null) return '""';
        let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
    }
    // Unambiguous local timestamp with UTC offset, e.g. 2026-09-25T14:03:22.123+01:00
    function isoWithOffset(ts) {
        const n = _num(ts);
        if (n === null) return '';
        const d = new Date(n);
        const off = -d.getTimezoneOffset();
        const p = (x, w) => String(Math.abs(x)).padStart(w || 2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
    }

    // ---------- Legacy data migration ----------
    // Brings records saved by older versions up to date. Returns audit events describing every change.
    function migrateLegacyRecords(list, ctx) {
        ctx = ctx || {};
        const events = [];
        const records = (list || []).map(r => {
            const e = Object.assign({}, r);
            if (!e.uid) { e.uid = makeUid(); events.push({ action: 'RECORD_MIGRATED', patientId: e.id, details: 'Assigned permanent record uid (upgrade from earlier version)' }); }
            if (!e.createdAt) e.createdAt = e.timestamp || ctx.now || Date.now();
            if (!e.createdBy) e.createdBy = e.triager || '';
            if (!e.fts) e.fts = {};
            if (!Array.isArray(e.triageHistory) || !e.triageHistory.length) e.triageHistory = e.category ? [{ ts: e.timestamp || e.createdAt, category: e.category, reason: e.reason || '', action: e.action || '', tool: e.tool || '', by: e.triager || '', kind: 'triage' }] : [];
            if (e.category === 'DEAD' && e.tool === 'TST') {
                e.category = 'NOT_BREATHING';
                events.push({ action: 'CATEGORY_MIGRATED', patientId: e.id, details: 'TST outcome relabelled DEAD -> Not Breathing (NHS England labelling: Dead is MITT only). Needs healthcare reassessment.' });
            }
            return e;
        });
        const counts = {};
        records.forEach(r => { counts[r.id] = (counts[r.id] || 0) + 1; });
        Object.keys(counts).filter(id => counts[id] > 1).forEach(id => {
            events.push({ action: 'DUPLICATE_ID_FOUND', patientId: id, details: `${counts[id]} stored records share this ID (earlier version could reuse IDs). All are now shown — review each.` });
        });
        return { records, events };
    }

    const api = {
        QR_SCHEMA_VERSION, QR_DEFAULT_TTL_MS, QR_MAX_FUTURE_SKEW_MS,
        BODYMAP_VIEWBOX, BULK_QR_SOFT_LIMIT, ALL_QR_CHUNK_SOFT_LIMIT, ALL_TRANSFER_SCHEMA_VERSION, ALL_PATIENT_FIELD_ORDER, REASSESS_INTERVALS, CATEGORY_RANK,
        escapeHTML, fnv1a, canonicalJSON, buildPatientPayload, decompressData,
        validatePatientWrapper, mergePatientRecords, buildAckPayload,
        tstNext, mittNext,
        classifyBodymapPoint, buildInjuryMark, injuriesToText, sanitiseInjuries,
        buildBulkPayload, validateBulkWrapper, bulkPayloadFits,
        clonePatientRecord, buildAllPatientsPayload, validateAllPatientsWrapper,
        buildAllPatientsChunks, validateAllPatientChunk, reassembleAllPatientChunks,
        buildAllPatientsTransfer, mergeAllPatientRecords,
        normaliseLocation, compactLocation, expandCompactLocation, selectBestLocationFix, classifyLocationAccuracy,
        formatLocationAge, appendLocationHistory, mergeLocationHistory, mergeLocationFieldsInto, distanceMeters,
        similarityScore, findDuplicateCandidates,
        nextReassessmentDue, reassessmentStatus, applyReassessment,
        categoryWorsened, buildPatientTimeline, shortCodeFromHash,
        CATEGORIES, CATEGORY_INFO, PATIENT_QR_MAX_CHARS, PATIENT_QR_LOCATION_HISTORY_MAX, AUDIT_GENESIS,
        isValidCategory, categoryShort, categoryLabel, toAsciiJSON, makeUid, makeDeviceCode, nextAutoId,
        sanitisePatientRecord, sanitiseInterventions, mergePatientRecordsDetailed, matchIncomingRecord, collisionSafeId,
        resolveCategoryMerge, mergeNotesText, buildTransferAckPayload, verifyAckIntegrity,
        reassembleChunkBody, reassembleAllPatientChunksAsync, buildAllPatientsTransferAsync,
        encodeTransportText, decodeTransportText, isCompressedTransport, compressionSupported, bytesToBase64, base64ToBytes,
        sha256Hex, sealAuditEntry, verifyAuditChain, sealLegacyAudit, mergeImportedAudit, auditKey,
        csvCell, isoWithOffset, migrateLegacyRecords,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.MITTLib = api;
    }
})(typeof self !== 'undefined' ? self : this);
