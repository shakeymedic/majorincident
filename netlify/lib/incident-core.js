// Incident commander backend, independent of Netlify so it can be tested in plain Node.
// The store is any object with get(key) -> value | null, set(key, value), delete(key), list(prefix) -> [entries],
// incr(key, { field: n }) (adds atomically) and counts(keys) -> [{ field: n } | null].
// list() returns either plain keys or { key, etag } objects (Netlify Blobs gives an etag per blob; the in-memory
// store derives one from the content). The etags are what tell a commander screen whether anything changed.
// Every value is a plain JSON object. Keys: i/<CODE>/meta, i/<CODE>/r/<uid>, i/<CODE>/d/<deviceId>,
// i/<CODE>/policy and i/<CODE>/marks (commander decisions, kept apart from the meta so a phone's report can never
// write an older copy back over them; from v0.19.8 i/<CODE>/pol/<field> and i/<CODE>/dec/<entry>, and from v0.19.10
// i/<CODE>/mk/<markId> with i/<CODE>/pol/marks for when they last changed), i/<CODE>/dc/<deviceId> (a call for help cleared by the commander),
// t/<CODE> (an ended incident's tombstone), rc/<client> (incidents created), and the wrong-PIN counters rl/<client>/<day>
// and rk/<CODE>/<day> (store.incr / store.counts: { field: n }, added to atomically).
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
// Wrong PINs per incident per day (a calendar day, UTC), from anywhere. Past this, an address with no wrong PINs of
// its own that day still gets one try, but those addresses may only get CODE_CLEAN_MAX_FAILURES wrong between them.
// At most 400 a day, or 800 across midnight, against 3 PINs out of 1,000,000: about a 0.12% (0.24%) chance.
const CODE_DAY_MAX_FAILURES = 300;
const CODE_CLEAN_MAX_FAILURES = 100;
const CODE_DAY_MS = 24 * 60 * 60 * 1000;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const CREATE_MAX = 10;                        // incidents created per client per hour
const CLOCK_FIX_MS = 10 * 1000;               // phone clocks further out than this are corrected. 60 s let a phone up to a
                                              // minute slow lose a genuine update (v0.19.9 stress test); 2 s treated a
                                              // slow delivery as a wrong clock (v0.19.10 retest). 10 s is past most delays.
const CLOCK_SKEW_MS = 60 * 1000;              // ...and further out than this, the record is labelled with the skew
const STALE_DEVICE_MS = 5 * 60 * 1000;
const READ_BATCH = 25;                        // blobs fetched at once when the commander screen reads
const METHANE_FIELD_MAX = 600;
const MAX_LOOKUP_RESULTS = 5;
// Phones on v0.19.7 or earlier do not use device keys, so anyone with the triagers' PIN could send or rename under
// their device code (v0.19.9 stress test). From v0.19.10 they are asked to update instead of joining unkeyed.
const OLD_APP_MSG = 'This phone has an old version of the app. Close the app fully and open it again (with signal) to update it, then join again.';
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
// The address used for the wrong-PIN counts. An IPv6 user is usually given a whole /64 block, so the block is
// counted as one address (v0.19.9 stress test); IPv4 addresses (also when written as ::ffff:a.b.c.d) count singly.
function rateClient(ip) {
    const s = String(ip || 'unknown').trim().toLowerCase();
    const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    if (v4) return v4[1];
    if (s.indexOf(':') === -1) return s;
    const [head, tail] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined && tail ? tail.split(':') : [];
    const full = tail === undefined ? h : h.concat(Array(Math.max(0, 8 - h.length - t.length)).fill('0'), t);
    return full.slice(0, 4).map(x => (x || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
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
    const keyPolicy = (code) => `i/${code}/policy`;            // pre-v0.19.8 incidents: one document for both decisions and the log
    const keyPol = (code, what) => `i/${code}/pol/${what}`;    // v0.19.8: one small document per decision field (p1hold, mitt)
    const keyDec = (code, id) => `i/${code}/dec/${id}`;        // v0.19.8: one document per decision-log entry, append only
    const DECISIONS_MAX = 200;
    // Decision-log documents sort by their key: the time, then a per-server counter (keeps the order of entries
    // written in the same millisecond), then a few random characters (two servers at once).
    let decSeq = 0;
    const decKey = (code, at) => keyDec(code, at.toString(36).padStart(9, '0') + '-' + String(++decSeq).padStart(6, '0') + '-' + crypto.randomBytes(2).toString('hex'));
    const keyMarks = (code) => `i/${code}/marks`;               // pre-v0.19.10 incidents: every marking in one document
    const keyMark = (code, id) => `i/${code}/mk/${id}`;         // v0.19.10: one document per marking (two screens at once lose nothing)
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

    // Wrong-PIN counts live in the store, so they survive a cold start and are shared by every server copy. They are
    // counters the store adds to atomically (Firestore increments), in one document per address and one per incident
    // for each day, with a field per 15-minute window. A wrong PIN is added before the verdict is read back, so
    // guesses sent together are all counted, whichever server copy takes them (v0.19.10 retest: with a read, then a
    // write, only 60 of 1,200 guesses sent at once were counted). A store failure never locks anyone out and never
    // lets a flood through: the copy in this server's memory is used instead.
    const memCounts = new Map(); // counter key -> { field: n }
    function addMem(key, fields) {
        if (memCounts.size > 5000) memCounts.clear();
        const m = Object.assign({}, memCounts.get(key) || {});
        Object.keys(fields).forEach(f => { m[f] = (m[f] || 0) + fields[f]; });
        memCounts.set(key, m);
        return m;
    }
    function maxOf(a, b) { const out = Object.assign({}, a || {}); Object.keys(b || {}).forEach(f => { out[f] = Math.max(out[f] || 0, b[f] || 0); }); return out; }
    async function readCounts(keys) {
        let vals = null;
        try { vals = await store.counts(keys); } catch (e) {}
        return keys.map((k, i) => maxOf(vals && vals[i], memCounts.get(k)));
    }
    async function bump(key, fields) {
        const m = addMem(key, fields);
        try { await store.incr(key, fields); const [v] = await store.counts([key]); return maxOf(v, m); } catch (e) { return m; }
    }
    const dayOf = (t) => Math.floor(t / CODE_DAY_MS);
    const winOf = (t) => 'w' + Math.floor(t / RATE_WINDOW_MS);
    const clientKey = (client, t) => keyRate(client) + '/' + dayOf(t);
    const incidentKey = (code, t) => keyCodeFail(code) + '/' + dayOf(t);
    const creates = new Map();      // rc/<client> -> { count, since }

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
        const tooManyHere = () => error(429, 'rate_limited', 'Too many wrong codes or PINs from here. Try again in 15 minutes.');
        if (!code) return refused();
        const t = now(), win = winOf(t), ck = clientKey(client, t), ik = incidentKey(code, t);
        const [mine] = await readCounts([ck]);
        const meta = await loadMeta(code);
        if (meta === 'expired') return error(410, 'expired', EXPIRED_MSG);
        if (!meta) {
            const tomb = await store.get(keyTomb(code));
            if (tomb && now() - (tomb.at || 0) <= TOMBSTONE_MS) return error(410, tomb.why === 'expired' ? 'expired' : 'ended', tomb.why === 'expired' ? EXPIRED_MSG : ENDED_MSG);
            if ((mine[win] || 0) >= RATE_MAX_FAILURES) return tooManyHere();
            await bump(ck, { d: 1, [win]: 1 });
            return refused();
        }
        const h = pin ? hashPin(meta.salt, pin) : '';
        let level = '';
        if (h && meta.cmdHash && safeEqual(h, meta.cmdHash)) level = 'commander';
        else if (h && safeEqual(h, meta.pinHash)) level = meta.cmdHash ? 'member' : 'commander';
        else if (h && meta.viewHash && safeEqual(h, meta.viewHash)) level = 'view';
        // A phone or screen whose key covers the PIN it presents is never held up by the counts, not even its own
        // address's (another device behind the same mobile network address may have guessed wrong).
        const kl = keyLevel(meta, key);
        const keyCovers = !!kl && !!level && LEVEL_RANK[level] <= LEVEL_RANK[kl];
        if (!keyCovers) {
            // A wrong PIN is counted first (for this address and this incident), then the counts are read back; own is
            // this attempt's part of them. A right PIN is only read, so it costs nothing.
            let cc, ic;
            if (level) { cc = mine; [ic] = await readCounts([ik]); }
            else { [cc, ic] = await Promise.all([bump(ck, { d: 1, [win]: 1 }), bump(ik, { d: 1, [win]: 1 })]); }
            const own = level ? 0 : 1;
            if ((cc[win] || 0) - own >= RATE_MAX_FAILURES) return tooManyHere();
            // Incident-wide lock-out: 100 wrong PINs in a 15-minute window, or 300 in a day, from anywhere. An address
            // with no wrong PINs of its own that day still gets one try, so one person guessing cannot keep new phones
            // and screens out (v0.19.10 retest). Past the day's limit those one-try addresses may only get another 100
            // wrong between them that day, so guesses spread over many addresses stay capped too (v0.19.9 stress test).
            const dayLocked = (ic.d || 0) - own >= CODE_DAY_MAX_FAILURES;
            if (dayLocked || (ic[win] || 0) - own >= CODE_MAX_FAILURES) {
                let ok = (cc.d || 0) - own === 0;
                if (ok && dayLocked) ok = level ? (ic.c || 0) < CODE_CLEAN_MAX_FAILURES : ((await bump(ik, { c: 1 })).c || 0) - 1 < CODE_CLEAN_MAX_FAILURES;
                if (!ok) return error(429, 'rate_limited', dayLocked
                    ? 'Too many wrong PINs have been tried for this incident today. Phones and screens already linked carry on. To add another phone, pass the casualties on with Hand over, or start a new incident.'
                    : 'Too many wrong PINs have been tried for this incident. Phones already linked carry on; others can try again in 15 minutes.');
            }
        }
        if (!level) return refused();
        if (need === 'read') return { meta, level };
        if (level === 'view') return error(403, 'view_only', 'That is the view-only PIN. It can open the commander screen but not send or change anything.');
        if (need === 'commander' && level !== 'commander') return error(403, 'not_commander', 'That PIN lets phones send casualties but not change incident decisions. Use the commander PIN.');
        return { meta, level };
    }
    // The decisions and markings, kept apart from the meta (older incidents kept them in it). From v0.19.8 each
    // decision field and each log entry is its own document, so two commander actions at the same moment never
    // read-and-rewrite the same document (v0.19.7 stress test: 1 of 12 simultaneous changes was lost, and the
    // transaction retries tried first took longer than a function is allowed). Older incidents' single document is
    // still read underneath.
    async function loadPolicyFields(code, meta) {
        // Incidents made from v0.19.10 (meta.v 2) never have the older single document, so it is not read (fewer reads per report).
        const fresh = (meta && meta.v) >= 2;
        const [p1, mitt, legacy] = await getEach(store, fresh ? [keyPol(code, 'p1hold'), keyPol(code, 'mitt')] : [keyPol(code, 'p1hold'), keyPol(code, 'mitt'), keyPolicy(code)]);
        const base = legacy ? { policy: legacy.policy || {}, policyAt: legacy.policyAt || 0, decisions: legacy.decisions || [] } : { policy: meta.policy || {}, policyAt: meta.policyAt || 0, decisions: [] };
        const policy = Object.assign({}, base.policy);
        let policyAt = base.policyAt;
        if (p1 && (p1.at || 0) >= ((policy.p1Hold && policy.p1Hold.at) || 0)) { policy.p1Hold = p1; policyAt = Math.max(policyAt, p1.at || 0); }
        if (mitt && (mitt.at || 0) >= ((policy.mitt && policy.mitt.at) || 0)) { policy.mitt = mitt; policyAt = Math.max(policyAt, mitt.at || 0); }
        return { policy, policyAt, legacyDecisions: base.decisions };
    }
    // The decision log: the older single document's entries plus one document per entry since, newest last.
    async function loadPolicy(code, meta, decKeys) {
        const f = await loadPolicyFields(code, meta);
        const keys = decKeys || entries(await store.list(`i/${code}/dec/`)).map(e => e.key);
        const extra = keys.length ? await getEach(store, keys) : [];
        const fromDocs = keys.map((k, i) => ({ k, d: extra[i] })).filter(x => x.d).sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0).map(x => x.d);
        const decisions = f.legacyDecisions.concat(fromDocs).slice(-DECISIONS_MAX);
        return { policy: f.policy, policyAt: f.policyAt, decisions };
    }
    // The map markings: one document per marking (v0.19.10) laid over the older single document, if there is one.
    // When they last changed (and who changed them) is its own small document, so a phone's report only needs the
    // markings themselves when that time differs from the one the phone already has.
    async function loadMarksAt(code, meta) {
        const st = await store.get(keyPol(code, 'marks'));
        if (st) return { marksAt: st.at || 0, by: st.by || '' };
        if ((meta && meta.v) >= 2) return { marksAt: 0, by: '' };
        const d = await store.get(keyMarks(code));
        return d ? { marksAt: d.marksAt || 0, by: d.by || '' } : { marksAt: meta.marksAt || 0, by: '' };
    }
    async function loadMarks(code, meta, mkKeys) {
        const fresh = (meta && meta.v) >= 2;
        const keys = mkKeys || entries(await store.list(`i/${code}/mk/`)).map(e => e.key);
        const vals = await getEach(store, [keyPol(code, 'marks')].concat(fresh ? [] : [keyMarks(code)], keys));
        const st = vals[0];
        const legacyDoc = fresh ? null : vals[1];
        const own = vals.slice(fresh ? 1 : 2).filter(Boolean);
        // Once an older incident's markings have been copied into their own documents, the older copy is ignored.
        const older = (st && st.migrated) || fresh ? [] : (legacyDoc ? legacyDoc.marks || [] : meta.marks || []);
        const byId = new Map();
        older.forEach(m => { if (m && m.id) byId.set(m.id, m); });
        own.forEach(m => { if (m && m.id) byId.set(m.id, m); });
        const marks = lib.normaliseMapMarks(Array.from(byId.values()).sort((a, b) => ((a.at || 0) - (b.at || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
        const marksAt = st ? st.at || 0 : (legacyDoc ? legacyDoc.marksAt || 0 : (fresh ? 0 : meta.marksAt || 0));
        const by = st ? st.by || '' : (legacyDoc ? legacyDoc.by || '' : '');
        return { marks, marksAt, by };
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
        if (body.keys !== true) return error(400, 'old_app', OLD_APP_MSG);
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
        // v: 2 marks an incident made from v0.19.10, which never has the older single decision or markings documents.
        const meta = { v: 2, code, salt, keySecret: crypto.randomBytes(16).toString('hex'), pinHash: hashPin(salt, pin), cmdHash: hashPin(salt, commanderPin), viewHash: hashPin(salt, viewPin), name: str(body.name, 80), incidentCode: lib.normaliseIncidentCode(body.incidentCode), training: !!body.training, createdAt: t, updatedAt: t, createdBy: { deviceId, triager: str(body.triager, 80) }, ccs: null, methane: null, seq: 1 };
        await store.set(keyMeta(code), meta);
        await store.set(keyDev(code, deviceId), Object.assign({ deviceId, triager: str(body.triager, 80), role: 'creator', joinedAt: t, lastSeen: t, records: 0, app: str(body.app, 40), keyed: true }));
        log('created', code);
        return reply(201, { code, pin, commanderPin, viewPin, deviceKey: deviceKey(meta, deviceId), accessKey: accessKey(meta, 'commander'), createdAt: t, expiresAt: t + TTL_MS, ttlMs: TTL_MS });
    }

    async function join(code, pin, body, client, key) {
        const a = await authed(code, pin, client, 'member', key);
        if (a.status) return a;
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        if (body.keys !== true || !a.meta.keySecret) return error(400, 'old_app', OLD_APP_MSG);
        const existing = await store.get(keyDev(code, deviceId));
        if (!existing) {
            const devs = entries(await store.list(`i/${code}/d/`));
            if (devs.length >= MAX_DEVICES_PER_INCIDENT) return error(409, 'too_many_devices', 'This incident already has the maximum number of phones.');
        }
        const t = now();
        // A device code already used by a phone that holds its device key cannot be taken over by another phone.
        if (existing && existing.keyed && !(body.deviceKey && safeEqual(String(body.deviceKey), deviceKey(a.meta, deviceId)))) return error(409, 'device_taken', 'Another phone in this incident already uses this device code. Change the device code on this phone (⚙ Settings) and join again.');
        // Every phone that joins gets a device key; a device code joined unkeyed before v0.19.10 is keyed from now on.
        const devDoc = Object.assign({ role: 'member', joinedAt: t, records: 0 }, existing || {}, { deviceId, triager: str(body.triager, 80) || (existing && existing.triager) || '', lastSeen: t, app: str(body.app, 40), keyed: true });
        delete devDoc.oldApp;
        await store.set(keyDev(code, deviceId), devDoc);
        log('joined', code, deviceId);
        return reply(200, { ok: true, code, name: a.meta.name, incidentCode: a.meta.incidentCode, training: a.meta.training, createdAt: a.meta.createdAt, expiresAt: a.meta.updatedAt + TTL_MS, level: a.level, deviceKey: deviceKey(a.meta, deviceId), accessKey: accessKey(a.meta, a.level) });
    }

    async function push(code, pin, body, client, key, devKey) {
        const a = await authed(code, pin, client, 'member', key);
        if (a.status) return a;
        const meta = a.meta;
        const deviceId = str(body.deviceId, 16);
        if (!deviceId) return error(400, 'bad_request', 'deviceId is required.');
        const devBefore = await store.get(keyDev(code, deviceId));
        // Only a phone that has joined, and holds its device key, can send (v0.19.9 stress test: any device code,
        // even one that never joined, could send or overwrite records; and a report without a join made an unlabelled phone).
        if (!devBefore || !devBefore.keyed || !(devKey && safeEqual(String(devKey), deviceKey(meta, deviceId)))) return error(403, 'device_key', 'This phone\'s link to the incident is out of date. Join the incident again.');
        // Phone clocks can be wrong. updatedAt decides which copy of a record wins, so it is moved onto the
        // server's clock (by how far the phone's clock is out) and never allowed into the future.
        const skew = num(body.clientNow) !== null ? now() - num(body.clientNow) : 0;
        const fixing = Math.abs(skew) > CLOCK_FIX_MS;
        const fixTime = (v) => { let x = num(v) || 0; if (fixing) x += skew; return Math.min(x, now()); };
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
            if (fixing) { if (num(rec.timestamp)) rec.timestamp = fixTime(rec.timestamp); if (num(rec.createdAt)) rec.createdAt = fixTime(rec.createdAt); }
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
        const dev = (await store.get(keyDev(code, deviceId))) || devBefore;
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
        // Map markings ride back on reports and heartbeats, so linked phones pick them up without another request.
        // A phone that says which markings it has (marksAt, from v0.19.10) gets them only when they have changed.
        const phoneMarksAt = num(body.marksAt);
        const [pol, mAt, clr] = await Promise.all([loadPolicyFields(code, m), loadMarksAt(code, m), dev.duress ? store.get(keyClear(code, deviceId)) : null]);
        const mk = phoneMarksAt !== null && phoneMarksAt === mAt.marksAt ? null : await loadMarks(code, m);
        const out = { ok: true, accepted, kept, rejected, serverTime: t, expiresAt: m.updatedAt + TTL_MS, marksAt: mk ? mk.marksAt : mAt.marksAt, policy: pol.policy, policyAt: pol.policyAt, duress: withClear(dev.duress, clr) || null, clockSkewMs: Math.round(skew) };
        if (mk) out.marks = mk.marks;
        return reply(200, out);
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
        const extra = all.filter(e => e.key === keyPolicy(code) || e.key === keyMarks(code) || e.key.startsWith(`i/${code}/dc/`) || e.key.startsWith(`i/${code}/pol/`) || e.key.startsWith(`i/${code}/dec/`) || e.key.startsWith(`i/${code}/mk/`));
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
        // Only the newest entries of the decision log are read and shown; none is ever deleted before the incident is
        // (v0.19.10 retest: pruning removed decisions from the record), so the cost of a read stays bounded.
        const decKeys = extra.filter(e => e.key.indexOf('/dec/') > -1).map(e => e.key).sort().slice(-DECISIONS_MAX);
        const [pol, mk] = await Promise.all([loadPolicy(code, meta, decKeys), loadMarks(code, meta, extra.filter(e => e.key.indexOf('/mk/') > -1).map(e => e.key))]);
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
            await store.set(keyClear(code, deviceId), clr);
            await addDecision(code, a.meta, { what: 'duress-cleared', device: deviceId, triager: dev.triager || '', by });
            await touchMeta(code);
            log('duress-cleared', code, deviceId);
        }
        return reply(200, { ok: true, duress: withClear(dev.duress, clr) || null });
    }
    // Every commander decision is kept with who made it and when (shown on the commander screen).
    async function addDecision(code, meta, d) {
        const at = now();
        await store.set(decKey(code, at), Object.assign({ at }, d));
    }

    // Commander screen: add or remove map markings (cordons, RVP, loading point...). Commander PIN only.
    // From v0.19.10 the screen sends only what changed ({ add: [...] } or { remove: [ids] }) and each marking is its
    // own document, so two people marking the map at once both keep their changes (v0.19.9 stress test). A screen
    // still on an older version sends the whole list ({ marks: [...] }), which replaces what is there, as before.
    async function setMarks(code, pin, body, client, key) {
        const a = await authed(code, pin, client, 'commander', key);
        if (a.status) return a;
        const by = str(body.by, 80).trim();
        if (!by) return error(400, 'bad_request', 'Say who is changing the map markings.');
        const t = now();
        const meta = a.meta;
        const cur = await loadMarks(code, meta);
        // A marking sent without an id gets one; the list position is part of it, so markings sent together keep their order.
        const withId = (m, i) => (m && typeof m === 'object' && !m.id) ? Object.assign({}, m, { id: 's' + t.toString(36) + String(i).padStart(2, '0') + crypto.randomBytes(3).toString('hex') }) : m;
        let add = [], remove = [];
        if (Array.isArray(body.add) || Array.isArray(body.remove)) {
            add = lib.normaliseMapMarks((Array.isArray(body.add) ? body.add : []).map(withId));
            remove = (Array.isArray(body.remove) ? body.remove : []).map(x => str(x, 24).replace(/[^A-Za-z0-9_-]/g, '')).filter(Boolean);
        } else if (Array.isArray(body.marks)) {
            add = lib.normaliseMapMarks(body.marks.map(withId));
            const keep = new Set(add.map(m => m.id));
            remove = cur.marks.filter(m => !keep.has(m.id)).map(m => m.id);
        } else return error(400, 'bad_request', 'Nothing to change.');
        add.forEach(m => { m.at = m.at || t; });
        const gone = new Set(remove);
        const after = new Map(cur.marks.filter(m => !gone.has(m.id)).map(m => [m.id, m]));
        add.forEach(m => after.set(m.id, m));
        if (after.size > lib.MAP_MARKS_MAX) return error(409, 'too_many_marks', `The map can hold at most ${lib.MAP_MARKS_MAX} markings. Remove one first.`);
        // An older incident's markings move into their own documents the first time they are changed.
        const olderIncident = !((meta.v || 0) >= 2);
        const migrate = olderIncident && !((await store.get(keyPol(code, 'marks'))) || {}).migrated;
        const toWrite = migrate ? Array.from(after.values()) : add;
        await setEach(store, toWrite.map(m => [keyMark(code, m.id), m]));
        if (remove.length) await deleteEach(store, remove.map(id => keyMark(code, id)));
        // Two screens adding at the same moment could each see room for one more and together pass the limit (v0.19.10
        // retest: the extra markings were then hidden). Checked again after writing: if over, this change is taken back.
        const newIds = add.map(m => m.id).filter(id => !cur.marks.some(m => m.id === id));
        if (newIds.length && entries(await store.list(`i/${code}/mk/`)).length > lib.MAP_MARKS_MAX) {
            await deleteEach(store, newIds.map(id => keyMark(code, id)));
            return error(409, 'too_many_marks', `The map can hold at most ${lib.MAP_MARKS_MAX} markings. Remove one first.`);
        }
        await store.set(keyPol(code, 'marks'), olderIncident ? { at: t, by, migrated: true } : { at: t, by });
        await addDecision(code, meta, { what: 'marks', count: after.size, added: add.length, removed: remove.length, by });
        await touchMeta(code);
        const marks = (await loadMarks(code, meta)).marks;
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
        // Each field is its own document and each log entry its own document: nothing here reads and rewrites.
        const writes = [];
        if (p1By) {
            writes.push([keyPol(code, 'p1hold'), { on: !!body.p1Hold.on, at: t, by: p1By }]);
            writes.push([decKey(code, t), { at: t, what: body.p1Hold.on ? 'p1hold-on' : 'p1hold-off', by: p1By }]);
        }
        if (mittBy) {
            writes.push([keyPol(code, 'mitt'), { id: t.toString(36) + crypto.randomBytes(3).toString('hex'), at: t, by: mittBy, groups }]);
            writes.push([decKey(code, t), { at: t, what: 'mitt', groups, by: mittBy }]);
        }
        await setEach(store, writes);
        const out = lib.normalisePolicy((await loadPolicyFields(code, a.meta)).policy);
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
                    let gone;
                    if (pre === 'rc/') { const f = await store.get(k); gone = !f || now() - (f.since || 0) > CREATE_WINDOW_MS; }
                    else { const day = Number(k.split('/')[2]); gone = !(day >= dayOf(now()) - 1); } // counts from before yesterday (or an older format)
                    if (gone) { await store.delete(k); locks++; }
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
        client = rateClient(client || 'unknown');
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
    let ops = 0;
    const wait = () => { ops++; const ms = (opts.delay || 0) + (opts.jitter ? Math.random() * opts.jitter : 0); return ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve(); };
    return {
        async get(k) { await wait(); return m.has(k) ? JSON.parse(m.get(k)) : null; },
        async set(k, v) { await wait(); m.set(k, JSON.stringify(v)); },
        async delete(k) { await wait(); m.delete(k); },
        // Counters: added to atomically (nothing is awaited between the read and the write here).
        async incr(k, fields) { await wait(); const cur = m.has(k) ? JSON.parse(m.get(k)) : { n: {} }; const n = cur.n || {}; Object.keys(fields).forEach(f => { n[f] = (n[f] || 0) + fields[f]; }); m.set(k, JSON.stringify({ n })); },
        async counts(keys) { await wait(); return keys.map(k => m.has(k) ? (JSON.parse(m.get(k)).n || null) : null); },
        async list(prefix) { await wait(); return Array.from(m.keys()).filter(k => k.startsWith(prefix)).sort().map(k => ({ key: k, etag: crypto.createHash('sha1').update(m.get(k)).digest('hex').slice(0, 12) })); },
        size() { return m.size; },
        ops() { return ops; },
    };
}

module.exports = { createCore, memoryStore, normaliseCode, normalisePin, TTL_MS, STALE_DEVICE_MS };
