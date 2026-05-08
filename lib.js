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
            evacVehicle: short.evv || ''
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
        escapeHTML, fnv1a, canonicalJSON, buildPatientPayload, decompressData,
        validatePatientWrapper, mergePatientRecords, buildAckPayload,
        tstNext, mittNext,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.MITTLib = api;
    }
})(typeof self !== 'undefined' ? self : this);
