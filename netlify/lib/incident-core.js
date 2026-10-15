// Incident commander backend, independent of Netlify so it can be tested in plain Node.
// The store is any object with get(key) -> value | null, set(key, value), delete(key), list(prefix) -> [entries].
// list() returns either plain keys or { key, etag } objects (Netlify Blobs gives an etag per blob; the in-memory
// store derives one from the content). The etags are what tell a commander screen whether anything changed.
// Every value is a plain JSON object. Keys: i/<CODE>/meta, i/<CODE>/r/<uid>, i/<CODE>/d/<deviceId>, rl/<client>.
'use strict';
const crypto = require('crypto');
const lib = require('../../lib.js');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const CODE_LENGTH = 6;
const PIN_LENGTH = 6;
const TTL_MS = 24 * 60 * 60 * 1000;          // an incident is deleted 24 h after its last write
const MAX_BODY_BYTES = 512 * 1024;
const MAX_RECORDS_PER_PUSH = 250;
const MAX_RECORDS_PER_INCIDENT = 3000;
const MAX_DEVICES_PER_INCIDENT = 200;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 25;                 // wrong PINs per client per window
const STALE_DEVICE_MS = 5 * 60 * 1000;
const READ_BATCH = 25;                        // blobs fetched at once when the commander screen reads
const METHANE_FIELD_MAX = 600;
const ORDER = { P1: 0, P1_HOLD: 1, P2: 2, P3: 3, NOT_BREATHING: 4, DEAD: 5 };

function randomCode(rng) {
    const bytes = rng(CODE_LENGTH);
    let s = '';
    for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return s;
}
function randomPin(rng) {
    const bytes = rng(PIN_LENGTH);
    let s = '';
    for (let i = 0; i < PIN_LENGTH; i++) s += String(bytes[i] % 10);
    return s;
}
function normaliseCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH); }
function normalisePin(v) { return String(v || '').replace(/\D/g, '').slice(0, PIN_LENGTH); }
function hashPin(salt, pin) { return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex'); }
function safeEqual(a, b) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}
function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : (v === undefined || v === null ? '' : String(v).slice(0, max)); }
function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
function shortHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }
// list() entries as { key, etag } whatever the store returned.
function entries(list) { return (list || []).map(x => typeof x === 'string' ? { key: x, etag: '' } : { key: String(x.key || ''), etag: String(x.etag || '') }).filter(x => x.key); }
async function getMany(store, keys) {
    const out = [];
    for (let i = 0; i < keys.length; i += READ_BATCH) {
        const got = await Promise.all(keys.slice(i, i + READ_BATCH).map(k => store.get(k)));
        got.forEach(v => { if (v) out.push(v); });
    }
    return out;
}
// METHANE as the phones store it: seven short texts plus who saved it and when.
function cleanMethane(m) {
    if (!m || typeof m !== 'object') return null;
    const out = { m: str(m.m, METHANE_FIELD_MAX), e: str(m.e, METHANE_FIELD_MAX), t: str(m.t, METHANE_FIELD_MAX), h: str(m.h, METHANE_FIELD_MAX), a: str(m.a, METHANE_FIELD_MAX), n: str(m.n, METHANE_FIELD_MAX), e_svc: str(m.e_svc, METHANE_FIELD_MAX), timestamp: num(m.timestamp), by: str(m.by, 80), device: str(m.device, 16) };
    if (!out.timestamp || !['m', 'e', 't', 'h', 'a', 'n', 'e_svc'].some(k => out[k].trim())) return null;
    return out;
}

function createCore(opts) {
    opts = opts || {};
    const store = opts.store;
    const now = opts.now || (() => Date.now());
    const rng = opts.random || ((n) => crypto.randomBytes(n));
    const log = opts.log || (() => {});

    const keyMeta = (code) => `i/${code}/meta`;
    const keyRec = (code, uid) => `i/${code}/r/${uid}`;
    const keyDev = (code, id) => `i/${code}/d/${id}`;
    const keyRate = (client) => `rl/${shortHash(client)}`;   // the client address itself is never stored

    function reply(status, body, headers) { return { status, body, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}) }; }
    function error(status, code, message) { return reply(status, { error: code, message }); }

    // Wrong-PIN lock-out lives in the store, so it survives a cold start and is shared by every server copy.
    // A store failure never locks anyone out, and never lets a flood through either: the in-memory copy is the fallback.
    const failures = new Map(); // client -> { count, since }
    async function readFailures(client) {
        let f = failures.get(client) || null;
        try { const s = await store.get(keyRate(client)); if (s && (!f || (s.count || 0) > f.count)) f = { count: s.count || 0, since: s.since || 0 }; } catch (e) {}
        if (f && now() - f.since > RATE_WINDOW_MS) f = null;
        return f;
    }
    async function tooManyFailures(client) {
        const f = await readFailures(client);
        return !!f && f.count >= RATE_MAX_FAILURES;
    }
    async function noteFailure(client) {
        const cur = await readFailures(client);
        const f = cur ? { count: cur.count + 1, since: cur.since } : { count: 1, since: now() };
        failures.set(client, f);
        try { await store.set(keyRate(client), f); } catch (e) {}
    }

    async function deleteIncident(code) {
        const keys = entries(await store.list(`i/${code}/`)).map(e => e.key);
        for (const k of keys) await store.delete(k);
        return keys.length;
    }
    async function loadMeta(code) {
        const meta = await store.get(keyMeta(code));
        if (!meta) return null;
        if (now() - meta.updatedAt > TTL_MS) { await deleteIncident(code); log('expired', code); return 'expired'; }
        return meta;
    }
    // Returns {meta, viewOnly} or an error reply. The view-only PIN (if the incident has one) can only read.
    async function authed(code, pin, client, allowViewOnly) {
        if (!code) return error(404, 'not_found', 'No such incident.');
        if (await tooManyFailures(client)) return error(429, 'rate_limited', 'Too many wrong PINs. Try again in 15 minutes.');
        const meta = await loadMeta(code);
        if (meta === 'expired') return error(410, 'expired', 'This incident has expired and its data has been deleted.');
        if (!meta) { await noteFailure(client); return error(404, 'not_found', 'No such incident.'); }
        if (pin && safeEqual(hashPin(meta.salt, pin), meta.pinHash)) return { meta, viewOnly: false };
        if (pin && meta.viewHash && safeEqual(hashPin(meta.salt, pin), meta.viewHash)) {
            if (allowViewOnly) return { meta, viewOnly: true };
            return error(403, 'view_only', 'That is the view-only PIN. It can open the commander screen but not send or change anything.');
        }
        await noteFailure(client);
        return error(401, 'bad_pin', 'Wrong PIN.');
    }

    function cleanRecord(raw) {
        const s = lib.sanitisePatientRecord(raw);
        if (!s || !s.uid || !/^[A-Za-z0-9_-]{1,64}$/.test(s.uid) || !s.id || !s.category) return null;
        const rec = lib.clonePatientRecord(s);
        rec.uid = s.uid; rec.id = s.id;
        rec.updatedAt = s.updatedAt || s.timestamp || now();
        return rec;
    }

    async function create(body, client) {
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        let code = '';
        for (let i = 0; i < 5; i++) { code = randomCode(rng); if (!(await store.get(keyMeta(code)))) break; code = ''; }
        if (!code) return error(503, 'no_code', 'Could not allocate an incident code. Try again.');
        const pin = randomPin(rng);
        let viewPin = randomPin(rng);
        if (viewPin === pin) viewPin = String((Number(pin) + 1) % 1000000).padStart(PIN_LENGTH, '0');
        const salt = crypto.randomBytes(8).toString('hex');
        const t = now();
        const meta = { code, salt, pinHash: hashPin(salt, pin), viewHash: hashPin(salt, viewPin), name: str(body.name, 80), incidentCode: lib.normaliseIncidentCode(body.incidentCode), training: !!body.training, createdAt: t, updatedAt: t, createdBy: { deviceId, triager: str(body.triager, 80) }, ccs: null, methane: null, seq: 1 };
        await store.set(keyMeta(code), meta);
        await store.set(keyDev(code, deviceId), { deviceId, triager: str(body.triager, 80), role: 'creator', joinedAt: t, lastSeen: t, records: 0, app: str(body.app, 40) });
        log('created', code, client);
        return reply(201, { code, pin, viewPin, createdAt: t, expiresAt: t + TTL_MS, ttlMs: TTL_MS });
    }

    async function join(code, pin, body, client) {
        const a = await authed(code, pin, client);
        if (a.status) return a;
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        const existing = await store.get(keyDev(code, deviceId));
        if (!existing) {
            const devs = entries(await store.list(`i/${code}/d/`));
            if (devs.length >= MAX_DEVICES_PER_INCIDENT) return error(409, 'too_many_devices', 'This incident already has the maximum number of phones.');
        }
        const t = now();
        await store.set(keyDev(code, deviceId), Object.assign({ role: 'member', joinedAt: t, records: 0 }, existing || {}, { deviceId, triager: str(body.triager, 80) || (existing && existing.triager) || '', lastSeen: t, app: str(body.app, 40) }));
        log('joined', code, deviceId);
        return reply(200, { ok: true, code, name: a.meta.name, incidentCode: a.meta.incidentCode, training: a.meta.training, createdAt: a.meta.createdAt, expiresAt: a.meta.updatedAt + TTL_MS });
    }

    async function push(code, pin, body, client) {
        const a = await authed(code, pin, client);
        if (a.status) return a;
        const meta = a.meta;
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        const incoming = Array.isArray(body.records) ? body.records : [];
        if (incoming.length > MAX_RECORDS_PER_PUSH) return error(413, 'too_many_records', `Send at most ${MAX_RECORDS_PER_PUSH} records per request.`);
        const t = now();
        let accepted = 0, kept = 0;
        const rejected = [];
        let known = null;
        for (const raw of incoming) {
            const rec = cleanRecord(raw);
            if (!rec) { rejected.push(raw && raw.uid ? String(raw.uid).slice(0, 64) : '?'); continue; }
            const cur = await store.get(keyRec(code, rec.uid));
            if (cur && (cur.updatedAt || 0) > (rec.updatedAt || 0)) { kept++; continue; } // an older copy never overwrites a newer one
            if (!cur) {
                if (known === null) known = entries(await store.list(`i/${code}/r/`)).length;
                if (known >= MAX_RECORDS_PER_INCIDENT) { rejected.push(rec.uid); continue; }
                known++;
            }
            rec.reportedBy = deviceId;
            rec.reportedAt = t;
            await store.set(keyRec(code, rec.uid), rec);
            accepted++;
        }
        if (body.ccs && num(body.ccs.lat) !== null && num(body.ccs.lng) !== null) {
            const ccs = lib.normaliseLocation(body.ccs);
            if (ccs && (!meta.ccs || (num(ccs.timestamp) || t) >= (num(meta.ccs.timestamp) || 0))) meta.ccs = Object.assign({}, ccs, { setBy: deviceId, timestamp: num(ccs.timestamp) || t });
        }
        const methane = cleanMethane(body.methane);
        const dev = (await store.get(keyDev(code, deviceId))) || { deviceId, role: 'member', joinedAt: t, records: 0 };
        dev.triager = str(body.triager, 80) || dev.triager || '';
        dev.lastSeen = t;
        dev.app = str(body.app, 40) || dev.app || '';
        dev.records = num(body.totalRecords) !== null ? Math.max(0, Math.floor(num(body.totalRecords))) : dev.records;
        dev.lastPush = incoming.length ? t : dev.lastPush || null;
        if (num(body.battery) !== null) { dev.battery = Math.max(0, Math.min(100, Math.round(num(body.battery)))); dev.charging = !!body.charging; }
        if (methane) {
            methane.device = deviceId;
            if (!methane.by) methane.by = dev.triager;
            dev.methane = methane;
            // The incident's METHANE is the newest one any phone has saved.
            if (!meta.methane || methane.timestamp >= (meta.methane.timestamp || 0)) meta.methane = methane;
        }
        await store.set(keyDev(code, deviceId), dev);
        meta.updatedAt = t;
        meta.seq = (meta.seq || 0) + 1;
        await store.set(keyMeta(code), meta);
        return reply(200, { ok: true, accepted, kept, rejected, serverTime: t, expiresAt: t + TTL_MS });
    }

    // What the commander screen has is identified by a fingerprint of the stored blobs (every record and device
    // etag plus the meta's own change counter), not by the counter alone. Two phones pushing at the same moment
    // can both write the same counter value; they cannot both leave the same set of etags behind.
    function fingerprint(meta, recs, devs) {
        const parts = [String(meta.seq || 0), String(meta.updatedAt || 0), String((meta.ccs && meta.ccs.timestamp) || 0), String((meta.methane && meta.methane.timestamp) || 0)]
            .concat(recs.map(e => e.key + '=' + e.etag), devs.map(e => e.key + '=' + e.etag));
        return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 20);
    }
    async function read(code, pin, ifNoneMatch, client, knownSeq) {
        const a = await authed(code, pin, client, true);
        if (a.status) return a;
        const meta = a.meta;
        const recEntries = entries(await store.list(`i/${code}/r/`));
        const devEntries = entries(await store.list(`i/${code}/d/`));
        const seq = fingerprint(meta, recEntries, devEntries);
        const etag = `"${seq}"`;
        // Netlify's edge rewrites the ETag it serves when it compresses the body ("2" becomes "2-df") and then drops an
        // If-None-Match that carries that suffix before the function sees it. So the page also sends the fingerprint it
        // already has in X-Incident-Seq, which the edge leaves alone; either one matching means nothing has changed.
        const givenSeq = String(ifNoneMatch || '').replace(/^W\//, '').replace(/"/g, '').split('-')[0];
        const known = String(knownSeq || '').trim();
        if ((givenSeq && givenSeq === seq) || (known && known === seq)) return { status: 304, body: null, headers: { ETag: etag, 'X-Incident-Seq': seq, 'Cache-Control': 'no-store' } };
        const t = now();
        const records = await getMany(store, recEntries.map(e => e.key));
        const devices = (await getMany(store, devEntries.map(e => e.key))).map(d => Object.assign({}, d, { stale: t - (d.lastSeen || 0) > STALE_DEVICE_MS }));
        records.sort((x, y) => ((x.category in ORDER ? ORDER[x.category] : 99) - (y.category in ORDER ? ORDER[y.category] : 99)) || (x.timestamp || 0) - (y.timestamp || 0));
        devices.sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
        log('read', code, client);
        return reply(200, { code, name: meta.name, incidentCode: meta.incidentCode, training: meta.training, createdAt: meta.createdAt, updatedAt: meta.updatedAt, expiresAt: meta.updatedAt + TTL_MS, ccs: meta.ccs, methane: meta.methane || null, viewOnly: !!a.viewOnly, hasViewPin: !!meta.viewHash, devices, records, serverTime: t, seq }, { ETag: etag, 'X-Incident-Seq': seq });
    }

    async function close(code, pin, client) {
        const a = await authed(code, pin, client);
        if (a.status) return a;
        const n = await deleteIncident(code);
        log('closed', code, client);
        return reply(200, { ok: true, deleted: n });
    }

    // Scheduled sweep: delete anything past its TTL, and lock-out counters whose window has passed.
    async function cleanup() {
        const keys = entries(await store.list('i/')).map(e => e.key);
        const codes = Array.from(new Set(keys.map(k => k.split('/')[1]).filter(Boolean)));
        let removed = 0;
        for (const c of codes) {
            const meta = await store.get(keyMeta(c));
            if (!meta || now() - meta.updatedAt > TTL_MS) { removed += await deleteIncident(c); }
        }
        let locks = 0;
        for (const k of entries(await store.list('rl/')).map(e => e.key)) {
            const f = await store.get(k);
            if (!f || now() - (f.since || 0) > RATE_WINDOW_MS) { await store.delete(k); locks++; }
        }
        return { incidents: codes.length, removedBlobs: removed, removedLocks: locks };
    }

    // Generic HTTP dispatcher: method, path (e.g. "/api/incident/ABC123/records"), headers (lower-case keys), body text, client id.
    async function handle(method, path, headers, bodyText, client) {
        headers = headers || {};
        client = client || 'unknown';
        const parts = path.replace(/^\/api\/incident\/?/, '').split('/').filter(Boolean);
        const code = parts.length ? normaliseCode(parts[0]) : '';
        const action = parts[1] || '';
        const pin = normalisePin(headers['x-incident-pin'] || '');
        if (bodyText && Buffer.byteLength(bodyText) > MAX_BODY_BYTES) return error(413, 'too_large', 'Request too large.');
        let body = {};
        if (bodyText) { try { body = JSON.parse(bodyText); } catch (e) { return error(400, 'bad_json', 'Body must be JSON.'); } }
        if (!body || typeof body !== 'object') body = {};
        try {
            if (method === 'POST' && !parts.length) return await create(body, client);
            if (method === 'GET' && parts.length === 1) return await read(code, pin, headers['if-none-match'] || '', client, headers['x-incident-seq'] || '');
            if (method === 'POST' && action === 'join') return await join(code, pin, body, client);
            if ((method === 'PUT' || method === 'POST') && action === 'records') return await push(code, pin, body, client);
            if (method === 'POST' && action === 'close') return await close(code, pin, client);
            return error(404, 'not_found', 'Unknown endpoint.');
        } catch (e) {
            log('error', e && e.message);
            return error(500, 'server_error', 'Something went wrong on the server.');
        }
    }

    return { handle, cleanup, create, join, push, read, close, deleteIncident, constants: { TTL_MS, STALE_DEVICE_MS, MAX_RECORDS_PER_PUSH, MAX_RECORDS_PER_INCIDENT, RATE_MAX_FAILURES, CODE_LENGTH, PIN_LENGTH, READ_BATCH } };
}

// Simple in-memory store (tests and local development). opts.delay (ms) or opts.jitter (ms) make every operation
// take time, so tests can interleave requests the way a real store does.
function memoryStore(opts) {
    opts = opts || {};
    const m = new Map();
    let ops = 0;
    const wait = () => { ops++; const ms = (opts.delay || 0) + (opts.jitter ? Math.random() * opts.jitter : 0); return ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve(); };
    return {
        async get(k) { await wait(); return m.has(k) ? JSON.parse(m.get(k)) : null; },
        async set(k, v) { await wait(); m.set(k, JSON.stringify(v)); },
        async delete(k) { await wait(); m.delete(k); },
        async list(prefix) { await wait(); return Array.from(m.keys()).filter(k => k.startsWith(prefix)).sort().map(k => ({ key: k, etag: crypto.createHash('sha1').update(m.get(k)).digest('hex').slice(0, 12) })); },
        size() { return m.size; },
        ops() { return ops; },
    };
}

module.exports = { createCore, memoryStore, normaliseCode, normalisePin, TTL_MS, STALE_DEVICE_MS };
