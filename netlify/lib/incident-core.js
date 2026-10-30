// Incident commander backend, independent of Netlify so it can be tested in plain Node.
// The store is any object with get(key) -> value | null, set(key, value), delete(key), list(prefix) -> [entries].
// list() returns either plain keys or { key, etag } objects (Netlify Blobs gives an etag per blob; the in-memory
// store derives one from the content). The etags are what tell a commander screen whether anything changed.
// Every value is a plain JSON object. Keys: i/<CODE>/meta, i/<CODE>/r/<uid>, i/<CODE>/d/<deviceId>,
// i/<CODE>/policy and i/<CODE>/marks (commander decisions, kept apart from the meta so a phone's report can never
// write an older copy back over them), i/<CODE>/dc/<deviceId> (a call for help cleared by the commander),
// t/<CODE> (an ended incident's tombstone), rl/<client>, rc/<client> (incidents created), rk/<CODE> (wrong PINs per incident).
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
// A wrong code and a wrong PIN get the same reply, so the reply does not say whether an incident exists.
// An incident that has ended leaves a tombstone for two days, so its phones and screens are told "ended".
const BAD_ACCESS_MSG = 'That code and PIN do not open a running incident. Check both and try again.';
const ENDED_MSG = 'This incident has ended. Its shared data has been deleted.';
const EXPIRED_MSG = 'This incident has expired (24 hours with no new information) and its shared data has been deleted.';
const TOMBSTONE_MS = 48 * 60 * 60 * 1000;
const RATE_MAX_FAILURES = 25;                 // wrong PINs per client per window
const CODE_MAX_FAILURES = 100;                // wrong PINs per incident per window, from anyone without that incident's key
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const CREATE_MAX = 10;                        // incidents created per client per hour
const CLOCK_SKEW_MS = 60 * 1000;              // phone clocks further out than this are corrected
const STALE_DEVICE_MS = 5 * 60 * 1000;
const READ_BATCH = 25;                        // blobs fetched at once when the commander screen reads
const METHANE_FIELD_MAX = 600;
const MAX_LOOKUP_RESULTS = 5;
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
// A phone's own position as sent with a report: latitude, longitude, accuracy (m) and when the fix was taken.
function cleanPosition(p, t) {
    if (!p || typeof p !== 'object') return null;
    const lat = num(p.lat), lng = num(p.lng);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const out = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), timestamp: num(p.timestamp) || t, at: t };
    const acc = num(p.acc !== undefined ? p.acc : p.accuracy);
    if (acc !== null && acc >= 0) out.acc = Math.round(acc);
    return out;
}
function shortHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }
// list() entries as { key, etag } whatever the store returned.
function entries(list) { return (list || []).map(x => typeof x === 'string' ? { key: x, etag: '' } : { key: String(x.key || ''), etag: String(x.etag || '') }).filter(x => x.key); }
// Values for these keys, in the same order (null where missing). Uses the store's own bulk read when it has one
// (Firestore: one request per few hundred documents), otherwise READ_BATCH single reads at a time.
async function getEach(store, keys) {
    if (typeof store.getMany === 'function') return store.getMany(keys);
    const out = [];
    for (let i = 0; i < keys.length; i += READ_BATCH) out.push(...await Promise.all(keys.slice(i, i + READ_BATCH).map(k => store.get(k))));
    return out;
}
async function getMany(store, keys) { return (await getEach(store, keys)).filter(Boolean); }
async function setEach(store, entries) {
    if (typeof store.setMany === 'function') return store.setMany(entries);
    for (let i = 0; i < entries.length; i += READ_BATCH) await Promise.all(entries.slice(i, i + READ_BATCH).map(([k, v]) => store.set(k, v)));
}
async function deleteEach(store, keys) {
    if (typeof store.deleteMany === 'function') return store.deleteMany(keys);
    for (let i = 0; i < keys.length; i += READ_BATCH) await Promise.all(keys.slice(i, i + READ_BATCH).map(k => store.delete(k)));
}
// METHANE as the phones store it: seven short texts plus who saved it and when.
function cleanMethane(m) {
    if (!m || typeof m !== 'object') return null;
    const out = { m: str(m.m, METHANE_FIELD_MAX), e: str(m.e, METHANE_FIELD_MAX), t: str(m.t, METHANE_FIELD_MAX), h: str(m.h, METHANE_FIELD_MAX), a: str(m.a, METHANE_FIELD_MAX), n: str(m.n, METHANE_FIELD_MAX), e_svc: str(m.e_svc, METHANE_FIELD_MAX), timestamp: num(m.timestamp), by: str(m.by, 80), device: str(m.device, 16) };
    if (!out.timestamp || !['m', 'e', 't', 'h', 'a', 'n', 'e_svc'].some(k => out[k].trim())) return null;
    return out;
}

// Patient IDs and card numbers are shown on every screen, so only letters, digits, spaces and . _ / # - are kept.
// Anything else (quotes, angle brackets, ampersands) is dropped rather than the record refused.
function cleanTagText(v) { return String(v || '').replace(/[^\p{L}\p{N} ._\/#-]/gu, '').replace(/\s+/g, ' ').trim(); }

function createCore(opts) {
    opts = opts || {};
    const store = opts.store;
    const now = opts.now || (() => Date.now());
    const rng = opts.random || ((n) => crypto.randomBytes(n));
    const log = opts.log || (() => {});

    const keyMeta = (code) => `i/${code}/meta`;
    const keyRec = (code, uid) => `i/${code}/r/${uid}`;
    const keyDev = (code, id) => `i/${code}/d/${id}`;
    const keyPolicy = (code) => `i/${code}/policy`;
    const keyMarks = (code) => `i/${code}/marks`;
    const keyClear = (code, id) => `i/${code}/dc/${id}`;
    const keyTomb = (code) => `t/${code}`;
    const keyCodeFail = (code) => `rk/${code}`;
    // A key only the server can make, given to a phone or screen once it has shown a right PIN. Presenting it lets
    // that phone or screen through the incident-wide wrong-PIN lock-out (which strangers' guesses can trigger).
    // The device key ties a phone's reports to its device code, so another phone cannot send under that code.
    // The access key is tied to the PIN level it was given for (v0.19.8): it only lets through a PIN of that level or
    // lower, so a triager's or observer's key cannot be used to guess the commander PIN past the lock-out.
    // Keys handed out before v0.19.8 (no level) count as the triagers' level.
    const accessKey = (meta, level) => meta.keySecret ? shortHash(meta.keySecret + ':access:' + meta.code + (level ? ':' + level : '')) + shortHash(meta.code + ':' + meta.keySecret + (level ? ':' + level : '')) : '';
    const LEVEL_RANK = { view: 0, member: 1, commander: 2 };
    function keyLevel(meta, key) {
        if (!key || !meta.keySecret) return '';
        for (const l of ['commander', 'member', 'view']) if (safeEqual(String(key), accessKey(meta, l))) return l;
        return safeEqual(String(key), accessKey(meta)) ? 'member' : '';
    }
    const deviceKey = (meta, id) => meta.keySecret ? shortHash(meta.keySecret + ':device:' + id) + shortHash(id + ':' + meta.keySecret) : '';
    // The client address itself is never stored. The hash is salted with a server-only secret (RATE_LIMIT_SALT),
    // so a stored key cannot be matched back to an address by hashing guesses.
    const rateSalt = String(opts.rateSalt || '');
    const keyRate = (client) => `rl/${shortHash(rateSalt ? rateSalt + ':' + client : client)}`;

    // Nothing personal goes to the server log (Netlify keeps it, and where it keeps it is not chosen here): incident
    // codes, device codes and counts only. Client addresses are used for the wrong-PIN lock-out and never logged.
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
    // The count goes up in memory before anything is awaited, so guesses sent in parallel are all counted.
    function noteFailureNow(map, id) {
        const cur = map.get(id);
        const f = cur && now() - cur.since <= RATE_WINDOW_MS ? { count: cur.count + 1, since: cur.since } : { count: 1, since: now() };
        map.set(id, f);
        return f;
    }
    async function noteFailure(client) {
        const f = noteFailureNow(failures, client);
        try { await store.set(keyRate(client), f); } catch (e) {}
    }
    const codeFailures = new Map(); // incident code -> { count, since }
    const creates = new Map();      // rc/<client> -> { count, since }
    async function readCodeFailures(code) {
        let f = codeFailures.get(code) || null;
        try { const s = await store.get(keyCodeFail(code)); if (s && (!f || (s.count || 0) > f.count)) f = { count: s.count || 0, since: s.since || 0 }; } catch (e) {}
        if (f && now() - f.since > RATE_WINDOW_MS) f = null;
        if (f) codeFailures.set(code, f); else codeFailures.delete(code);
        return f;
    }

    async function deleteIncident(code, why) {
        // The tombstone first, so phones and screens are told the incident ended even if the delete is interrupted.
        if (why) await store.set(keyTomb(code), { code, why, at: now() });
        const keys = entries(await store.list(`i/${code}/`)).map(e => e.key);
        // The meta goes last, so an interrupted delete still leaves the incident findable (and the sweep finishes it).
        const meta = keyMeta(code);
        await deleteEach(store, keys.filter(k => k !== meta));
        if (keys.indexOf(meta) > -1) await store.delete(meta);
        return keys.length;
    }
    async function loadMeta(code) {
        const meta = await store.get(keyMeta(code));
        if (!meta) return null;
        if (now() - meta.updatedAt > TTL_MS) { await deleteIncident(code, 'expired'); log('expired', code); return 'expired'; }
        return meta;
    }
    // Returns {meta, level} or an error reply. need: 'read' (any PIN; the triagers' and view-only PINs read as view
    // only), 'member' (triagers' or commander PIN: join, send, look up) or 'commander' (commander PIN only).
    // Incidents made before v0.19.6 have no commander PIN: their one PIN keeps its old full access until they expire.
    async function authed(code, pin, client, need, key) {
        need = need || 'member';
        const refused = () => error(401, 'bad_access', BAD_ACCESS_MSG);
        if (!code) return refused();
        await readFailures(client).then(f => { if (f) failures.set(client, f); });
        const mine = failures.get(client);
        if (mine && now() - mine.since <= RATE_WINDOW_MS && mine.count >= RATE_MAX_FAILURES) return error(429, 'rate_limited', 'Too many wrong codes or PINs from here. Try again in 15 minutes.');
        const meta = await loadMeta(code);
        if (meta === 'expired') return error(410, 'expired', EXPIRED_MSG);
        if (!meta) {
            const tomb = await store.get(keyTomb(code));
            if (tomb && now() - (tomb.at || 0) <= TOMBSTONE_MS) return error(410, tomb.why === 'expired' ? 'expired' : 'ended', tomb.why === 'expired' ? EXPIRED_MSG : ENDED_MSG);
            await noteFailure(client);
            return refused();
        }
        await readCodeFailures(code);
        // From here to the verdict nothing is awaited, so parallel guesses cannot all slip past the counts.
        const mineNow = failures.get(client);
        if (mineNow && now() - mineNow.since <= RATE_WINDOW_MS && mineNow.count >= RATE_MAX_FAILURES) return error(429, 'rate_limited', 'Too many wrong codes or PINs from here. Try again in 15 minutes.');
        const h = pin ? hashPin(meta.salt, pin) : '';
        let level = '';
        if (h && meta.cmdHash && safeEqual(h, meta.cmdHash)) level = 'commander';
        else if (h && safeEqual(h, meta.pinHash)) level = meta.cmdHash ? 'member' : 'commander';
        else if (h && meta.viewHash && safeEqual(h, meta.viewHash)) level = 'view';
        // Incident-wide lock-out after many wrong PINs from anywhere. Still let through: a phone or screen whose key
        // covers the PIN it presents, and an address with no wrong PINs of its own in this window (so strangers'
        // guesses cannot keep a new commander screen or a re-joining phone out; each address then gets one try).
        const cf = codeFailures.get(code);
        if (cf && now() - cf.since <= RATE_WINDOW_MS && cf.count >= CODE_MAX_FAILURES) {
            const kl = keyLevel(meta, key);
            const keyCovers = !!kl && !!level && LEVEL_RANK[level] <= LEVEL_RANK[kl];
            const cleanAddress = !mineNow || now() - mineNow.since > RATE_WINDOW_MS || !mineNow.count;
            if (!keyCovers && !cleanAddress) return error(429, 'rate_limited', 'Too many wrong PINs have been tried for this incident. Phones already linked carry on; others can try again in 15 minutes.');
        }
        if (!level) {
            // Every wrong PIN counts, whoever sends it and whatever key it carries.
            noteFailureNow(failures, client);
            const cfNow = noteFailureNow(codeFailures, code);
            try { await store.set(keyRate(client), failures.get(client)); await store.set(keyCodeFail(code), cfNow); } catch (e) {}
            return refused();
        }
        if (need === 'read') return { meta, level };
        if (level === 'view') return error(403, 'view_only', 'That is the view-only PIN. It can open the commander screen but not send or change anything.');
        if (need === 'commander' && level !== 'commander') return error(403, 'not_commander', 'That PIN lets phones send casualties but not change incident decisions. Use the commander PIN.');
        return { meta, level };
    }
    // The decisions and markings, kept apart from the meta (older incidents kept them in it).
    async function loadPolicy(code, meta) {
        return policyDoc(await store.get(keyPolicy(code)), meta);
    }
    async function loadMarks(code, meta) {
        const d = await store.get(keyMarks(code));
        return d ? { marks: d.marks || [], marksAt: d.marksAt || 0, by: d.by || '' } : { marks: meta.marks || [], marksAt: meta.marksAt || 0, by: '' };
    }
    // Meta changes are written onto a fresh copy, so two requests at once lose as little as possible.
    async function touchMeta(code, change) {
        const fresh = (await store.get(keyMeta(code))) || null;
        if (!fresh) return null;
        if (change) change(fresh);
        fresh.updatedAt = now();
        fresh.seq = (fresh.seq || 0) + 1;
        await store.set(keyMeta(code), fresh);
        return fresh;
    }
    // Read, change and write one document as a single step where the store can (Firestore transaction), so two
    // commander actions at the same moment cannot overwrite each other (v0.19.7 stress test). change(current) returns
    // the new value, or undefined to leave it as it is.
    async function updateDoc(key, change) {
        if (typeof store.update === 'function') return store.update(key, change);
        const next = change(await store.get(key));
        if (next !== undefined) await store.set(key, next);
        return next;
    }
    // A phone's call for help with the commander's "cleared" (kept in its own document) laid over it.
    function withClear(duress, clr) {
        if (!duress) return null;
        if (clr && Math.abs((clr.at || 0) - (duress.at || 0)) <= 1000) return Object.assign({}, duress, { clearedAt: clr.clearedAt, clearedBy: clr.clearedBy || 'commander' });
        return duress;
    }

    function cleanRecord(raw) {
        const s = lib.sanitisePatientRecord(raw);
        if (!s || !s.uid || !/^[A-Za-z0-9_-]{1,64}$/.test(s.uid) || !s.id || !s.category) return null;
        const rec = lib.clonePatientRecord(s);
        rec.uid = s.uid; rec.id = cleanTagText(s.id) || 'UNNAMED-' + s.uid.slice(0, 6);
        if (rec.cardNo) rec.cardNo = cleanTagText(rec.cardNo);
        rec.updatedAt = s.updatedAt || s.timestamp || now();
        return rec;
    }

    async function create(body, client) {
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        // Anyone can start an incident (no account), so each client may create only a few an hour.
        const ck = `rc/${shortHash(rateSalt ? rateSalt + ':' + client : client)}`;
        let made = null;
        try { made = await store.get(ck); } catch (e) {}
        const mem = creates.get(ck);
        if (mem && (!made || mem.count > (made.count || 0))) made = mem;
        if (made && now() - (made.since || 0) > CREATE_WINDOW_MS) made = null;
        // Counted in memory before anything else is awaited, so requests sent together cannot all slip under the limit.
        if (made && made.count >= CREATE_MAX) return error(429, 'rate_limited', 'Too many incidents started from here in the last hour. Try again later.');
        const nextMade = made ? { count: made.count + 1, since: made.since } : { count: 1, since: now() };
        creates.set(ck, nextMade);
        try { await store.set(ck, nextMade); } catch (e) {}
        let code = '';
        for (let i = 0; i < 5; i++) { code = randomCode(rng); if (!(await store.get(keyMeta(code))) && !(await store.get(keyTomb(code)))) break; code = ''; }
        if (!code) return error(503, 'no_code', 'Could not allocate an incident code. Try again.');
        // Three different PINs: the triagers' PIN (join and send casualties), the commander PIN (also change
        // decisions, markings and calls for help, and end the incident) and the view-only PIN (watch only).
        const pins = [];
        while (pins.length < 3) { const p = randomPin(rng); if (pins.indexOf(p) === -1) pins.push(p); else pins.push(String((Number(p) + pins.length + 1) % 1000000).padStart(PIN_LENGTH, '0')); }
        const [pin, commanderPin, viewPin] = pins;
        const salt = crypto.randomBytes(8).toString('hex');
        const t = now();
        const meta = { code, salt, keySecret: crypto.randomBytes(16).toString('hex'), pinHash: hashPin(salt, pin), cmdHash: hashPin(salt, commanderPin), viewHash: hashPin(salt, viewPin), name: str(body.name, 80), incidentCode: lib.normaliseIncidentCode(body.incidentCode), training: !!body.training, createdAt: t, updatedAt: t, createdBy: { deviceId, triager: str(body.triager, 80) }, ccs: null, methane: null, seq: 1 };
        await store.set(keyMeta(code), meta);
        await store.set(keyDev(code, deviceId), Object.assign({ deviceId, triager: str(body.triager, 80), role: 'creator', joinedAt: t, lastSeen: t, records: 0, app: str(body.app, 40) }, body.keys === true ? { keyed: true } : { oldApp: true }));
        log('created', code);
        return reply(201, { code, pin, commanderPin, viewPin, deviceKey: deviceKey(meta, deviceId), accessKey: accessKey(meta, 'commander'), createdAt: t, expiresAt: t + TTL_MS, ttlMs: TTL_MS });
    }

    async function join(code, pin, body, client, key) {
        const a = await authed(code, pin, client, 'member', key);
        if (a.status) return a;
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        const existing = await store.get(keyDev(code, deviceId));
        if (!existing) {
            const devs = entries(await store.list(`i/${code}/d/`));
            if (devs.length >= MAX_DEVICES_PER_INCIDENT) return error(409, 'too_many_devices', 'This incident already has the maximum number of phones.');
        }
        const t = now();
        // A device code already used by a phone that holds its device key cannot be taken over by another phone.
        if (existing && existing.keyed && !(body.deviceKey && safeEqual(String(body.deviceKey), deviceKey(a.meta, deviceId)))) return error(409, 'device_taken', 'Another phone in this incident already uses this device code. Change the device code on this phone (⚙ Settings) and join again.');
        // Phones on v0.19.5 or earlier do not know about device keys: they join unkeyed and are marked as an old app,
        // so their casualties still arrive (they were all refused in the v0.19.7 stress test) and the commander
        // screen can tell the user to update. A phone that sends keys: true gets a device key from now on.
        const keyedNow = !!a.meta.keySecret && (body.keys === true || !!(existing && existing.keyed));
        const devDoc = Object.assign({ role: 'member', joinedAt: t, records: 0 }, existing || {}, { deviceId, triager: str(body.triager, 80) || (existing && existing.triager) || '', lastSeen: t, app: str(body.app, 40) });
        if (keyedNow) { devDoc.keyed = true; delete devDoc.oldApp; } else devDoc.oldApp = true;
        await store.set(keyDev(code, deviceId), devDoc);
        log('joined', code, deviceId);
        return reply(200, { ok: true, code, name: a.meta.name, incidentCode: a.meta.incidentCode, training: a.meta.training, createdAt: a.meta.createdAt, expiresAt: a.meta.updatedAt + TTL_MS, level: a.level, deviceKey: keyedNow ? deviceKey(a.meta, deviceId) : '', accessKey: accessKey(a.meta, a.level) });
    }

    async function push(code, pin, body, client, key, devKey) {
        const a = await authed(code, pin, client, 'member', key);
        if (a.status) return a;
        const meta = a.meta;
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        const devBefore = await store.get(keyDev(code, deviceId));
        if (devBefore && devBefore.keyed && !(devKey && safeEqual(String(devKey), deviceKey(meta, deviceId)))) return error(403, 'device_key', 'This phone\'s link to the incident is out of date. Join the incident again.');
        // Phone clocks can be wrong. updatedAt decides which copy of a record wins, so it is moved onto the
        // server's clock (by how far the phone's clock is out) and never allowed into the future.
        const skew = num(body.clientNow) !== null ? now() - num(body.clientNow) : 0;
        const fixTime = (v) => { let x = num(v) || 0; if (Math.abs(skew) > CLOCK_SKEW_MS) x += skew; return Math.min(x, now()); };
        const incoming = Array.isArray(body.records) ? body.records : [];
        if (incoming.length > MAX_RECORDS_PER_PUSH) return error(413, 'too_many_records', `Send at most ${MAX_RECORDS_PER_PUSH} records per request.`);
        const t = now();
        let accepted = 0, kept = 0;
        const rejected = [];
        let known = null;
        // Clean every record, read what the server already has for them in one go, then write the batch together.
        const cleaned = [];
        const seenUid = new Set();
        for (const raw of incoming) {
            const rec = cleanRecord(raw);
            if (!rec) { rejected.push(raw && raw.uid ? String(raw.uid).slice(0, 64) : '?'); continue; }
            rec.updatedAt = fixTime(rec.updatedAt);
            // Triage and creation times are moved onto the server's clock too (v0.19.7 stress test).
            if (Math.abs(skew) > CLOCK_SKEW_MS) { if (num(rec.timestamp)) rec.timestamp = fixTime(rec.timestamp); if (num(rec.createdAt)) rec.createdAt = fixTime(rec.createdAt); }
            if (Math.abs(skew) > CLOCK_SKEW_MS) rec.clockSkewMs = Math.round(skew);
            if (seenUid.has(rec.uid)) { const i = cleaned.findIndex(x => x.uid === rec.uid); if ((rec.updatedAt || 0) >= (cleaned[i].updatedAt || 0)) cleaned[i] = rec; continue; }
            seenUid.add(rec.uid);
            cleaned.push(rec);
        }
        const current = cleaned.length ? await getEach(store, cleaned.map(r => keyRec(code, r.uid))) : [];
        const writes = [];
        cleaned.forEach((rec, i) => {
            const cur = current[i];
            if (cur && (cur.updatedAt || 0) > (rec.updatedAt || 0)) { kept++; return; } // an older copy never overwrites a newer one
            if (!cur) {
                if (known === null) known = -1; // counted below, once
                rec._new = true;
            }
            writes.push(rec);
        });
        if (writes.some(r => r._new)) known = entries(await store.list(`i/${code}/r/`)).length;
        const toWrite = [];
        for (const rec of writes) {
            if (rec._new) {
                delete rec._new;
                if (known >= MAX_RECORDS_PER_INCIDENT) { rejected.push(rec.uid); continue; }
                known++;
            }
            rec.reportedBy = deviceId;
            rec.reportedAt = t;
            toWrite.push([keyRec(code, rec.uid), rec]);
        }
        await setEach(store, toWrite);
        accepted = toWrite.length;
        let newCcs = null;
        if (body.ccs && num(body.ccs.lat) !== null && num(body.ccs.lng) !== null) {
            const ccs = lib.normaliseLocation(body.ccs);
            // Compared by what the phone sent (its own time and the place), not the clock-corrected time, which moves
            // on every report from a phone whose clock is out and made every report look new (v0.19.7 stress test).
            const sentAt = ccs ? num(ccs.timestamp) || 0 : 0;
            const same = !!ccs && !!meta.ccs && meta.ccs.setBy === deviceId && (meta.ccs.sentAt || 0) === sentAt && meta.ccs.lat === ccs.lat && meta.ccs.lng === ccs.lng;
            if (ccs && !same) { ccs.timestamp = fixTime(sentAt || t); if (!meta.ccs || ccs.timestamp > (num(meta.ccs.timestamp) || 0)) newCcs = Object.assign({}, ccs, { setBy: deviceId, sentAt }); }
        }
        const methane = cleanMethane(body.methane);
        if (methane) { methane.sentAt = methane.timestamp; methane.timestamp = fixTime(methane.timestamp); }
        const dev = (await store.get(keyDev(code, deviceId))) || devBefore || { deviceId, role: 'member', joinedAt: t, records: 0 };
        dev.triager = str(body.triager, 80) || dev.triager || '';
        dev.lastSeen = t;
        dev.app = str(body.app, 40) || dev.app || '';
        dev.records = num(body.totalRecords) !== null ? Math.max(0, Math.floor(num(body.totalRecords))) : dev.records;
        dev.lastPush = incoming.length ? t : dev.lastPush || null;
        // Sector / zone and clinician or not: lets the commander send a prompt to one group of phones (e.g. only the casualty clearing station).
        if (body.sector !== undefined) dev.sector = str(body.sector, 60).trim();
        if (body.userRole === 'HCP' || body.userRole === 'NON_HCP') dev.userRole = body.userRole;
        // The incident commander's own phone: labelled as such on the commander screen and not counted as a clinician.
        if (body.commander === true) dev.commander = true; else if (body.commander === false) delete dev.commander;
        if (num(body.battery) !== null) { dev.battery = Math.max(0, Math.min(100, Math.round(num(body.battery)))); dev.charging = !!body.charging; }
        // Triager position (opt-in on the phone): only the latest one is kept, and a phone that turns sharing off
        // sends null to remove it. Same 24-hour expiry as everything else in the incident.
        if (body.position === null) delete dev.position;
        else { const p = cleanPosition(body.position, t); if (p) dev.position = p; }
        // Duress: the phone raises it (object) or clears it (null); the commander can also mark it cleared (see clearDuress).
        if (body.duress === null) delete dev.duress;
        else if (body.duress && typeof body.duress === 'object') {
            const at = num(body.duress.at) || t;
            // The same duress (same 'at') repeated on every heartbeat is not a new alert, even once the commander has cleared it; a fresh 'at' is.
            if (!dev.duress || Math.abs((dev.duress.at || 0) - at) > 1000) dev.duress = { at, raisedAt: t };
            delete dev.duress.clearedAt; delete dev.duress.clearedBy; // the commander's "cleared" lives in its own document
            const p = cleanPosition(body.duress.position, t) || dev.position || null;
            if (p) dev.duress.position = p;
        }
        let newMethane = null;
        if (methane) {
            methane.device = deviceId;
            if (!methane.by) methane.by = dev.triager;
            // New only if the phone's own save time or the text changed (not the clock-corrected time).
            const sameM = dev.methane && (dev.methane.sentAt || dev.methane.timestamp) === methane.sentAt && ['m', 'e', 't', 'h', 'a', 'n', 'e_svc'].every(k => dev.methane[k] === methane[k]);
            if (!sameM) { newMethane = methane; dev.methane = methane; }
        }
        await store.set(keyDev(code, deviceId), dev);
        // Only new information keeps the incident alive: a report with nothing new (a heartbeat) does not reset the
        // 24-hour clock, so a forgotten linked phone cannot keep the data on the server for ever. The commander's
        // decisions are never in this write, so a report cannot undo them.
        let m = meta;
        if (accepted || newCcs || newMethane) {
            m = (await touchMeta(code, (fresh) => {
                if (newCcs && (!fresh.ccs || newCcs.timestamp >= (num(fresh.ccs.timestamp) || 0))) fresh.ccs = newCcs;
                // The incident's METHANE is the newest one any phone has saved.
                if (newMethane && (!fresh.methane || newMethane.timestamp >= (fresh.methane.timestamp || 0))) fresh.methane = newMethane;
            })) || meta;
        }
        const [pol, mk, clr] = await Promise.all([loadPolicy(code, m), loadMarks(code, m), dev.duress ? store.get(keyClear(code, deviceId)) : null]);
        // Map markings ride back on every push and heartbeat, so linked phones pick them up without another request.
        return reply(200, { ok: true, accepted, kept, rejected, serverTime: t, expiresAt: m.updatedAt + TTL_MS, marks: mk.marks, marksAt: mk.marksAt, policy: pol.policy, policyAt: pol.policyAt, duress: withClear(dev.duress, clr) || null, clockSkewMs: Math.round(skew) });
    }

    // What the commander screen has is identified by a fingerprint of the stored blobs (every record and device
    // etag plus the meta's own change counter), not by the counter alone. Two phones pushing at the same moment
    // can both write the same counter value; they cannot both leave the same set of etags behind.
    function fingerprint(meta, recs, devs, extra) {
        const parts = [String(meta.seq || 0), String(meta.updatedAt || 0), String((meta.ccs && meta.ccs.timestamp) || 0), String((meta.methane && meta.methane.timestamp) || 0), String(meta.marksAt || 0), String(meta.policyAt || 0)]
            .concat(recs.map(e => e.key + '=' + e.etag), devs.map(e => e.key + '=' + e.etag), (extra || []).map(e => e.key + '=' + e.etag));
        return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 20);
    }
    async function read(code, pin, ifNoneMatch, client, knownSeq, key) {
        const a = await authed(code, pin, client, 'read', key);
        if (a.status) return a;
        const meta = a.meta;
        const all = entries(await store.list(`i/${code}/`));
        const recEntries = all.filter(e => e.key.startsWith(`i/${code}/r/`));
        const devEntries = all.filter(e => e.key.startsWith(`i/${code}/d/`));
        const extra = all.filter(e => e.key === keyPolicy(code) || e.key === keyMarks(code) || e.key.startsWith(`i/${code}/dc/`));
        const seq = fingerprint(meta, recEntries, devEntries, extra) + (a.level === 'commander' ? 'c' : 'v');
        const etag = `"${seq}"`;
        // Netlify's edge rewrites the ETag it serves when it compresses the body ("2" becomes "2-df") and then drops an
        // If-None-Match that carries that suffix before the function sees it. So the page also sends the fingerprint it
        // already has in X-Incident-Seq, which the edge leaves alone; either one matching means nothing has changed.
        const givenSeq = String(ifNoneMatch || '').replace(/^W\//, '').replace(/"/g, '').split('-')[0];
        const known = String(knownSeq || '').trim();
        if ((givenSeq && givenSeq === seq) || (known && known === seq)) return { status: 304, body: null, headers: { ETag: etag, 'X-Incident-Seq': seq, 'Cache-Control': 'no-store' } };
        const t = now();
        const records = await getMany(store, recEntries.map(e => e.key));
        const clears = {};
        (await getMany(store, extra.filter(e => e.key.indexOf('/dc/') > -1).map(e => e.key))).forEach(c => { if (c && c.deviceId) clears[c.deviceId] = c; });
        const devices = (await getMany(store, devEntries.map(e => e.key))).map(d => { const o = Object.assign({}, d, { stale: t - (d.lastSeen || 0) > STALE_DEVICE_MS }); delete o.keyed; if (o.duress) o.duress = withClear(o.duress, clears[o.deviceId]); return o; });
        const [pol, mk] = await Promise.all([loadPolicy(code, meta), loadMarks(code, meta)]);
        records.sort((x, y) => ((x.category in ORDER ? ORDER[x.category] : 99) - (y.category in ORDER ? ORDER[y.category] : 99)) || (x.timestamp || 0) - (y.timestamp || 0));
        devices.sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
        log('read', code);
        // The triagers' PIN opens the screen as view only: only the commander PIN can change anything.
        const viewOnly = a.level !== 'commander';
        return reply(200, { code, name: meta.name, incidentCode: meta.incidentCode, training: meta.training, createdAt: meta.createdAt, updatedAt: meta.updatedAt, expiresAt: meta.updatedAt + TTL_MS, ccs: meta.ccs, methane: meta.methane || null, marks: mk.marks, marksAt: mk.marksAt, marksBy: mk.by, policy: pol.policy, policyAt: pol.policyAt, decisions: pol.decisions, viewOnly, access: a.level === 'commander' ? 'commander' : a.level === 'member' ? 'triager' : 'view', hasViewPin: !!meta.viewHash, hasCommanderPin: !!meta.cmdHash, accessKey: accessKey(meta, a.level), devices, records, serverTime: t, seq }, { ETag: etag, 'X-Incident-Seq': seq });
    }

    // Commander screen: replace the incident's map markings (cordons, RVP, loading point...). Full PIN only.
    // The commander acknowledges a phone's call for help. The phone sees clearedAt in its next push reply.
    // Commander PIN only, and the name of who cleared it is required. Kept in its own document, so a phone's
    // report sent at the same moment cannot write the call for help back as live.
    async function clearDuress(code, pin, body, client, key) {
        const a = await authed(code, pin, client, 'commander', key);
        if (a.status) return a;
        const deviceId = str(body.deviceId, 16);
        const by = str(body.by, 80).trim();
        if (!by) return error(400, 'bad_request', 'Say who is clearing the call for help.');
        const dev = deviceId ? await store.get(keyDev(code, deviceId)) : null;
        if (!dev) return error(404, 'no_device', 'No such phone in this incident.');
        const t = now();
        let clr = await store.get(keyClear(code, deviceId));
        if (dev.duress && !withClear(dev.duress, clr).clearedAt) {
            clr = { deviceId, at: dev.duress.at, clearedAt: t, clearedBy: by };
            const prev = clr;
            clr = await updateDoc(keyClear(code, deviceId), (cur) => (cur && withClear(dev.duress, cur).clearedAt) ? undefined : prev) || (await store.get(keyClear(code, deviceId))) || prev;
            await addDecision(code, a.meta, { what: 'duress-cleared', device: deviceId, triager: dev.triager || '', by });
            await touchMeta(code);
            log('duress-cleared', code, deviceId);
        }
        return reply(200, { ok: true, duress: withClear(dev.duress, clr) || null });
    }
    // Every commander decision is kept with who made it and when (shown on the commander screen).
    function policyDoc(d, meta) { return d ? { policy: d.policy || {}, policyAt: d.policyAt || 0, decisions: d.decisions || [] } : { policy: meta.policy || {}, policyAt: meta.policyAt || 0, decisions: [] }; }
    async function addDecision(code, meta, d) {
        await updateDoc(keyPolicy(code), (raw) => {
            const cur = policyDoc(raw, meta);
            return { policy: cur.policy, policyAt: cur.policyAt, decisions: cur.decisions.concat([Object.assign({ at: now() }, d)]).slice(-200) };
        });
    }

    async function setMarks(code, pin, body, client, key) {
        const a = await authed(code, pin, client, 'commander', key);
        if (a.status) return a;
        const by = str(body.by, 80).trim();
        if (!by) return error(400, 'bad_request', 'Say who is changing the map markings.');
        const t = now();
        const marks = lib.normaliseMapMarks(body.marks).map(m => Object.assign(m, { at: m.at || t }));
        await store.set(keyMarks(code), { marks, marksAt: t, by });
        await addDecision(code, a.meta, { what: 'marks', count: marks.length, by });
        await touchMeta(code);
        log('marks', code, marks.length);
        return reply(200, { ok: true, marks, marksAt: t });
    }

    // Commander screen: incident-level clinical decisions. Full PIN only.
    // body.p1Hold { on, by }: allow (or withdraw) P1 Hold on clinicians' phones, with the decision-maker's name.
    // body.mitt { groups, by }: tell the chosen groups of phones that MITT is now in use. Each send gets a new id, so a
    // phone shows it once; anyone can still switch tool on their own phone without it (Jake's decision, 29 Oct 2026).
    async function setPolicy(code, pin, body, client, key) {
        const a = await authed(code, pin, client, 'commander', key);
        if (a.status) return a;
        const t = now();
        let p1By = '', mittBy = '', groups = [];
        if (body.p1Hold && typeof body.p1Hold === 'object') {
            p1By = str(body.p1Hold.by, 80).trim();
            if (!p1By) return error(400, 'bad_request', body.p1Hold.on ? 'Say who made the P1 Hold decision.' : 'Say who is withdrawing P1 Hold.');
        }
        if (body.mitt && typeof body.mitt === 'object') {
            groups = lib.normalisePolicyGroups(body.mitt.groups);
            if (!groups.length) return error(400, 'bad_request', 'Choose who the MITT prompt goes to.');
            mittBy = str(body.mitt.by, 80).trim();
            if (!mittBy) return error(400, 'bad_request', 'Say who is sending the MITT prompt.');
        }
        if (!p1By && !mittBy) return error(400, 'bad_request', 'Nothing to change.');
        const mittId = t.toString(36) + crypto.randomBytes(3).toString('hex');
        let out = null;
        // One read-change-write, so a P1 Hold change, a MITT prompt and a decision log entry sent at the same moment
        // are all kept (v0.19.7 stress test: 1 of 12 simultaneous changes was lost).
        await updateDoc(keyPolicy(code), (raw) => {
            const cur = policyDoc(raw, a.meta);
            const policy = lib.normalisePolicy(cur.policy || {});
            const decisions = cur.decisions.slice();
            if (p1By) { policy.p1Hold = { on: !!body.p1Hold.on, at: t, by: p1By }; decisions.push({ at: t, what: body.p1Hold.on ? 'p1hold-on' : 'p1hold-off', by: p1By }); }
            if (mittBy) { policy.mitt = { id: mittId, at: t, by: mittBy, groups }; decisions.push({ at: t, what: 'mitt', groups, by: mittBy }); }
            out = lib.normalisePolicy(policy);
            return { policy: out, policyAt: Math.max(t, cur.policyAt || 0), decisions: decisions.slice(-200) };
        });
        await touchMeta(code);
        log('policy', code);
        return reply(200, { ok: true, policy: out, policyAt: t });
    }

    // A phone scanned a tag it does not know: has another phone in this incident recorded it? Full PIN only, and
    // only exact matches on the patient ID or triage card number, so it cannot be used to browse the incident.
    async function lookup(code, pin, body, client, key) {
        const a = await authed(code, pin, client, 'member', key);
        if (a.status) return a;
        const tag = str(body.tag, 80).trim().toUpperCase();
        if (!tag) return error(400, 'bad_request', 'tag is required.');
        const keys = entries(await store.list(`i/${code}/r/`)).map(e => e.key);
        const records = (await getMany(store, keys)).filter(r => String(r.id || '').toUpperCase() === tag || String(r.cardNo || '').trim().toUpperCase() === tag);
        records.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
        log('lookup', code, records.length);
        return reply(200, { ok: true, records: records.slice(0, MAX_LOOKUP_RESULTS) });
    }

    // Ending the incident deletes everything: commander PIN only.
    async function close(code, pin, client, key) {
        const a = await authed(code, pin, client, 'commander', key);
        if (a.status) return a;
        const n = await deleteIncident(code, 'ended');
        log('closed', code);
        return reply(200, { ok: true, deleted: n });
    }

    // Scheduled sweep: delete anything past its TTL, and lock-out counters whose window has passed.
    async function cleanup() {
        const keys = entries(await store.list('i/')).map(e => e.key);
        const codes = Array.from(new Set(keys.map(k => k.split('/')[1]).filter(Boolean)));
        let removed = 0;
        // One failed read or delete is logged and skipped, so it cannot stop the rest of the sweep (v0.19.7 stress test).
        let errors = 0;
        const each = async (fn) => { try { await fn(); } catch (e) { errors++; log('cleanup-error', e && e.message); } };
        for (const c of codes) {
            await each(async () => {
                const meta = await store.get(keyMeta(c));
                if (!meta || now() - meta.updatedAt > TTL_MS) { removed += await deleteIncident(c, meta ? 'expired' : ''); }
            });
        }
        let locks = 0;
        for (const pre of ['rl/', 'rk/', 'rc/']) {
            let keys2 = [];
            await each(async () => { keys2 = entries(await store.list(pre)).map(e => e.key); });
            for (const k of keys2) {
                await each(async () => {
                    const f = await store.get(k);
                    if (!f || now() - (f.since || 0) > (pre === 'rc/' ? CREATE_WINDOW_MS : RATE_WINDOW_MS)) { await store.delete(k); locks++; }
                });
            }
        }
        let tombs = [];
        await each(async () => { tombs = entries(await store.list('t/')).map(e => e.key); });
        for (const k of tombs) {
            await each(async () => {
                const tomb = await store.get(k);
                if (!tomb || now() - (tomb.at || 0) > TOMBSTONE_MS) { await store.delete(k); removed++; }
            });
        }
        return { incidents: codes.length, removedBlobs: removed, removedLocks: locks, errors };
    }

    // Generic HTTP dispatcher: method, path (e.g. "/api/incident/ABC123/records"), headers (lower-case keys), body text, client id.
    async function handle(method, path, headers, bodyText, client) {
        headers = headers || {};
        client = client || 'unknown';
        const parts = path.replace(/^\/api\/incident\/?/, '').split('/').filter(Boolean);
        const code = parts.length ? normaliseCode(parts[0]) : '';
        const action = parts[1] || '';
        const pin = normalisePin(headers['x-incident-pin'] || '');
        const key = str(headers['x-incident-key'] || '', 64);
        const devKey = str(headers['x-device-key'] || '', 64);
        if (bodyText && Buffer.byteLength(bodyText) > MAX_BODY_BYTES) return error(413, 'too_large', 'Request too large.');
        let body = {};
        if (bodyText) { try { body = JSON.parse(bodyText); } catch (e) { return error(400, 'bad_json', 'Body must be JSON.'); } }
        if (!body || typeof body !== 'object') body = {};
        try {
            if (method === 'POST' && !parts.length) return await create(body, client);
            if (method === 'GET' && parts.length === 1) return await read(code, pin, headers['if-none-match'] || '', client, headers['x-incident-seq'] || '', key);
            if (method === 'POST' && action === 'join') return await join(code, pin, body, client, key);
            if ((method === 'PUT' || method === 'POST') && action === 'records') return await push(code, pin, body, client, key, devKey);
            if (method === 'POST' && action === 'close') return await close(code, pin, client, key);
            if (method === 'POST' && action === 'marks') return await setMarks(code, pin, body, client, key);
            if (method === 'POST' && action === 'policy') return await setPolicy(code, pin, body, client, key);
            if (method === 'POST' && action === 'duress-clear') return await clearDuress(code, pin, body, client, key);
            if (method === 'POST' && action === 'lookup') return await lookup(code, pin, body, client, key);
            return error(404, 'not_found', 'Unknown endpoint.');
        } catch (e) {
            log('error', e && e.message);
            return error(500, 'server_error', 'Something went wrong on the server.');
        }
    }

    return { handle, cleanup, create, join, push, read, close, setMarks, setPolicy, clearDuress, lookup, deleteIncident, constants: { TTL_MS, STALE_DEVICE_MS, MAX_RECORDS_PER_PUSH, MAX_RECORDS_PER_INCIDENT, RATE_MAX_FAILURES, CODE_MAX_FAILURES, CREATE_MAX, CODE_LENGTH, PIN_LENGTH, READ_BATCH, TOMBSTONE_MS } };
}

// Simple in-memory store (tests and local development). opts.delay (ms) or opts.jitter (ms) make every operation
// take time, so tests can interleave requests the way a real store does.
function memoryStore(opts) {
    opts = opts || {};
    const m = new Map();
    const locks = new Map();
    let ops = 0;
    const wait = () => { ops++; const ms = (opts.delay || 0) + (opts.jitter ? Math.random() * opts.jitter : 0); return ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve(); };
    return {
        async get(k) { await wait(); return m.has(k) ? JSON.parse(m.get(k)) : null; },
        async set(k, v) { await wait(); m.set(k, JSON.stringify(v)); },
        async delete(k) { await wait(); m.delete(k); },
        async list(prefix) { await wait(); return Array.from(m.keys()).filter(k => k.startsWith(prefix)).sort().map(k => ({ key: k, etag: crypto.createHash('sha1').update(m.get(k)).digest('hex').slice(0, 12) })); },
        // Read-change-write as one step, as a Firestore transaction does: changes to one key queue behind each other.
        update(k, change) {
            const run = (locks.get(k) || Promise.resolve()).then(async () => {
                await wait();
                const next = change(m.has(k) ? JSON.parse(m.get(k)) : null);
                await wait();
                if (next !== undefined) m.set(k, JSON.stringify(next));
                return next;
            });
            locks.set(k, run.catch(() => {}));
            return run;
        },
        size() { return m.size; },
        ops() { return ops; },
    };
}

module.exports = { createCore, memoryStore, normaliseCode, normalisePin, TTL_MS, STALE_DEVICE_MS };
