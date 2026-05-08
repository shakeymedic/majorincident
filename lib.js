// Pure helpers shared by the app and tests.
// IMPORTANT: keep this file dependency-free and side-effect-free.
(function (root) {
    const QR_SCHEMA_VERSION = 2;
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
        if (entry.location && entry.location.lat) short.l = { lt: entry.location.lat, lg: entry.location.lng };
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
            location: short.l ? { lat: short.l.lt, lng: short.l.lg, acc: 0 } : null,
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
            if (incoming.location) out.location = incoming.location;
            if (incoming.tool && !out.tool) out.tool = incoming.tool;
        }
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

    // ---------- Patient identity / duplicate matching ----------
    // Returns a 0..1 similarity score for two records using ID, demographics,
    // sector, category, time-of-triage and GPS proximity. Never returns 1.0
    // unless IDs match exactly; near-matches are surfaced for human review.
    function _haversine(a, b) {
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
        // Sector
        if (a.sector || b.sector) {
            used += 0.15;
            if (a.sector && b.sector && a.sector === b.sector) score += 0.15;
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
        const dist = _haversine(a.location, b.location);
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
        BODYMAP_VIEWBOX, BULK_QR_SOFT_LIMIT, REASSESS_INTERVALS, CATEGORY_RANK,
        escapeHTML, fnv1a, canonicalJSON, buildPatientPayload, decompressData,
        validatePatientWrapper, mergePatientRecords, buildAckPayload,
        tstNext, mittNext,
        classifyBodymapPoint, buildInjuryMark, injuriesToText, sanitiseInjuries,
        buildBulkPayload, validateBulkWrapper, bulkPayloadFits,
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
