// Pure helpers shared by the app and tests.
// IMPORTANT: keep this file dependency-free and side-effect-free.
(function (root) {
    const QR_SCHEMA_VERSION = 3;
    const QR_DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
    const QR_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

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
        if (Array.isArray(entry.locationHistory) && entry.locationHistory.length) short.lh = entry.locationHistory.map(compactLocationHistoryItem).filter(Boolean);
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
        return {
            id: short.i || '',
            time: short.tm || '',
            timestamp: short.ts || Date.now(),
            tool: short.tl || '',
            category: short.c || 'P3',
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
        if (meta.expiresAt && now > meta.expiresAt) return { ok: false, reason: 'QR has expired (regenerate from sender)', meta };
        if (meta.generatedAt && meta.generatedAt > now + QR_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'QR generation time is in the future (clock mismatch)', meta };
        if (!wrapper.d || typeof wrapper.d !== 'object') return { ok: false, reason: 'No patient data in payload', meta };
        const data = decompressData(wrapper.d);
        if (!data.id) return { ok: false, reason: 'Missing patient ID', meta };
        if (!['P1', 'P2', 'P3', 'DEAD'].includes(data.category)) return { ok: false, reason: 'Invalid category', meta };
        return { ok: true, data, meta };
    }

    function mergePatientRecords(local, incoming, meta) {
        const out = Object.assign({}, local);
        const incomingNewer = (meta && typeof meta.recordVersion === 'number')
            ? meta.recordVersion >= (local._rev || 0)
            : (incoming.timestamp && incoming.timestamp >= (local.timestamp || 0));
        if (incomingNewer) {
            if (incoming.category) out.category = incoming.category;
            if (incoming.action) out.action = incoming.action;
            if (incoming.reason) out.reason = incoming.reason;
            if (incoming.demos) out.demos = incoming.demos;
            if (incoming.allergies) out.allergies = incoming.allergies;
            if (incoming.sector) out.sector = incoming.sector;
            if (incoming.evacDest) out.evacDest = incoming.evacDest;
            if (incoming.evacVehicle) out.evacVehicle = incoming.evacVehicle;
            if (incoming.evacuated) out.evacuated = true;
            if (incoming.highRisk) out.highRisk = true;
            if (incoming.tool && !out.tool) out.tool = incoming.tool;
        }
        // Always preserve incoming location history, even when the incoming clinical record is older.
        mergeLocationFieldsInto(out, incoming, { preferIncoming: incomingNewer, user: meta && meta.sender, reason: incomingNewer ? 'import-merge' : 'import-history' });
        if (incoming.notes) {
            const tag = ` [Imported from ${meta && meta.sender ? meta.sender : (incoming.triager || 'Unknown')}: ${incoming.notes}]`;
            if (!(out.notes || '').includes(tag)) out.notes = (out.notes || '') + tag;
        }
        out.interventions = Object.assign({}, out.interventions || {});
        if (incoming.interventions) {
            for (const [k, v] of Object.entries(incoming.interventions)) {
                if (!out.interventions[k]) out.interventions[k] = v;
            }
        }
        // Union injury marks by ts; never silently overwrite local marks.
        if (Array.isArray(incoming.injuries) && incoming.injuries.length) {
            const seen = new Set((out.injuries || []).map(m => `${m.ts}|${m.region}|${m.label}`));
            const merged = (out.injuries || []).slice();
            for (const m of incoming.injuries) {
                const k = `${m.ts}|${m.region}|${m.label}`;
                if (!seen.has(k)) { merged.push(m); seen.add(k); }
            }
            out.injuries = merged;
        }
        // Take incoming reassessment if it is more recent.
        if (incoming.lastReassessed && (!out.lastReassessed || incoming.lastReassessed > out.lastReassessed)) {
            out.lastReassessed = incoming.lastReassessed;
            if (incoming.reassessOutcome) out.reassessOutcome = incoming.reassessOutcome;
        }
        out._rev = Math.max(out._rev || 0, (meta && meta.recordVersion) || 0) + 1;
        return out;
    }

    // ACK payload builder. The receiver name MUST be the local user accepting
    // receipt — never the sender's name — so that when the sender scans the
    // ACK and logs HANDOVER_ACCEPTED, the audit trail records the correct
    // identity.
    function buildAckPayload(patientId, receiverName, ctx) {
        ctx = ctx || {};
        return {
            t: 'MIT_ACK',
            v: 1,
            pid: patientId || '',
            rcv: receiverName || '',
            g: ctx.now || Date.now(),
            app: ctx.appVersion || '',
        };
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
        if (meta.expiresAt && now > meta.expiresAt) return { ok: false, reason: 'Bulk QR expired', meta };
        if (meta.generatedAt && meta.generatedAt > now + QR_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'Bulk QR generated in the future', meta };
        if (!Array.isArray(wrapper.items)) return { ok: false, reason: 'No items', meta };
        const data = wrapper.items.map(it => {
            const decoded = decompressData(it.d || {});
            decoded._rev = (it.rv || 0);
            return decoded;
        }).filter(d => d.id && ['P1','P2','P3','DEAD'].includes(d.category));
        return { ok: true, data, meta };
    }
    function bulkPayloadFits(wrapper) {
        try { return JSON.stringify(wrapper).length <= BULK_QR_SOFT_LIMIT; } catch (_) { return false; }
    }

    // ---------- Full all-patient offline transfer ----------
    const ALL_TRANSFER_SCHEMA_VERSION = 1;
    const ALL_QR_CHUNK_SOFT_LIMIT = 1200;
    const ALL_PATIENT_FIELD_ORDER = [
        'id','time','timestamp','tool','category','action','reason','triager','location','initialLocation','currentLocation','locationHistory','locationConfidence','sector','landmark','floor','area',
        'demos','allergies','notes','highRisk','interventions','evacuated','evacDest','evacVehicle',
        'injuries','lastReassessed','reassessOutcome','lastDeteriorationAt','handoverState','handoverAt','handoverTo','_rev'
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
    function selectBestLocationFix(fixes) {
        if (!Array.isArray(fixes) || !fixes.length) return null;
        let best = null;
        for (const f of fixes) {
            const n = normaliseLocation(f);
            if (!n || n.lat === undefined || n.lng === undefined) continue;
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
            app: wrapper.app || '',
            count: wrapper.n || 0,
            auditCount: Array.isArray(wrapper.audit) ? wrapper.audit.length : 0,
            integrityOk: null,
        };
        if (wrapper.h) {
            const copy = Object.assign({}, wrapper);
            const givenHash = copy.h;
            delete copy.h;
            meta.integrityOk = (fnv1a(canonicalJSON(copy)) === givenHash);
            if (!meta.integrityOk) return { ok: false, reason: 'All-patient payload integrity check failed', meta };
        }
        const now = ctx.now || Date.now();
        if (meta.expiresAt && now > meta.expiresAt) return { ok: false, reason: 'All-patient transfer expired', meta };
        if (meta.generatedAt && meta.generatedAt > now + QR_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'All-patient transfer generated in the future', meta };
        if (!Array.isArray(wrapper.patients)) return { ok: false, reason: 'No patients in transfer', meta };
        const data = wrapper.patients.map(clonePatientRecord).filter(d => d.id && ['P1','P2','P3','DEAD'].includes(d.category));
        if (data.length !== wrapper.patients.length) return { ok: false, reason: 'One or more patients are missing ID or valid category', meta, data };
        return { ok: true, data, audit: Array.isArray(wrapper.audit) ? wrapper.audit.map(jsonClone).filter(Boolean) : [], incident: wrapper.incident || {}, meta };
    }

    function buildAllPatientsChunks(payload, opts) {
        opts = opts || {};
        const maxChars = Math.max(400, opts.maxChars || ALL_QR_CHUNK_SOFT_LIMIT);
        const body = (typeof payload === 'string') ? payload : JSON.stringify(payload);
        const transferId = (payload && payload.transferId) || fnv1a(body);
        const payloadHash = fnv1a(body);
        const generatedAt = (payload && payload.g) || Date.now();
        const expiresAt = (payload && payload.x) || (generatedAt + QR_DEFAULT_TTL_MS);
        const sender = (payload && payload.sndr) || '';
        const app = (payload && payload.app) || '';
        const overheadSample = { t:'MIT_ALL_CHUNK', v:1, transferId, totalChunks:999, chunkIndex:999, g:generatedAt, x:expiresAt, sndr:sender, app, payloadHash, chunkHash:'12345678', data:'' };
        const overhead = JSON.stringify(overheadSample).length + 32;
        const sliceSize = Math.max(100, maxChars - overhead);
        const total = Math.max(1, Math.ceil(body.length / sliceSize));
        const chunks = [];
        for (let i = 0; i < total; i++) {
            const data = body.slice(i * sliceSize, (i + 1) * sliceSize);
            const chunk = { t:'MIT_ALL_CHUNK', v:1, transferId, totalChunks:total, chunkIndex:i, g:generatedAt, x:expiresAt, sndr:sender, app, payloadHash, chunkHash:fnv1a(data), data };
            chunk.h = fnv1a(canonicalJSON(chunk));
            chunks.push(chunk);
        }
        return chunks;
    }

    function validateAllPatientChunk(chunk, ctx) {
        ctx = ctx || {};
        if (!chunk || typeof chunk !== 'object') return { ok:false, reason:'Invalid chunk' };
        if (chunk.t !== 'MIT_ALL_CHUNK') return { ok:false, reason:'Not an all-patient chunk' };
        const meta = {
            transferId: chunk.transferId || '', totalChunks: chunk.totalChunks || 0, chunkIndex: chunk.chunkIndex,
            generatedAt: chunk.g || null, expiresAt: chunk.x || null, sender: chunk.sndr || '', app: chunk.app || '',
            payloadHash: chunk.payloadHash || '', chunkHash: chunk.chunkHash || '', integrityOk: null
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
        const now = ctx.now || Date.now();
        if (meta.expiresAt && now > meta.expiresAt) return { ok:false, reason:'All-patient chunk expired', meta };
        if (meta.generatedAt && meta.generatedAt > now + QR_MAX_FUTURE_SKEW_MS) return { ok:false, reason:'All-patient chunk generated in the future', meta };
        return { ok:true, chunk, meta };
    }

    function reassembleAllPatientChunks(chunks, ctx) {
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
        const total = firstMeta ? firstMeta.totalChunks : 0;
        if (!firstMeta) return { ok:false, reason:'No chunks scanned', received:0, total:0 };
        if (seen.size < total) {
            const missing = []; for (let i=0;i<total;i++) if (!seen.has(i)) missing.push(i);
            return { ok:false, incomplete:true, reason:`Need ${total - seen.size} more chunk(s)`, received:seen.size, total, missing, meta:firstMeta };
        }
        let body = '';
        for (let i=0; i<total; i++) body += seen.get(i).data;
        if (fnv1a(body) !== firstMeta.payloadHash) return { ok:false, reason:'Overall transfer checksum failed', received:seen.size, total, meta:firstMeta };
        let payload;
        try { payload = JSON.parse(body); } catch (_) { return { ok:false, reason:'Reassembled payload is not valid JSON', received:seen.size, total, meta:firstMeta }; }
        const valid = validateAllPatientsWrapper(payload, ctx);
        if (!valid.ok) return Object.assign({ received:seen.size, total }, valid);
        valid.received = seen.size; valid.total = total;
        return valid;
    }

    function buildAllPatientsTransfer(entries, opts, ctx) {
        opts = opts || {}; ctx = ctx || {};
        const payload = buildAllPatientsPayload(entries, opts, ctx);
        const text = JSON.stringify(payload);
        const maxChars = opts.maxChars || ALL_QR_CHUNK_SOFT_LIMIT;
        if (text.length <= maxChars) return { mode:'single', payload, text, chunks:[], transferId:payload.transferId, totalChunks:1, byteLength:text.length };
        const chunks = buildAllPatientsChunks(payload, { maxChars });
        return { mode:'chunked', payload, text, chunks, transferId:payload.transferId, totalChunks:chunks.length, byteLength:text.length };
    }

    function mergeAllPatientRecords(existingList, incomingList, meta) {
        const records = (existingList || []).map(clonePatientRecord);
        let imported = 0, merged = 0;
        const nearDuplicates = [];
        for (const incoming of (incomingList || [])) {
            const idx = records.findIndex(e => e.id === incoming.id);
            const recordMeta = Object.assign({}, meta || {}, { recordVersion: incoming._rev || (meta && meta.recordVersion) || 0 });
            if (idx > -1) {
                records[idx] = mergePatientRecords(records[idx], incoming, recordMeta);
                merged++;
            } else {
                const cands = findDuplicateCandidates(incoming, records, { threshold: 0.7 });
                if (cands.length) nearDuplicates.push({ incoming, candidates: cands });
                const entry = clonePatientRecord(incoming);
                entry._rev = (incoming._rev || 0) + 1;
                records.push(entry);
                imported++;
            }
        }
        return { records, imported, merged, nearDuplicates };
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
        return used > 0 ? score / used : 0;
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
    // Default intervals (ms): P1 = 10 min, P2 = 30 min, P3 = 60 min.
    const REASSESS_INTERVALS = { P1: 10*60*1000, P2: 30*60*1000, P3: 60*60*1000, DEAD: null };
    function nextReassessmentDue(entry, now) {
        if (!entry) return null;
        const interval = REASSESS_INTERVALS[entry.category];
        if (!interval) return null;
        const last = (entry.lastReassessed != null) ? entry.lastReassessed
                  : (entry.timestamp != null) ? entry.timestamp
                  : (now != null) ? now : Date.now();
        return last + interval;
    }
    function reassessmentStatus(entry, now) {
        const t = now || Date.now();
        const due = nextReassessmentDue(entry, t);
        if (due === null) return { state: 'na', dueAt: null, overdueMs: 0 };
        const overdueMs = t - due;
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
    // Categories ordered most-acute first. P1 < P2 < P3; DEAD treated separately.
    const CATEGORY_RANK = { P1: 0, P2: 1, P3: 2, DEAD: -1 };
    function categoryWorsened(prev, next) {
        if (prev === next) return false;
        if (next === 'DEAD' && prev !== 'DEAD') return true;
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
        if (entry.timestamp) {
            events.push({
                ts: entry.timestamp, kind: 'triage',
                label: `Triage: ${entry.category}${entry.reason ? ' — ' + entry.reason : ''}`,
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
                if (!a || a.patientId !== entry.id) continue;
                if (['TRIAGE_COMPLETE','INTERVENTION_ADDED','INTERVENTION_REMOVED'].includes(a.action)) continue; // already covered
                events.push({
                    ts: a.clinTime || a.sysTime, kind: 'audit',
                    label: a.action.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
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

    // Triage flow logic (TST + MITT) — pure decision functions for tests
    function tstNext(stepId, answer) {
        const flow = {
            walking: { yes: { type: 'result', category: 'P3', reason: 'Walking' }, no: { type: 'next', step: 'bleeding' } },
            bleeding: { yes: { type: 'result', category: 'P1', reason: 'Catastrophic Bleeding' }, no: { type: 'next', step: 'talking' } },
            talking: { yes: { type: 'next', step: 'penetrating' }, no: { type: 'next', step: 'breathing' } },
            penetrating: { yes: { type: 'result', category: 'P1', reason: 'Penetrating Trauma' }, no: { type: 'result', category: 'P2', reason: 'Casualty Not Walking' } },
            breathing: { yes: { type: 'result', category: 'P1', reason: 'Unconscious - Breathing' }, no: { type: 'result', category: 'DEAD', reason: 'Apnoeic' } },
        };
        if (!flow[stepId]) return null;
        return answer ? flow[stepId].yes : flow[stepId].no;
    }
    function mittNext(stepId, answer) {
        const flow = {
            cat_bleed: { yes: { type: 'result', category: 'P1', reason: 'Catastrophic Bleeding' }, no: { type: 'next', step: 'walking' } },
            walking: { yes: { type: 'result', category: 'P3', reason: 'Walking' }, no: { type: 'next', step: 'breathing' } },
            breathing: { yes: { type: 'next', step: 'voice' }, no: { type: 'result', category: 'DEAD', reason: 'Apnoeic' } },
            voice: { yes: { type: 'next', step: 'age' }, no: { type: 'result', category: 'P1', reason: 'Unresponsive to Voice' } },
            age: { yes: { type: 'next', step: 'rr' }, no: { type: 'result', category: 'P1', reason: 'Age < 2' } },
            rr: { yes: { type: 'next', step: 'hr' }, no: { type: 'result', category: 'P1', reason: 'RR outside 12-23' } },
            hr: { yes: { type: 'result', category: 'P2', reason: 'Stable Physiology' }, no: { type: 'result', category: 'P1', reason: 'Tachycardia > 100' } },
        };
        if (!flow[stepId]) return null;
        return answer ? flow[stepId].yes : flow[stepId].no;
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
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.MITTLib = api;
    }
})(typeof self !== 'undefined' ? self : this);
