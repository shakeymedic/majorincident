// Incident commander backend, independent of Netlify so it can be tested in plain Node.
// The store is any object with get(key) -> value | null, set(key, value), delete(key), list(prefix) -> [keys].
// Every value is a plain JSON object. Keys: i/<CODE>/meta, i/<CODE>/r/<uid>, i/<CODE>/d/<deviceId>.
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

function createCore(opts) {
    opts = opts || {};
    const store = opts.store;
    const now = opts.now || (() => Date.now());
    const rng = opts.random || ((n) => crypto.randomBytes(n));
    const log = opts.log || (() => {});
    const failures = new Map(); // client -> { count, since }

    const keyMeta = (code) => `i/${code}/meta`;
    const keyRec = (code, uid) => `i/${code}/r/${uid}`;
    const keyDev = (code, id) => `i/${code}/d/${id}`;

    function reply(status, body, headers) { return { status, body, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}) }; }
    function error(status, code, message) { return reply(status, { error: code, message }); }

    function tooManyFailures(client) {
        const f = failures.get(client);
        if (!f) return false;
        if (now() - f.since > RATE_WINDOW_MS) { failures.delete(client); return false; }
        return f.count >= RATE_MAX_FAILURES;
    }
    function noteFailure(client) {
        const f = failures.get(client);
        if (!f || now() - f.since > RATE_WINDOW_MS) failures.set(client, { count: 1, since: now() });
        else f.count++;
    }

    async function deleteIncident(code) {
        const keys = await store.list(`i/${code}/`);
        for (const k of keys) await store.delete(k);
        return keys.length;
    }
    async function loadMeta(code) {
        const meta = await store.get(keyMeta(code));
        if (!meta) return null;
        if (now() - meta.updatedAt > TTL_MS) { await deleteIncident(code); log('expired', code); return 'expired'; }
        return meta;
    }
    // Returns {meta} or an error reply.
    async function authed(code, pin, client) {
        if (!code) return error(404, 'not_found', 'No such incident.');
        if (tooManyFailures(client)) return error(429, 'rate_limited', 'Too many wrong PINs. Try again in 15 minutes.');
        const meta = await loadMeta(code);
        if (meta === 'expired') return error(410, 'expired', 'This incident has expired and its data has been deleted.');
        if (!meta) { noteFailure(client); return error(404, 'not_found', 'No such incident.'); }
        if (!pin || !safeEqual(hashPin(meta.salt, pin), meta.pinHash)) { noteFailure(client); return error(401, 'bad_pin', 'Wrong PIN.'); }
        return { meta };
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
        const salt = crypto.randomBytes(8).toString('hex');
        const t = now();
        const meta = { code, salt, pinHash: hashPin(salt, pin), name: str(body.name, 80), incidentCode: lib.normaliseIncidentCode(body.incidentCode), training: !!body.training, createdAt: t, updatedAt: t, createdBy: { deviceId, triager: str(body.triager, 80) }, ccs: null, seq: 1 };
        await store.set(keyMeta(code), meta);
        await store.set(keyDev(code, deviceId), { deviceId, triager: str(body.triager, 80), role: 'creator', joinedAt: t, lastSeen: t, records: 0, app: str(body.app, 40) });
        log('created', code, client);
        return reply(201, { code, pin, createdAt: t, expiresAt: t + TTL_MS, ttlMs: TTL_MS });
    }

    async function join(code, pin, body, client) {
        const a = await authed(code, pin, client);
        if (a.status) return a;
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        const existing = await store.get(keyDev(code, deviceId));
        if (!existing) {
            const devs = await store.list(`i/${code}/d/`);
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
                if (known === null) known = (await store.list(`i/${code}/r/`)).length;
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
        const dev = (await store.get(keyDev(code, deviceId))) || { deviceId, role: 'member', joinedAt: t, records: 0 };
        dev.triager = str(body.triager, 80) || dev.triager || '';
        dev.lastSeen = t;
        dev.app = str(body.app, 40) || dev.app || '';
        dev.records = num(body.totalRecords) !== null ? Math.max(0, Math.floor(num(body.totalRecords))) : dev.records;
        dev.lastPush = incoming.length ? t : dev.lastPush || null;
        await store.set(keyDev(code, deviceId), dev);
        meta.updatedAt = t;
        meta.seq = (meta.seq || 0) + 1;
        await store.set(keyMeta(code), meta);
        return reply(200, { ok: true, accepted, kept, rejected, serverTime: t, expiresAt: t + TTL_MS });
    }

    async function read(code, pin, ifNoneMatch, client) {
        const a = await authed(code, pin, client);
        if (a.status) return a;
        const meta = a.meta;
        const etag = `"${meta.seq || 0}"`;
        if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, body: null, headers: { ETag: etag, 'Cache-Control': 'no-store' } };
        const t = now();
        const recKeys = await store.list(`i/${code}/r/`);
        const records = [];
        for (const k of recKeys) { const r = await store.get(k); if (r) records.push(r); }
        const devKeys = await store.list(`i/${code}/d/`);
        const devices = [];
        for (const k of devKeys) { const d = await store.get(k); if (d) devices.push(Object.assign({}, d, { stale: t - (d.lastSeen || 0) > STALE_DEVICE_MS })); }
        records.sort((x, y) => ((x.category in ORDER ? ORDER[x.category] : 99) - (y.category in ORDER ? ORDER[y.category] : 99)) || (x.timestamp || 0) - (y.timestamp || 0));
        devices.sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
        log('read', code, client);
        return reply(200, { code, name: meta.name, incidentCode: meta.incidentCode, training: meta.training, createdAt: meta.createdAt, updatedAt: meta.updatedAt, expiresAt: meta.updatedAt + TTL_MS, ccs: meta.ccs, devices, records, serverTime: t, seq: meta.seq || 0 }, { ETag: etag });
    }

    async function close(code, pin, client) {
        const a = await authed(code, pin, client);
        if (a.status) return a;
        const n = await deleteIncident(code);
        log('closed', code, client);
        return reply(200, { ok: true, deleted: n });
    }

    // Scheduled sweep: delete anything past its TTL.
    async function cleanup() {
        const keys = await store.list('i/');
        const codes = Array.from(new Set(keys.map(k => k.split('/')[1]).filter(Boolean)));
        let removed = 0;
        for (const c of codes) {
            const meta = await store.get(keyMeta(c));
            if (!meta || now() - meta.updatedAt > TTL_MS) { removed += await deleteIncident(c); }
        }
        return { incidents: codes.length, removedBlobs: removed };
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
            if (method === 'GET' && parts.length === 1) return await read(code, pin, headers['if-none-match'] || '', client);
            if (method === 'POST' && action === 'join') return await join(code, pin, body, client);
            if ((method === 'PUT' || method === 'POST') && action === 'records') return await push(code, pin, body, client);
            if (method === 'POST' && action === 'close') return await close(code, pin, client);
            return error(404, 'not_found', 'Unknown endpoint.');
        } catch (e) {
            log('error', e && e.message);
            return error(500, 'server_error', 'Something went wrong on the server.');
        }
    }

    return { handle, cleanup, create, join, push, read, close, deleteIncident, constants: { TTL_MS, STALE_DEVICE_MS, MAX_RECORDS_PER_PUSH, MAX_RECORDS_PER_INCIDENT, RATE_MAX_FAILURES, CODE_LENGTH, PIN_LENGTH } };
}

// Simple in-memory store (tests and local development).
function memoryStore() {
    const m = new Map();
    return {
        async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
        async set(k, v) { m.set(k, JSON.stringify(v)); },
        async delete(k) { m.delete(k); },
        async list(prefix) { return Array.from(m.keys()).filter(k => k.startsWith(prefix)).sort(); },
        size() { return m.size; },
    };
}

module.exports = { createCore, memoryStore, normaliseCode, normalisePin, TTL_MS, STALE_DEVICE_MS };
