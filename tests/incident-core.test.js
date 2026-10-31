// Tests for the incident commander backend (netlify/lib/incident-core.js) with an in-memory store.
// Usage: node tests/incident-core.test.js
// tests/firestore-store.test.js runs this same suite through the Firestore store by setting global.__makeIncidentStore.
const assert = require('assert');
const { createCore: createCoreRaw, memoryStore, TTL_MS, STALE_DEVICE_MS } = require('../netlify/lib/incident-core.js');
// Phones send their device key with every report (v0.19.6). This wrapper plays that part: it keeps the keys
// handed out by create and join, and adds the right one to each report, as the phone does.
function createCore(o) {
    const core = createCoreRaw(o);
    const keys = {};
    const handle = core.handle;
    core.handle = async (method, path, headers, bodyText, client) => {
        const m = /^\/api\/incident\/?([A-Za-z0-9]*)\/?([a-z-]*)/.exec(path) || [];
        const code = String(m[1] || '').toUpperCase(), action = m[2] || '';
        let body = {}; try { body = JSON.parse(bodyText || '{}') || {}; } catch (e) {}
        // v0.19.8 phones say they use device keys when they create or join; a test sends keys: false to play an old app.
        if (method === 'POST' && (action === 'join' || !code) && body && typeof body === 'object' && body.keys === undefined) { body.keys = true; bodyText = JSON.stringify(body); }
        if (body && body.keys === false) { delete body.keys; bodyText = JSON.stringify(body); }
        if (action === 'records' && body && body.deviceId && keys[code + '/' + body.deviceId] && !(headers || {})['x-device-key']) headers = Object.assign({}, headers, { 'x-device-key': keys[code + '/' + body.deviceId] });
        const r = await handle(method, path, headers, bodyText, client);
        if (r.body && r.body.deviceKey && (r.body.code || code) && body.deviceId) keys[(r.body.code || code) + '/' + body.deviceId] = r.body.deviceKey;
        return r;
    };
    return core;
}

// Each call must give an empty store. memoryStore's options (delay, jitter) only apply to the in-memory store.
const makeStore = (opts) => (global.__makeIncidentStore ? global.__makeIncidentStore(opts) : memoryStore(opts));

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name); console.error('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e)); failed++; }
}
function rec(uid, id, category, extra) {
    return Object.assign({ uid, id, category, tool: 'TST', timestamp: 1760000000000, updatedAt: 1760000000000, triager: 'Medic A', sector: 'Platform 2', currentLocation: { lat: 53.4808, lng: -2.2426, acc: 8, timestamp: 1760000000000 } }, extra || {});
}

(async () => {
    console.log('\nincident-core: lifecycle');
    let clock = 1760000000000;
    const store = makeStore();
    const core = createCore({ store, now: () => clock });
    const H = (pin) => ({ 'x-incident-pin': pin });
    let code = '', pin = '', cpin = '';
    await test('create returns a 6-char code and a 6-digit PIN', async () => {
        const r = await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA', triager: 'Medic A', name: 'Station fire', incidentCode: 'ex-1', app: '0.10.0' }), '1.1.1.1');
        assert.strictEqual(r.status, 201);
        assert.match(r.body.code, /^[A-HJ-NP-Z2-9]{6}$/);
        assert.match(r.body.pin, /^\d{6}$/);
        assert.strictEqual(r.body.expiresAt, clock + TTL_MS);
        code = r.body.code; pin = r.body.pin; cpin = r.body.commanderPin;
    });
    await test('create needs a deviceId', async () => {
        assert.strictEqual((await core.handle('POST', '/api/incident', {}, JSON.stringify({}), '1.1.1.1')).status, 400);
    });
    await test('reading with no PIN or the wrong PIN is refused; the right PIN works', async () => {
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, {}, '', '2.2.2.2')).status, 401);
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, H('000000'), '', '2.2.2.2')).status, 401);
        const r = await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.name, 'Station fire');
        assert.strictEqual(r.body.incidentCode, 'EX-1');
        assert.deepStrictEqual(r.body.records, []);
        assert.strictEqual(r.body.devices.length, 1);
        assert.strictEqual(r.body.devices[0].role, 'creator');
        assert.strictEqual(r.headers['Cache-Control'], 'no-store');
    });
    await test('an unknown code gets the same 401 as a wrong PIN (does not say whether it exists); code is case-insensitive', async () => {
        const u = await core.handle('GET', '/api/incident/ZZZZZZ', H(pin), '', '2.2.2.2');
        const w = await core.handle('GET', `/api/incident/${code}`, H('123450'), '', '2.2.2.2');
        assert.strictEqual(u.status, 401);
        assert.strictEqual(w.status, 401);
        assert.strictEqual(u.body.message, w.body.message);
        assert.strictEqual((await core.handle('GET', `/api/incident/${code.toLowerCase()}`, H(pin), '', '2.2.2.2')).status, 200);
    });
    await test('a second phone joins and is listed', async () => {
        const r = await core.handle('POST', `/api/incident/${code}/join`, H(pin), JSON.stringify({ deviceId: 'DEVB', triager: 'Medic B' }), '3.3.3.3');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.name, 'Station fire');
        const g = await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2');
        assert.deepStrictEqual(g.body.devices.map(d => d.deviceId).sort(), ['DEVA', 'DEVB']);
    });
    let etag = '';
    await test('pushing records stores them, stamps the reporter, and sorts P1 first', async () => {
        clock += 1000;
        const r = await core.handle('PUT', `/api/incident/${code}/records`, H(pin), JSON.stringify({ deviceId: 'DEVA', triager: 'Medic A', totalRecords: 2, records: [rec('u3', 'DEVA-TST-003', 'P3'), rec('u1', 'DEVA-TST-001', 'P1', { notes: '<b>blast</b>' }), { uid: 'bad' }] }), '1.1.1.1');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.accepted, 2);
        assert.deepStrictEqual(r.body.rejected, ['bad']);
        const g = await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2');
        assert.deepStrictEqual(g.body.records.map(x => x.id), ['DEVA-TST-001', 'DEVA-TST-003']);
        assert.strictEqual(g.body.records[0].reportedBy, 'DEVA');
        assert.strictEqual(g.body.records[0].notes, '<b>blast</b>'); // stored as text; the page escapes on display
        assert.strictEqual(g.body.records[0].currentLocation.lat, '53.4808000');
        assert.strictEqual(g.body.devices.find(d => d.deviceId === 'DEVA').records, 2);
        etag = g.headers.ETag;
        assert.ok(etag);
    });
    await test('an unchanged incident answers 304 to If-None-Match; a push changes the ETag', async () => {
        const r = await core.handle('GET', `/api/incident/${code}`, Object.assign(H(pin), { 'if-none-match': etag }), '', '2.2.2.2');
        assert.strictEqual(r.status, 304);
        // Netlify's CDN rewrites the ETag it serves when it compresses the body ("2" -> "2-df"); that must still match.
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, Object.assign(H(pin), { 'if-none-match': etag.replace(/"$/, '-df"') }), '', '2.2.2.2')).status, 304);
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, Object.assign(H(pin), { 'if-none-match': 'W/' + etag }), '', '2.2.2.2')).status, 304);
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, Object.assign(H(pin), { 'if-none-match': '"999"' }), '', '2.2.2.2')).status, 200);
        // The edge drops a suffixed If-None-Match altogether, so the page's own X-Incident-Seq header must work on its own.
        const seq = etag.replace(/"/g, '');
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, Object.assign(H(pin), { 'x-incident-seq': seq }), '', '2.2.2.2')).status, 304);
        const full = await core.handle('GET', `/api/incident/${code}`, Object.assign(H(pin), { 'x-incident-seq': '0' }), '', '2.2.2.2');
        assert.strictEqual(full.status, 200);
        assert.strictEqual(full.headers['X-Incident-Seq'], seq);
        assert.strictEqual(String(full.body.seq), seq);
        clock += 1000;
        await core.handle('PUT', `/api/incident/${code}/records`, H(pin), JSON.stringify({ deviceId: 'DEVB', records: [rec('u9', 'DEVB-TST-001', 'P2')] }), '3.3.3.3');
        const r2 = await core.handle('GET', `/api/incident/${code}`, Object.assign(H(pin), { 'if-none-match': etag }), '', '2.2.2.2');
        assert.strictEqual(r2.status, 200);
        assert.notStrictEqual(r2.headers.ETag, etag);
        assert.strictEqual(r2.body.records.length, 3);
    });
    await test('an older copy of a record never overwrites a newer one', async () => {
        const newer = rec('u1', 'DEVA-TST-001', 'P2', { updatedAt: 1760000005000, notes: 'newer' });
        const older = rec('u1', 'DEVA-TST-001', 'P1', { updatedAt: 1760000001000, notes: 'older' });
        await core.handle('PUT', `/api/incident/${code}/records`, H(pin), JSON.stringify({ deviceId: 'DEVB', records: [newer] }), '3.3.3.3');
        const r = await core.handle('PUT', `/api/incident/${code}/records`, H(pin), JSON.stringify({ deviceId: 'DEVA', records: [older] }), '1.1.1.1');
        assert.strictEqual(r.body.kept, 1);
        const g = await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2');
        const u1 = g.body.records.find(x => x.uid === 'u1');
        assert.strictEqual(u1.notes, 'newer');
        assert.strictEqual(u1.category, 'P2');
    });
    await test('the CCS position is stored with the push', async () => {
        await core.handle('PUT', `/api/incident/${code}/records`, H(pin), JSON.stringify({ deviceId: 'DEVA', records: [], ccs: { lat: 53.49, lng: -2.25, acc: 5 } }), '1.1.1.1');
        const g = await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2');
        assert.strictEqual(g.body.ccs.lat, '53.4900000');
        assert.strictEqual(g.body.ccs.setBy, 'DEVA');
    });
    await test('a phone that has not reported for 5 minutes is flagged stale', async () => {
        clock += STALE_DEVICE_MS + 1000;
        await core.handle('PUT', `/api/incident/${code}/records`, H(pin), JSON.stringify({ deviceId: 'DEVA', records: [] }), '1.1.1.1');
        const g = await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2');
        assert.strictEqual(g.body.devices.find(d => d.deviceId === 'DEVA').stale, false);
        assert.strictEqual(g.body.devices.find(d => d.deviceId === 'DEVB').stale, true);
    });
    await test('bad JSON, oversized bodies and too many records are refused', async () => {
        assert.strictEqual((await core.handle('PUT', `/api/incident/${code}/records`, H(pin), '{nope', '1.1.1.1')).status, 400);
        assert.strictEqual((await core.handle('PUT', `/api/incident/${code}/records`, H(pin), 'x'.repeat(600 * 1024), '1.1.1.1')).status, 413);
        const many = Array.from({ length: 251 }, (_, i) => rec('m' + i, 'M-' + i, 'P3'));
        assert.strictEqual((await core.handle('PUT', `/api/incident/${code}/records`, H(pin), JSON.stringify({ deviceId: 'DEVA', records: many }), '1.1.1.1')).status, 413);
    });
    await test('25 wrong PINs from one client lock it out for 15 minutes; others are unaffected', async () => {
        for (let i = 0; i < 25; i++) await core.handle('GET', `/api/incident/${code}`, H('111111'), '', '9.9.9.9');
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, H(pin), '', '9.9.9.9')).status, 429);
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2')).status, 200);
        clock += 15 * 60 * 1000 + 1;
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, H(pin), '', '9.9.9.9')).status, 200);
    });
    await test('close deletes everything; the code then reads as ended (410), not unknown', async () => {
        const r = await core.handle('POST', `/api/incident/${code}/close`, H(cpin), '', '1.1.1.1');
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.deleted >= 6);
        assert.strictEqual((await store.list('i/')).length, 0);
        const g = await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2');
        assert.strictEqual(g.status, 410);
        assert.strictEqual(g.body.error, 'ended');
    });
    await test('an incident with no writes for 24 hours is deleted on access (410) and by the sweep', async () => {
        const c1 = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        const c2 = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        clock += TTL_MS - 1000;
        await core.handle('PUT', `/api/incident/${c2.code}/records`, H(c2.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('k1', 'K-1', 'P3', { updatedAt: clock })] }), '1.1.1.1'); // new information keeps c2 alive
        clock += 2000;
        assert.strictEqual((await core.handle('GET', `/api/incident/${c1.code}`, H(c1.pin), '', '2.2.2.2')).status, 410);
        const c3 = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        clock += TTL_MS - 3000;
        await core.handle('PUT', `/api/incident/${c2.code}/records`, H(c2.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('k2', 'K-2', 'P3', { updatedAt: clock })] }), '1.1.1.1'); // keeps c2 alive again
        clock += 4000; // c3 is now past its 24 hours; c2 was written 4 s ago
        const sweep = await core.cleanup();
        assert.strictEqual(sweep.incidents, 2);
        const g3 = await core.handle('GET', `/api/incident/${c3.code}`, H(c3.pin), '', '2.2.2.2');
        assert.strictEqual(g3.status, 410);
        assert.strictEqual(g3.body.error, 'expired');
        assert.strictEqual((await core.handle('GET', `/api/incident/${c2.code}`, H(c2.pin), '', '2.2.2.2')).status, 200);
    });
    await test('unknown endpoints are 404 and never leak the PIN hash', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        assert.strictEqual((await core.handle('DELETE', `/api/incident/${c.code}`, H(c.pin), '', '1.1.1.1')).status, 404);
        const g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(JSON.stringify(g.body).indexOf('pinHash'), -1);
        assert.strictEqual(JSON.stringify(g.body).indexOf('salt'), -1);
    });

    console.log('\nincident-core: v0.14.0 reliability');
    await test('the view-only PIN can read but not join, push or close; the commander PIN still does everything', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA', triager: 'Medic A' }), '1.1.1.1')).body;
        assert.match(c.viewPin, /^\d{6}$/);
        assert.notStrictEqual(c.viewPin, c.pin);
        const g = await core.handle('GET', `/api/incident/${c.code}`, H(c.viewPin), '', '2.2.2.2');
        assert.strictEqual(g.status, 200);
        assert.strictEqual(g.body.viewOnly, true);
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '2.2.2.2')).body.viewOnly, false);
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.viewOnly, true, 'the triagers\' PIN opens the screen view only');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/join`, H(c.viewPin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3')).status, 403);
        assert.strictEqual((await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.viewPin), JSON.stringify({ deviceId: 'DEVA', records: [rec('v1', 'A-1', 'P1')] }), '1.1.1.1')).status, 403);
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/close`, H(c.viewPin), '', '1.1.1.1')).status, 403);
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.records.length, 0);
        // a refused view-only write is not a wrong PIN: it never counts towards the lock-out
        for (let i = 0; i < 30; i++) await core.handle('POST', `/api/incident/${c.code}/close`, H(c.viewPin), '', '7.7.7.7');
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '7.7.7.7')).status, 200);
    });
    await test('METHANE sent by a phone appears on the commander read; the newest one wins', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA', triager: 'Medic A' }), '1.1.1.1')).body;
        const m1 = { m: 'DECLARED', e: 'Platform 2', t: 'Train derailment', h: 'Live rails', a: 'Via the car park', n: 'About 20', e_svc: 'Fire, police', timestamp: clock - 60000, by: 'Medic A' };
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], methane: m1 }), '1.1.1.1');
        await core.handle('POST', `/api/incident/${c.code}/join`, H(c.pin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3');
        const older = Object.assign({}, m1, { n: 'About 5', timestamp: clock - 120000, by: 'Medic B' });
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVB', records: [], methane: older }), '3.3.3.3');
        const g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(g.body.methane.n, 'About 20');
        assert.strictEqual(g.body.methane.device, 'DEVA');
        assert.strictEqual(g.body.devices.find(d => d.deviceId === 'DEVB').methane.n, 'About 5');
        const junk = await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], methane: { m: 'x'.repeat(5000), timestamp: 'soon' } }), '1.1.1.1');
        assert.strictEqual(junk.status, 200);
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.methane.n, 'About 20', 'junk METHANE ignored');
    });
    await test('a phone reports its battery; the commander read carries it', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('c1', 'A-1', 'P3', { cardNo: '0427' })], battery: 7.6, charging: false }), '1.1.1.1');
        const g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(g.body.devices[0].battery, 8);
        assert.strictEqual(g.body.devices[0].charging, false);
        assert.strictEqual(g.body.records[0].cardNo, '0427');
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], battery: 'full' }), '1.1.1.1');
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.devices[0].battery, 8, 'junk ignored, last value kept');
    });
    await test('v0.18.0: a phone shares its position (opt-in), removes it with null, and junk is ignored', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], position: { lat: 52.4862123456, lng: -1.8904, acc: 12.4, timestamp: 1700000000000 } }), '1.1.1.1');
        let g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.deepStrictEqual({ lat: g.body.devices[0].position.lat, lng: g.body.devices[0].position.lng, acc: g.body.devices[0].position.acc, timestamp: g.body.devices[0].position.timestamp }, { lat: 52.486212, lng: -1.8904, acc: 12, timestamp: 1700000000000 });
        assert.ok(g.body.devices[0].position.at > 0);
        const seq1 = g.headers['X-Incident-Seq'];
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], position: { lat: 'north', lng: -1.89 } }), '1.1.1.1');
        g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(g.body.devices[0].position.lat, 52.486212, 'junk ignored, last position kept');
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], position: { lat: 95, lng: 0 } }), '1.1.1.1');
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.devices[0].position.lat, 52.486212, 'out-of-range ignored');
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [] }), '1.1.1.1');
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.devices[0].position.lat, 52.486212, 'a report without a position keeps the last one');
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], position: null }), '1.1.1.1');
        g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(g.body.devices[0].position, undefined, 'null removes it');
        assert.notStrictEqual(g.headers['X-Incident-Seq'], seq1, 'the commander screen sees the change');
    });
    await test('v0.18.0: duress is raised by the phone, acknowledged by the commander, and cleared by the phone', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA', triager: 'Medic A' }), '1.1.1.1')).body;
        const r1 = await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], duress: { at: 1700000000000, position: { lat: 52.5, lng: -1.9, acc: 8 } } }), '1.1.1.1');
        assert.strictEqual(r1.status, 200);
        assert.strictEqual(r1.body.duress.at, 1700000000000);
        assert.strictEqual(r1.body.duress.clearedAt, undefined);
        let g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(g.body.devices[0].duress.position.lat, 52.5);
        // A repeat of the same duress (every heartbeat) does not reset it
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], duress: { at: 1700000000000 } }), '1.1.1.1');
        const raisedAt = (await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.devices[0].duress.raisedAt;
        assert.strictEqual(raisedAt, g.body.devices[0].duress.raisedAt);
        // View-only PIN cannot acknowledge
        const viewOnly = await core.handle('POST', `/api/incident/${c.code}/duress-clear`, H(c.viewPin), JSON.stringify({ deviceId: 'DEVA' }), '3.3.3.3');
        assert.strictEqual(viewOnly.status, 403);
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/duress-clear`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', by: 'X' }), '3.3.3.3')).status, 403, 'the triagers\' PIN cannot');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/duress-clear`, H(c.commanderPin), JSON.stringify({ deviceId: 'DEVA' }), '3.3.3.3')).status, 400, 'a name is required');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/duress-clear`, H(c.commanderPin), JSON.stringify({ deviceId: 'NOPE', by: 'X' }), '3.3.3.3')).status, 404);
        const ack = await core.handle('POST', `/api/incident/${c.code}/duress-clear`, H(c.commanderPin), JSON.stringify({ deviceId: 'DEVA', by: 'Silver, Insp Kaur' }), '3.3.3.3');
        assert.strictEqual(ack.status, 200);
        assert.ok(ack.body.duress.clearedAt > 0);
        assert.strictEqual(ack.body.duress.clearedBy, 'Silver, Insp Kaur');
        // The phone's next heartbeat (still repeating the same duress) sees it cleared and does not re-raise it
        const r2 = await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], duress: { at: 1700000000000 } }), '1.1.1.1');
        assert.ok(r2.body.duress.clearedAt > 0, 'phone is told the commander cleared it');
        // A new call for help after a cleared one is a fresh alert
        const r3 = await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], duress: { at: 1700000500000 } }), '1.1.1.1');
        assert.strictEqual(r3.body.duress.clearedAt, undefined);
        assert.strictEqual(r3.body.duress.at, 1700000500000);
        // The phone clears it
        const r4 = await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], duress: null }), '1.1.1.1');
        assert.strictEqual(r4.body.duress, null);
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.devices[0].duress, undefined);
    });
    await test('v0.19.0: the commander allows P1 Hold and sends a MITT prompt; phones get both in their push reply', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        let r = await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], sector: 'Casualty Clearing', userRole: 'HCP' }), '1.1.1.1');
        assert.deepStrictEqual(r.body.policy, {});
        assert.strictEqual(r.body.policyAt, 0);
        let g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(g.body.devices[0].sector, 'Casualty Clearing');
        assert.strictEqual(g.body.devices[0].userRole, 'HCP');
        assert.strictEqual(g.body.devices[0].commander, undefined, 'not the commander unless the phone says so');
        // v0.19.4: the commander's own phone says so, and can say it is no longer
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], commander: true }), '1.1.1.1');
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.devices[0].commander, true);
        await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], commander: false }), '1.1.1.1');
        g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(g.body.devices[0].commander, undefined);
        const seq1 = g.headers['X-Incident-Seq'];
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.viewPin), JSON.stringify({ p1Hold: { on: true, by: 'X' } }), '3.3.3.3')).status, 403, 'view-only PIN cannot');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ p1Hold: { on: true } }), '3.3.3.3')).status, 400, 'a name is required');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ mitt: { groups: ['junk'], by: 'X' } }), '3.3.3.3')).status, 400, 'groups are required');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ mitt: { groups: ['hcp'] } }), '3.3.3.3')).status, 400, 'a name is required for a MITT prompt');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.pin), JSON.stringify({ p1Hold: { on: true, by: 'X' } }), '3.3.3.3')).status, 403, 'the triagers\' PIN cannot');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({}), '3.3.3.3')).status, 400);
        const p1 = await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ p1Hold: { on: true, by: 'Dr Medic, MERIT' } }), '3.3.3.3');
        assert.strictEqual(p1.status, 200);
        assert.strictEqual(p1.body.policy.p1Hold.on, true);
        assert.strictEqual(p1.body.policy.p1Hold.by, 'Dr Medic, MERIT');
        const p2 = await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ mitt: { groups: ['sector:Casualty Clearing'], by: 'Silver' } }), '3.3.3.3');
        assert.strictEqual(p2.body.policy.p1Hold.on, true, 'the P1 Hold decision is kept');
        assert.deepStrictEqual(p2.body.policy.mitt.groups, ['sector:Casualty Clearing']);
        assert.ok(p2.body.policy.mitt.id);
        r = await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [] }), '1.1.1.1');
        assert.strictEqual(r.body.policy.mitt.id, p2.body.policy.mitt.id);
        assert.strictEqual(r.body.policyAt, p2.body.policyAt);
        g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.notStrictEqual(g.headers['X-Incident-Seq'], seq1);
        assert.strictEqual(g.body.policy.p1Hold.on, true);
        assert.strictEqual(g.body.devices[0].sector, 'Casualty Clearing', 'a report without a sector keeps the last one');
        const p3 = await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ mitt: { groups: ['hcp'], by: 'Silver' } }), '3.3.3.3');
        assert.notStrictEqual(p3.body.policy.mitt.id, p2.body.policy.mitt.id, 'every prompt is new');
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ p1Hold: { on: false } }), '3.3.3.3')).status, 400, 'a withdrawal needs a name too');
        const off = await core.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ p1Hold: { on: false, by: 'Dr Medic, MERIT' } }), '3.3.3.3');
        assert.strictEqual(off.body.policy.p1Hold.on, false);
        const dec = (await core.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '2.2.2.2')).body.decisions;
        assert.deepStrictEqual(dec.map(d => d.what + ':' + d.by), ['p1hold-on:Dr Medic, MERIT', 'mitt:Silver', 'mitt:Silver', 'p1hold-off:Dr Medic, MERIT']);
    });
    await test('a push of 250 records lands in one go; a uid sent twice in one push keeps the newer copy', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        const recs = Array.from({ length: 249 }, (_, i) => ({ uid: 'b' + i, id: 'B-' + i, category: 'P3', updatedAt: 1000 + i }));
        recs.push({ uid: 'b0', id: 'B-0', category: 'P1', updatedAt: 5000 });
        const r = await core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: recs }), '1.1.1.1');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.accepted, 249);
        const g = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.strictEqual(g.body.records.length, 249);
        assert.strictEqual(g.body.records.find(x => x.uid === 'b0').category, 'P1');
        const closed = await core.handle('POST', `/api/incident/${c.code}/close`, H(c.commanderPin), '{}', '1.1.1.1');
        assert.strictEqual(closed.body.deleted, 253); // 249 records, meta, phone, change numbers (v0.19.12) and one change-feed entry
    });
    await test('two phones pushing at the same moment never leave the commander screen a change behind', async () => {
        // A store where every operation takes a little time, so the two pushes interleave as they would on Netlify.
        const slow = makeStore({ jitter: 3 });
        const core2 = createCore({ store: slow, now: () => clock });
        const c = (await core2.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        await core2.handle('POST', `/api/incident/${c.code}/join`, H(c.pin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3');
        let known = '', seen = [];
        const poll = async () => { const r = await core2.handle('GET', `/api/incident/${c.code}`, Object.assign(H(c.pin), { 'x-incident-seq': known }), '', '2.2.2.2'); if (r.status === 200) { known = r.headers['X-Incident-Seq']; seen = r.body.records.map(x => x.uid); } return r.status; };
        for (let round = 0; round < 25; round++) {
            clock += 1000;
            const a = core2.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('a' + round, 'A-' + round, 'P2')] }), '1.1.1.1');
            const b = core2.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVB', records: [rec('b' + round, 'B-' + round, 'P1')] }), '3.3.3.3');
            const mid = new Promise(r => setTimeout(r, 4)).then(poll);   // the commander reads while both are in flight
            await Promise.all([a, b, mid]);
            // Once both pushes have landed, a poll with what the commander already has must either return the full
            // data (200) or confirm the screen is complete (304 only if it already holds both records).
            const st = await poll();
            if (st === 304) { assert.ok(seen.includes('a' + round) && seen.includes('b' + round), `round ${round}: 304 but screen is behind`); }
            else assert.strictEqual(st, 200);
            assert.ok(seen.includes('a' + round) && seen.includes('b' + round), `round ${round}`);
        }
    });
    await test('the wrong-PIN lock-out survives a server restart, lifts in the next 15-minute window and is swept two days later', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        for (let i = 0; i < 25; i++) await core.handle('GET', `/api/incident/${c.code}`, H('000000'), '', '8.8.8.8');
        const fresh = createCore({ store, now: () => clock });   // a cold start with an empty memory and the same storage
        assert.strictEqual((await fresh.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '8.8.8.8')).status, 429);
        assert.strictEqual((await fresh.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).status, 200);
        assert.ok((await store.list('rl/')).length >= 1);
        assert.strictEqual(JSON.stringify(await store.list('rl/')).indexOf('8.8.8.8'), -1, 'the address itself is not stored');
        clock = (Math.floor(clock / (15 * 60 * 1000)) + 1) * 15 * 60 * 1000 + 1;   // the next 15-minute window
        assert.strictEqual((await fresh.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '8.8.8.8')).status, 200);
        // The day's counts are kept until the day after (so the daily limit holds), then swept.
        clock += 2 * 24 * 60 * 60 * 1000;
        const sw = await fresh.cleanup();
        assert.ok(sw.removedLocks >= 1);
        assert.strictEqual((await store.list('rl/')).length, 0);
        assert.strictEqual((await store.list('rk/')).length, 0);
    });
    await test('a store that only returns plain keys (no etags) still works and still notices changes', async () => {
        const plain = makeStore();
        const inner = plain.list.bind(plain);
        plain.list = async (p) => (await inner(p)).map(e => e.key);
        const core3 = createCore({ store: plain, now: () => clock });
        const c = (await core3.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        const g1 = await core3.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        clock += 1000;
        await core3.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('p1', 'A-1', 'P1')] }), '1.1.1.1');
        const g2 = await core3.handle('GET', `/api/incident/${c.code}`, Object.assign(H(c.pin), { 'x-incident-seq': g1.headers['X-Incident-Seq'] }), '', '2.2.2.2');
        assert.strictEqual(g2.status, 200);
        assert.strictEqual(g2.body.records.length, 1);
    });
    console.log('\nincident-core: v0.16.0 map markings and tag lookup');
    await test('the commander sets map markings; phones get them back on every push; the read carries them and its ETag changes', async () => {
        const core4 = createCore({ store: makeStore(), now: () => clock });
        const c = (await core4.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        const g1 = await core4.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        assert.deepStrictEqual(g1.body.marks, []);
        clock += 1000;
        const m = await core4.handle('POST', `/api/incident/${c.code}/marks`, H(c.commanderPin), JSON.stringify({ by: 'Silver', marks: [{ type: 'inner', lat: 52.45, lng: -1.9, radius: 150 }, { type: 'rvp', lat: 52.46, lng: -1.91, label: 'Main gate' }, { type: 'nonsense', lat: 1, lng: 1 }, { type: 'hazard', lat: 999, lng: 1 }] }), '2.2.2.2');
        assert.strictEqual(m.status, 200);
        assert.deepStrictEqual(m.body.marks.map(x => x.type), ['inner', 'rvp']);
        assert.strictEqual(m.body.marks[0].radius, 150);
        const p = await core4.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [] }), '1.1.1.1');
        assert.strictEqual(p.body.marks.length, 2);
        assert.strictEqual(p.body.marksAt, m.body.marksAt);
        const g2 = await core4.handle('GET', `/api/incident/${c.code}`, Object.assign(H(c.pin), { 'x-incident-seq': g1.headers['X-Incident-Seq'] }), '', '2.2.2.2');
        assert.strictEqual(g2.status, 200);
        assert.strictEqual(g2.body.marks[1].label, 'Main gate');
    });
    await test('the view-only PIN cannot change map markings or look up a tag', async () => {
        const core5 = createCore({ store: makeStore(), now: () => clock });
        const c = (await core5.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        assert.strictEqual((await core5.handle('POST', `/api/incident/${c.code}/marks`, H(c.viewPin), JSON.stringify({ marks: [] }), '2.2.2.2')).status, 403);
        assert.strictEqual((await core5.handle('POST', `/api/incident/${c.code}/lookup`, H(c.viewPin), JSON.stringify({ tag: 'X' }), '2.2.2.2')).status, 403);
    });
    await test('a tag lookup finds a record by exact patient ID or card number, not by partial match', async () => {
        const core6 = createCore({ store: makeStore(), now: () => clock });
        const c = (await core6.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        await core6.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('t1', 'A1B2-TST-001', 'P1', { cardNo: 'WM 004512' }), rec('t2', 'TAG-778', 'P2')] }), '1.1.1.1');
        const byCard = await core6.handle('POST', `/api/incident/${c.code}/lookup`, H(c.pin), JSON.stringify({ tag: 'wm 004512' }), '1.1.1.1');
        assert.strictEqual(byCard.status, 200);
        assert.deepStrictEqual(byCard.body.records.map(r => r.uid), ['t1']);
        const byId = await core6.handle('POST', `/api/incident/${c.code}/lookup`, H(c.pin), JSON.stringify({ tag: 'TAG-778' }), '1.1.1.1');
        assert.deepStrictEqual(byId.body.records.map(r => r.uid), ['t2']);
        const partial = await core6.handle('POST', `/api/incident/${c.code}/lookup`, H(c.pin), JSON.stringify({ tag: 'TAG' }), '1.1.1.1');
        assert.deepStrictEqual(partial.body.records, []);
        assert.strictEqual((await core6.handle('POST', `/api/incident/${c.code}/lookup`, H(c.pin), JSON.stringify({}), '1.1.1.1')).status, 400);
    });
    await test('patient IDs and card numbers keep only safe characters; the record is never refused for them', async () => {
        const core7 = createCore({ store: makeStore(), now: () => clock });
        const c = (await core7.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        await core7.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('s1', 'A1<b>"x\'</b>-TST-1', 'P1', { cardNo: 'WM&004/12 #3' }), rec('s2', '<>"\'&', 'P2'), rec('s3', 'José-7', 'P3')] }), '1.1.1.1');
        const g = await core7.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2');
        const by = {}; g.body.records.forEach(r => { by[r.uid] = r; });
        assert.strictEqual(by.s1.id, 'A1bx/b-TST-1');
        assert.strictEqual(by.s1.cardNo, 'WM004/12 #3');
        assert.strictEqual(by.s2.id, 'UNNAMED-s2');
        assert.strictEqual(by.s3.id, 'José-7');
    });
    await test('rate-limit keys are salted when a salt is given, so the same address gives a different key', async () => {
        const plainStore = makeStore(), saltStore = makeStore();
        const a = createCore({ store: plainStore, now: () => clock });
        const b = createCore({ store: saltStore, now: () => clock, rateSalt: 'server-secret' });
        await a.handle('GET', '/api/incident/ZZZZZZ', H('000000'), '', '9.9.9.9');
        await b.handle('GET', '/api/incident/ZZZZZZ', H('000000'), '', '9.9.9.9');
        const ka = (await plainStore.list('rl/')).map(e => e.key || e), kb = (await saltStore.list('rl/')).map(e => e.key || e);
        assert.strictEqual(ka.length, 1); assert.strictEqual(kb.length, 1);
        assert.notStrictEqual(ka[0], kb[0]);
    });
    console.log('\nincident-core: v0.19.6 (findings from the v0.19.5 test)');
    const mk = async (coreX, ip) => (await coreX.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA', triager: 'Medic A' }), ip || '1.1.1.1')).body;
    await test('three different PINs: triagers can join and send but not end, decide, mark or clear a call for help', async () => {
        const c8 = createCore({ store: makeStore(), now: () => clock });
        const c = await mk(c8);
        assert.strictEqual(new Set([c.pin, c.commanderPin, c.viewPin]).size, 3);
        assert.strictEqual((await c8.handle('POST', `/api/incident/${c.code}/join`, H(c.pin), JSON.stringify({ deviceId: 'DEVB', triager: 'Fire 3' }), '3.3.3.3')).status, 200);
        assert.strictEqual((await c8.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVB', records: [rec('x1', 'B-1', 'P2', { updatedAt: clock })] }), '3.3.3.3')).status, 200);
        for (const [action, body] of [['close', {}], ['policy', { p1Hold: { on: false, by: 'X' } }], ['marks', { marks: [], by: 'X' }], ['duress-clear', { deviceId: 'DEVA', by: 'X' }]]) {
            const r = await c8.handle('POST', `/api/incident/${c.code}/${action}`, H(c.pin), JSON.stringify(body), '3.3.3.3');
            assert.strictEqual(r.status, 403, action);
            assert.strictEqual(r.body.error, 'not_commander', action);
        }
        const g = await c8.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '3.3.3.3');
        assert.strictEqual(g.body.viewOnly, true);
        assert.strictEqual(g.body.access, 'triager');
        assert.strictEqual((await c8.handle('POST', `/api/incident/${c.code}/close`, H(c.commanderPin), '{}', '1.1.1.1')).status, 200);
    });
    await test('a phone report sent while the commander changes P1 Hold never undoes the decision', async () => {
        const slow = makeStore({ jitter: 4 });
        const c9 = createCore({ store: slow, now: () => clock });
        const c = await mk(c9);
        for (let i = 0; i < 12; i++) {
            clock += 1000;
            const on = i % 2 === 0;
            const reports = [0, 1, 2].map(k => c9.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('r' + i + k, 'A-' + i + k, 'P3', { updatedAt: clock })], ccs: { lat: 52.4 + i / 1000, lng: -1.9 } }), '1.1.1.1'));
            const dec = c9.handle('POST', `/api/incident/${c.code}/policy`, H(c.commanderPin), JSON.stringify({ p1Hold: { on, by: 'Dr A' } }), '2.2.2.2');
            const [d] = await Promise.all([dec, ...reports]);
            assert.strictEqual(d.status, 200);
            const g = await c9.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '2.2.2.2');
            assert.strictEqual(g.body.policy.p1Hold.on, on, `round ${i}`);
        }
    });
    await test('a call for help cleared while the phone is reporting stays cleared', async () => {
        const slow = makeStore({ jitter: 4 });
        const c10 = createCore({ store: slow, now: () => clock });
        const c = await mk(c10);
        await c10.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], duress: { at: 1700000000000 } }), '1.1.1.1');
        const beat = c10.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [], duress: { at: 1700000000000 } }), '1.1.1.1');
        const clr = c10.handle('POST', `/api/incident/${c.code}/duress-clear`, H(c.commanderPin), JSON.stringify({ deviceId: 'DEVA', by: 'Silver' }), '2.2.2.2');
        await Promise.all([beat, clr]);
        const g = await c10.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '2.2.2.2');
        assert.ok(g.body.devices[0].duress.clearedAt > 0);
        assert.strictEqual(g.body.devices[0].duress.clearedBy, 'Silver');
    });
    await test('a phone clock a year fast cannot block a later real change', async () => {
        const c11 = createCore({ store: makeStore(), now: () => clock });
        const c = await mk(c11);
        const YEAR = 365 * 24 * 3600e3;
        // Phone A (clock a year fast) records P3; phone B (right clock) later changes the same casualty to P1
        await c11.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', clientNow: clock + YEAR, records: [rec('w1', 'A-1', 'P3', { updatedAt: clock + YEAR })] }), '1.1.1.1');
        clock += 5000;
        await c11.handle('POST', `/api/incident/${c.code}/join`, H(c.pin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3');
        const b = await c11.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVB', clientNow: clock, records: [rec('w1', 'A-1', 'P1', { updatedAt: clock })] }), '3.3.3.3');
        assert.strictEqual(b.body.accepted, 1);
        let g = await c11.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '2.2.2.2');
        assert.strictEqual(g.body.records[0].category, 'P1');
        // Phone A sends its old P3 copy again (e.g. after a reload): still older, so P1 stays
        clock += 5000;
        const a2 = await c11.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', clientNow: clock + YEAR, records: [rec('w1', 'A-1', 'P3', { updatedAt: clock - 10000 + YEAR })] }), '1.1.1.1');
        assert.strictEqual(a2.body.kept, 1);
        g = await c11.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '2.2.2.2');
        assert.strictEqual(g.body.records[0].category, 'P1');
        // A phone that does not say its clock still cannot write into the future
        const x = await c11.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('w2', 'A-2', 'P3', { updatedAt: clock + YEAR })] }), '1.1.1.1');
        assert.strictEqual(x.status, 200);
        g = await c11.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '2.2.2.2');
        assert.ok(g.body.records.find(r => r.uid === 'w2').updatedAt <= clock);
    });
    await test('200 wrong PINs sent in parallel are locked out after 25', async () => {
        const c12 = createCore({ store: makeStore({ jitter: 3 }), now: () => clock });
        const c = await mk(c12);
        const guesses = Array.from({ length: 200 }, (_, i) => c12.handle('GET', `/api/incident/${c.code}`, H(String(100000 + i)), '', '6.6.6.6'));
        const st = (await Promise.all(guesses)).map(r => r.status);
        assert.ok(st.filter(x => x === 401).length <= 25, `${st.filter(x => x === 401).length} guesses checked`);
        assert.ok(st.filter(x => x === 429).length >= 175);
    });
    await test('100 wrong PINs for one incident lock out guessing addresses; a clean address and linked phones carry on', async () => {
        const c13 = createCore({ store: makeStore(), now: () => clock });
        const c = await mk(c13);
        const j = await c13.handle('POST', `/api/incident/${c.code}/join`, H(c.pin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3');
        for (let i = 0; i < 100; i++) await c13.handle('GET', `/api/incident/${c.code}`, H('000001'), '', '10.0.' + Math.floor(i / 20) + '.' + i);
        assert.strictEqual((await c13.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '10.0.0.1')).status, 429, 'an address that guessed wrong must wait, even with the right PIN');
        // v0.19.8: strangers' guesses cannot keep out a new commander screen from an address with no wrong PINs.
        assert.strictEqual((await c13.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '11.1.1.1')).status, 200, 'a clean address with the right PIN gets in');
        // ...but it gets one try: after a wrong PIN it waits too.
        assert.strictEqual((await c13.handle('GET', `/api/incident/${c.code}`, H('000002'), '', '12.1.1.1')).status, 401);
        assert.strictEqual((await c13.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '12.1.1.1')).status, 429);
        const linked = await c13.handle('PUT', `/api/incident/${c.code}/records`, Object.assign(H(c.pin), { 'x-incident-key': j.body.accessKey }), JSON.stringify({ deviceId: 'DEVB', records: [] }), '3.3.3.3');
        assert.strictEqual(linked.status, 200);
    });
    await test('v0.19.8: a triager\'s access key does not let it guess the commander PIN past the lock-out, and its wrong guesses count', async () => {
        const c = createCore({ store: makeStore(), now: () => clock });
        const inc = await mk(c);
        const j = await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3');
        assert.strictEqual(j.body.level, 'member');
        const KH = (pin) => Object.assign(H(pin), { 'x-incident-key': j.body.accessKey });
        for (let i = 0; i < 100; i++) await c.handle('GET', `/api/incident/${inc.code}`, KH('00000' + (i % 10)), '', '20.0.' + Math.floor(i / 20) + '.' + i);
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, KH(inc.commanderPin), '', '20.0.0.1')).status, 429, 'the triager key does not cover the commander PIN');
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, KH(inc.pin), '', '20.0.0.1')).status, 200, 'it still covers its own PIN');
    });
    await test('v0.19.10: a phone on an old app (no device keys) is asked to update instead of joining or starting', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        const j = await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'OLD1', triager: 'Old Phone', keys: false }), '7.7.7.7');
        assert.strictEqual(j.status, 400);
        assert.strictEqual(j.body.error, 'old_app');
        const made = await c.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'OLD2', keys: false }), '7.7.7.8');
        assert.strictEqual(made.body.error, 'old_app');
        // A device joined unkeyed before v0.19.10 cannot send any more, and nor can a device code that never joined.
        await store.set(`i/${inc.code}/d/OLD3`, { deviceId: 'OLD3', role: 'member', oldApp: true, joinedAt: clock, lastSeen: clock, records: 0 });
        assert.strictEqual((await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'OLD3', records: [rec('old-1', 'OLD-001', 'P1')] }), '7.7.7.7')).status, 403);
        const ghost = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'GHOST', triager: 'Imposter', records: [rec('g-1', 'G-001', 'P3')] }), '7.7.7.9');
        assert.strictEqual(ghost.status, 403);
        assert.strictEqual(ghost.body.error, 'device_key');
        // Updated and joined again: keyed from then on, and the old-app mark goes.
        const j2 = await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'OLD3', triager: 'Old Phone' }), '7.7.7.7');
        assert.ok(j2.body.deviceKey);
        const g2 = await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '2.2.2.2');
        assert.ok(!g2.body.devices.find(d => d.deviceId === 'OLD3').oldApp);
        assert.ok(!g2.body.devices.some(d => d.deviceId === 'GHOST'), 'a report without a join leaves no phone behind');
        assert.strictEqual((await c.handle('PUT', `/api/incident/${inc.code}/records`, Object.assign(H(inc.pin), { 'x-device-key': 'nope' }), JSON.stringify({ deviceId: 'OLD3', records: [] }), '6.6.6.6')).status, 403);
    });
    await test('v0.19.8: P1 Hold and MITT changes sent at the same moment are all kept', async () => {
        const c = createCore({ store: makeStore({ jitter: 15 }), now: () => clock });
        const inc = await mk(c);
        const CH = H(inc.commanderPin);
        await Promise.all([
            c.handle('POST', `/api/incident/${inc.code}/policy`, CH, JSON.stringify({ p1Hold: { on: true, by: 'Dr A' } }), '2.2.2.2'),
            c.handle('POST', `/api/incident/${inc.code}/policy`, CH, JSON.stringify({ mitt: { groups: ['all'], by: 'Dr B' } }), '2.2.2.3'),
            c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ marks: [], by: 'Dr C' }), '2.2.2.4'),
        ]);
        const g = await c.handle('GET', `/api/incident/${inc.code}`, CH, '', '2.2.2.2');
        assert.strictEqual(g.body.policy.p1Hold.on, true);
        assert.ok(g.body.policy.mitt && g.body.policy.mitt.by === 'Dr B');
        assert.strictEqual(g.body.decisions.length, 3, JSON.stringify(g.body.decisions));
    });
    await test('v0.19.8: a phone whose clock is out does not make its unchanged METHANE look new on every report', async () => {
        let t0 = clock;
        const c = createCore({ store: makeStore(), now: () => t0 });
        const inc = await mk(c);
        const fast = 365 * 24 * 3600 * 1000;
        const methane = { m: 'Major incident declared', e: 'Stadium', t: 'Collapse', h: '', a: '', n: '20', e_svc: '', timestamp: t0 + fast, by: 'Medic A' };
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', methane, clientNow: t0 + fast, records: [] }), '1.1.1.1');
        const m1 = (await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '2.2.2.2')).body.updatedAt;
        t0 += 60000;
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', methane, clientNow: t0 + fast + 37, records: [] }), '1.1.1.1');
        const m2 = (await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '2.2.2.2')).body.updatedAt;
        assert.strictEqual(m2, m1, 'the same METHANE did not extend the incident');
    });
    await test('v0.19.8: a record\'s triage time is moved onto the server clock with its update time', async () => {
        const c = createCore({ store: makeStore(), now: () => clock });
        const inc = await mk(c);
        const fast = 365 * 24 * 3600 * 1000;
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', clientNow: clock + fast, records: [rec('sk-1', 'SK-001', 'P2', { timestamp: clock + fast - 5000, updatedAt: clock + fast - 5000, createdAt: clock + fast - 5000 })] }), '1.1.1.1');
        const r = (await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '2.2.2.2')).body.records.find(x => x.uid === 'sk-1');
        assert.ok(Math.abs(r.timestamp - (clock - 5000)) < 2000, String(r.timestamp - clock));
    });
    await test('v0.19.8: incidents started at the same moment from one address still stop at 10', async () => {
        const c = createCore({ store: makeStore({ jitter: 10 }), now: () => clock });
        const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => c.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'P' + i }), '8.8.8.8')));
        assert.strictEqual(rs.filter(r => r.status === 201).length, 10);
    });
    await test('v0.19.8: one store error does not stop the hourly clean-up', async () => {
        const st = makeStore();
        const c = createCore({ store: st, now: () => clock });
        const a1 = await mk(c), a2 = await mk(c);
        const realGet = st.get.bind(st);
        let failedOnce = false;
        st.get = async (k) => { if (!failedOnce && k.endsWith('/meta')) { failedOnce = true; throw new Error('boom'); } return realGet(k); };
        clock += TTL_MS + 1000;
        const out = await c.cleanup();
        st.get = realGet;
        assert.strictEqual(out.errors, 1);
        assert.ok(out.removedBlobs > 0, 'the other incident was still cleared');
        clock -= TTL_MS + 1000;
        void a1; void a2;
    });
    await test('a phone cannot report under another phone\'s device code', async () => {
        const c14 = createCore({ store: makeStore(), now: () => clock });
        const c = await mk(c14);
        const r = await c14.handle('PUT', `/api/incident/${c.code}/records`, Object.assign(H(c.pin), { 'x-device-key': 'not-the-key' }), JSON.stringify({ deviceId: 'DEVA', triager: 'Impostor', duress: null }), '6.6.6.6');
        assert.strictEqual(r.status, 403);
        const j = await c14.handle('POST', `/api/incident/${c.code}/join`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', triager: 'Impostor' }), '6.6.6.6');
        assert.strictEqual(j.status, 409);
        const g = await c14.handle('GET', `/api/incident/${c.code}`, H(c.commanderPin), '', '2.2.2.2');
        assert.strictEqual(g.body.devices[0].triager, 'Medic A');
    });
    await test('a heartbeat with nothing new does not keep the incident for ever', async () => {
        const c15 = createCore({ store: makeStore(), now: () => clock });
        const c = await mk(c15);
        clock += TTL_MS - 1000;
        await c15.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [] }), '1.1.1.1');
        clock += 2000;
        assert.strictEqual((await c15.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).status, 410);
    });
    await test('starting incidents is limited to 10 an hour from one address', async () => {
        const c16 = createCore({ store: makeStore(), now: () => clock });
        for (let i = 0; i < 10; i++) assert.strictEqual((await c16.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'D' + i }), '5.5.5.5')).status, 201);
        assert.strictEqual((await c16.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'D11' }), '5.5.5.5')).status, 429);
        assert.strictEqual((await c16.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'D12' }), '5.5.5.6')).status, 201);
        clock += 60 * 60 * 1000 + 1;
        assert.strictEqual((await c16.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'D13' }), '5.5.5.5')).status, 201);
    });
    await test('a storage error is a server error (500), never "incident ended"', async () => {
        const st = makeStore();
        const c17 = createCore({ store: st, now: () => clock });
        const c = await mk(c17);
        const get = st.get;
        st.get = async () => { throw new Error('UNAVAILABLE'); };
        const r = await c17.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'DEVA', records: [] }), '1.1.1.1');
        st.get = get;
        assert.strictEqual(r.status, 500);
    });
    console.log('\nincident-core: v0.19.9 stress test fixes (v0.19.10)');
    // Starts each of these tests at 01:00 UTC, so a whole run of guesses falls in one calendar day.
    const dayStart = (t) => (Math.floor(t / 864e5) + 1) * 864e5 + 3600e3;
    await test('v0.19.11: guesses spread over many addresses stop at 400 a day; then new addresses are refused but linked phones carry on', async () => {
        let t0 = dayStart(clock);
        const c = createCore({ store: makeStore(), now: () => t0 });
        const inc = await mk(c);
        const j = await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3');
        let checked = 0;
        for (let i = 0; i < 600; i++) {
            t0 += 12 * 1000;
            const r = await c.handle('GET', `/api/incident/${inc.code}`, H(String(200000 + i)), '', '30.' + Math.floor(i / 250) + '.' + Math.floor(i / 250) + '.' + (i % 250));
            if (r.status === 401) checked++;
        }
        assert.ok(checked <= 400, `${checked} guesses were checked`);
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '31.1.1.1')).status, 429, 'once the one-try addresses have used up their 100, a new address waits too');
        const linked = await c.handle('PUT', `/api/incident/${inc.code}/records`, Object.assign(H(inc.pin), { 'x-incident-key': j.body.accessKey }), JSON.stringify({ deviceId: 'DEVB', records: [rec('l1', 'L-1', 'P2', { updatedAt: t0 })] }), '3.3.3.3');
        assert.strictEqual(linked.status, 200, 'a linked phone carries on');
        t0 = dayStart(t0);
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '31.1.1.1')).status, 200, 'the next day the counts start again');
    });
    await test('v0.19.11: one address guessing all day cannot keep a new phone or commander screen out', async () => {
        let t0 = dayStart(clock);
        const c = createCore({ store: makeStore(), now: () => t0 });
        const inc = await mk(c);
        const linked = await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'SAME' }), '40.1.1.1');
        // 25 wrong PINs every 15 minutes from one address for 5 hours: 500 wrong, past the day's 300.
        for (let w = 0; w < 20; w++) { for (let i = 0; i < 25; i++) await c.handle('GET', `/api/incident/${inc.code}`, H(String(300000 + w * 25 + i)), '', '40.1.1.1'); t0 += 15 * 60 * 1000; }
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, H(inc.pin), '', '40.1.1.1')).status, 429, 'the guessing address is held up even with the right PIN');
        const sameAddr = await c.handle('PUT', `/api/incident/${inc.code}/records`, Object.assign(H(inc.pin), { 'x-incident-key': linked.body.accessKey }), JSON.stringify({ deviceId: 'SAME', records: [] }), '40.1.1.1');
        assert.strictEqual(sameAddr.status, 200, 'a linked phone behind the same address (e.g. a mobile network) carries on');
        assert.strictEqual((await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'NEW1' }), '41.1.1.1')).status, 200, 'a new phone joins');
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '42.1.1.1')).status, 200, 'a new commander screen opens');
    });
    await test('v0.19.11: 1,200 wrong PINs sent at once through two server copies are all counted', async () => {
        const t0 = dayStart(clock);
        const store = makeStore({ jitter: 5 });
        const a = createCore({ store, now: () => t0 }), b = createCore({ store, now: () => t0 });
        const inc = await mk(a);
        const st = (await Promise.all(Array.from({ length: 1200 }, (_, i) => (i % 2 ? a : b).handle('GET', `/api/incident/${inc.code}`, H(String(400000 + i)), '', '50.' + Math.floor(i / 250) + '.1.' + (i % 250))))).map(r => r.status);
        const checked = st.filter(x => x === 401).length;
        assert.ok(checked <= 400, `${checked} of 1,200 guesses were checked`);
    });
    await test('addresses in the same IPv6 /64 block share one wrong-PIN count', async () => {
        const c = createCore({ store: makeStore(), now: () => clock });
        const inc = await mk(c);
        for (let i = 0; i < 25; i++) await c.handle('GET', `/api/incident/${inc.code}`, H('00000' + (i % 10)), '', `2001:db8:1:2:${i.toString(16)}::${i + 1}`);
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, H(inc.pin), '', '2001:db8:1:2:ffff::1')).status, 429, 'same /64');
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, H(inc.pin), '', '2001:db8:1:3::1')).status, 200, 'another /64');
        assert.strictEqual((await c.handle('GET', `/api/incident/${inc.code}`, H(inc.pin), '', '::ffff:9.9.9.9')).status, 200);
    });
    await test('a phone 30 seconds slow does not lose a genuine later update', async () => {
        const c = createCore({ store: makeStore(), now: () => clock });
        const inc = await mk(c);
        await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3');
        // Phone B (right clock) records P3; 10 s later phone A (30 s slow) changes the same casualty to P1.
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVB', clientNow: clock, records: [rec('s1', 'S-1', 'P3', { updatedAt: clock })] }), '3.3.3.3');
        clock += 10000;
        const a = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', clientNow: clock - 30000, records: [rec('s1', 'S-1', 'P1', { updatedAt: clock - 30000 })] }), '1.1.1.1');
        assert.strictEqual(a.body.accepted, 1);
        const g = await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '2.2.2.2');
        assert.strictEqual(g.body.records[0].category, 'P1');
        assert.ok(!g.body.records[0].clockSkewMs, 'a skew under a minute is corrected but not labelled');
    });
    await test('v0.19.11: a report delivered 5 seconds late is not taken as a wrong clock, so it does not overwrite a later change', async () => {
        const c = createCore({ store: makeStore(), now: () => clock });
        const inc = await mk(c);
        await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'DEVB' }), '3.3.3.3');
        const sentAt = clock;          // phone A (right clock) records P3 and sends it; the network holds it up
        clock += 2000;                 // phone B (right clock) records P1 two seconds later; it arrives at once
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVB', clientNow: clock, records: [rec('n1', 'N-1', 'P1', { updatedAt: clock })] }), '3.3.3.3');
        clock += 3000;                 // phone A's report arrives 5 seconds after it was sent
        const a = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', clientNow: sentAt, records: [rec('n1', 'N-1', 'P3', { updatedAt: sentAt })] }), '1.1.1.1');
        assert.strictEqual(a.body.kept, 1);
        const g = await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '2.2.2.2');
        assert.strictEqual(g.body.records.find(r => r.uid === 'n1').category, 'P1');
    });
    await test('two commander screens adding and removing map markings at the same moment keep every change', async () => {
        const c = createCore({ store: makeStore({ jitter: 10 }), now: () => clock });
        const inc = await mk(c);
        const CH = H(inc.commanderPin);
        const first = await c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ by: 'Silver', add: [{ id: 'm1', type: 'rvp', lat: 52.4, lng: -1.9 }] }), '2.2.2.2');
        assert.strictEqual(first.status, 200);
        clock += 1000;
        await Promise.all([
            c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ by: 'Silver', add: [{ id: 'm2', type: 'inner', lat: 52.41, lng: -1.9, radius: 100 }] }), '2.2.2.2'),
            c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ by: 'Gold', add: [{ id: 'm3', type: 'hazard', lat: 52.42, lng: -1.9 }] }), '2.2.2.3'),
            c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ by: 'Bronze', remove: ['m1'] }), '2.2.2.4'),
        ]);
        const g = await c.handle('GET', `/api/incident/${inc.code}`, CH, '', '2.2.2.2');
        assert.deepStrictEqual(g.body.marks.map(m => m.id).sort(), ['m2', 'm3']);
        // A screen still on an older version sends the whole list, which replaces what is there.
        await c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ by: 'Old screen', marks: [{ id: 'm3', type: 'hazard', lat: 52.42, lng: -1.9 }] }), '2.2.2.2');
        const g2 = await c.handle('GET', `/api/incident/${inc.code}`, CH, '', '2.2.2.2');
        assert.deepStrictEqual(g2.body.marks.map(m => m.id), ['m3']);
    });
    await test('v0.19.11: markings added at the same moment never take the map past its limit', async () => {
        const store = makeStore({ jitter: 10 });
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        const CH = H(inc.commanderPin);
        for (let i = 0; i < 28; i++) await c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ by: 'Silver', add: [{ id: 'f' + i, type: 'hazard', lat: 52 + i / 100, lng: -1.9 }] }), '2.2.2.2');
        const st = (await Promise.all(Array.from({ length: 6 }, (_, i) => c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ by: 'Silver', add: [{ id: 'x' + i, type: 'rvp', lat: 53 + i / 100, lng: -1.9 }] }), '2.2.2.' + (10 + i))))).map(r => r.status);
        const g = await c.handle('GET', `/api/incident/${inc.code}`, CH, '', '2.2.2.2');
        const stored = (await store.list(`i/${inc.code}/mk/`)).length;
        assert.ok(stored <= 30, `${stored} markings stored`);
        assert.strictEqual(g.body.marks.length, stored, 'none is hidden');
        assert.ok(st.filter(x => x === 409).length >= 4, JSON.stringify(st));
    });
    await test('a phone that already has the markings is not sent them again; a change is sent', async () => {
        const c = createCore({ store: makeStore(), now: () => clock });
        const inc = await mk(c);
        const m = await c.handle('POST', `/api/incident/${inc.code}/marks`, H(inc.commanderPin), JSON.stringify({ by: 'Silver', add: [{ id: 'm1', type: 'rvp', lat: 52.4, lng: -1.9 }] }), '2.2.2.2');
        const p1 = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: [], marksAt: m.body.marksAt }), '1.1.1.1');
        assert.strictEqual(p1.body.marks, undefined);
        assert.strictEqual(p1.body.marksAt, m.body.marksAt);
        clock += 1000;
        await c.handle('POST', `/api/incident/${inc.code}/marks`, H(inc.commanderPin), JSON.stringify({ by: 'Silver', remove: ['m1'] }), '2.2.2.2');
        const p2 = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: [], marksAt: m.body.marksAt }), '1.1.1.1');
        assert.deepStrictEqual(p2.body.marks, []);
        assert.ok(p2.body.marksAt > m.body.marksAt);
    });
    await test('an incident from before v0.19.10 keeps its markings and decisions when they are next changed', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        // Make it look like an older incident: no version mark, markings and decisions in the old single documents.
        const meta = await store.get(`i/${inc.code}/meta`); delete meta.v; await store.set(`i/${inc.code}/meta`, meta);
        await store.set(`i/${inc.code}/marks`, { marks: [{ id: 'old1', type: 'rvp', lat: 52.4, lng: -1.9, at: clock - 5000 }, { id: 'old2', type: 'hazard', lat: 52.5, lng: -1.9, at: clock - 4000 }], marksAt: clock - 4000, by: 'Silver' });
        await store.set(`i/${inc.code}/policy`, { policy: { p1Hold: { on: true, at: clock - 3000, by: 'Dr A' } }, policyAt: clock - 3000, decisions: [{ at: clock - 3000, what: 'p1hold-on', by: 'Dr A' }] });
        const CH = H(inc.commanderPin);
        let g = await c.handle('GET', `/api/incident/${inc.code}`, CH, '', '2.2.2.2');
        assert.deepStrictEqual(g.body.marks.map(m => m.id), ['old1', 'old2']);
        assert.strictEqual(g.body.policy.p1Hold.on, true);
        clock += 1000;
        await c.handle('POST', `/api/incident/${inc.code}/marks`, CH, JSON.stringify({ by: 'Silver', remove: ['old1'] }), '2.2.2.2');
        g = await c.handle('GET', `/api/incident/${inc.code}`, CH, '', '2.2.2.2');
        assert.deepStrictEqual(g.body.marks.map(m => m.id), ['old2']);
        assert.strictEqual(g.body.decisions.length, 2);
    });
    await test('v0.19.11: the commander screen gets the newest 200 decisions; none is deleted', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        const CH = H(inc.commanderPin);
        for (let i = 0; i < 260; i++) { clock += 10; await c.handle('POST', `/api/incident/${inc.code}/policy`, CH, JSON.stringify({ p1Hold: { on: i % 2 === 0, by: 'Dr ' + i } }), '2.2.2.2'); }
        const g = await c.handle('GET', `/api/incident/${inc.code}`, CH, '', '2.2.2.2');
        assert.strictEqual(g.body.decisions.length, 200);
        assert.strictEqual(g.body.decisions[199].by, 'Dr 259');
        assert.strictEqual((await store.list(`i/${inc.code}/dec/`)).length, 260);
    });
    // ---------- v0.19.12: 3,000-casualty test ----------
    const S = (pin, extra) => Object.assign({ 'x-incident-pin': pin, 'x-incident-sync': '2' }, extra || {});
    const many = (prefix, n, extra) => Array.from({ length: n }, (_, i) => rec(prefix + i, prefix.toUpperCase() + '-' + i, 'P3', Object.assign({ updatedAt: clock }, extra || {})));
    const joinAs = async (c, inc, dev, ip) => (await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: dev, triager: 'Medic ' + dev }), ip || '3.3.3.3')).body;
    await test('v0.19.12: a full incident refuses new casualties with "incident full", lists them for the commander, and still takes updates', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock, maxRecords: 5 });
        const inc = await mk(c);
        let r = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: many('f', 4) }), '1.1.1.1');
        assert.strictEqual(r.body.accepted, 4); assert.ok(!r.body.incidentFull);
        r = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: many('g', 3) }), '1.1.1.1');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.accepted, 1);
        assert.strictEqual(r.body.incidentFull, true);
        assert.deepStrictEqual(r.body.full.sort(), ['g1', 'g2']);
        assert.ok(r.body.rejected.indexOf('g1') > -1, 'older phones see them as rejected too');
        // Sent again: still refused, and listed once each on the commander screen.
        clock += 1000;
        r = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: many('g', 3).slice(1) }), '1.1.1.1');
        assert.deepStrictEqual(r.body.full.sort(), ['g1', 'g2']);
        const g = await c.handle('GET', `/api/incident/${inc.code}`, S(inc.commanderPin), '', '2.2.2.2');
        assert.strictEqual(g.body.records.length, 5);
        assert.strictEqual(g.body.full.count, 2);
        assert.deepStrictEqual(g.body.full.list.map(x => x.id).sort(), ['G-1', 'G-2']);
        assert.strictEqual(g.body.full.list[0].device, 'DEVA');
        // An update to a casualty already stored is still taken.
        clock += 1000;
        r = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('f0', 'F-0', 'P1', { updatedAt: clock })] }), '1.1.1.1');
        assert.strictEqual(r.body.accepted, 1); assert.ok(!r.body.incidentFull);
        assert.strictEqual((await store.counts([`i/${inc.code}/ver`]))[0].c, 5);
    });
    await test('v0.19.12: five phones adding at the same moment never take an incident past its limit, and retries fill it exactly', async () => {
        const store = makeStore({ jitter: 4 });
        const c = createCore({ store, now: () => clock, maxRecords: 50 });
        const inc = await mk(c);
        const devs = ['DEVB', 'DEVC', 'DEVD', 'DEVE', 'DEVF'];
        for (const d of devs) await joinAs(c, inc, d);
        const send = (d, recs) => c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: d, records: recs }), '3.3.3.3');
        const res = await Promise.all(devs.map(d => send(d, many(d.toLowerCase(), 20))));
        const stored = () => store.list(`i/${inc.code}/r/`).then(l => l.length);
        assert.ok(await stored() <= 50, 'never past the limit: ' + await stored());
        assert.strictEqual(res.reduce((n, r) => n + r.body.accepted + (r.body.full || []).length, 0), 100);
        // Each phone sends its refused casualties again (as the app does with its next report).
        clock += 60000;
        for (let i = 0; i < devs.length; i++) { const left = new Set(res[i].body.full || []); await send(devs[i], many(devs[i].toLowerCase(), 20).filter(x => left.has(x.uid))); }
        assert.strictEqual(await stored(), 50);
    });
    await test('v0.19.12: an incident from before the stored count is counted once, then kept', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock, maxRecords: 6 });
        const inc = await mk(c);
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: many('h', 4) }), '1.1.1.1');
        await store.delete(`i/${inc.code}/ver`);   // as an incident made before v0.19.12
        const r = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: many('k', 3) }), '1.1.1.1');
        assert.strictEqual(r.body.accepted, 2);
        assert.strictEqual(r.body.full.length, 1);
    });
    await test('v0.19.12: a commander screen gets 304 for a few reads when nothing changed, and only the changes otherwise', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        for (let i = 0; i < 3; i++) await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: many('s' + i + '_', 200) }), '1.1.1.1');
        const CH = (extra) => S(inc.commanderPin, extra);
        // (Changes from the 30 seconds before a read are read again next time, in case one finished writing late.)
        clock += 120000;
        let g = await c.handle('GET', `/api/incident/${inc.code}`, CH(), '', '2.2.2.2');
        assert.strictEqual(g.body.sync, 2); assert.strictEqual(g.body.delta, false);
        assert.strictEqual(g.body.records.length, 600); assert.ok(!g.body.more);
        assert.ok(Array.isArray(g.body.devices) && g.body.policy && Array.isArray(g.body.decisions));
        let ver = g.body.ver, cursor = g.body.cursor;
        clock += 1000;
        const before = store.ops ? store.ops() : 0;
        g = await c.handle('GET', `/api/incident/${inc.code}`, CH({ 'x-incident-ver': ver, 'x-incident-cursor': String(cursor) }), '', '2.2.2.2');
        assert.strictEqual(g.status, 304);
        if (store.ops) assert.ok(store.ops() - before <= 6, 'no-change read cost ' + (store.ops() - before) + ' store operations');
        // One casualty changes: only it comes back, with the phones (that report was also a heartbeat), not the decisions.
        clock += 1000;
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('s1_7', 'S1_-7', 'P1', { updatedAt: clock })] }), '1.1.1.1');
        clock += 1000;
        g = await c.handle('GET', `/api/incident/${inc.code}`, CH({ 'x-incident-ver': ver, 'x-incident-cursor': String(cursor) }), '', '2.2.2.2');
        assert.strictEqual(g.body.delta, true);
        assert.deepStrictEqual(g.body.records.map(r => r.uid), ['s1_7']);
        assert.strictEqual(g.body.records[0].category, 'P1');
        assert.ok(Array.isArray(g.body.devices));
        assert.strictEqual(g.body.decisions, undefined);
        ver = g.body.ver; cursor = g.body.cursor;
        // A heartbeat only: phones, no casualties.
        clock += 1000;
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: [], battery: 40 }), '1.1.1.1');
        g = await c.handle('GET', `/api/incident/${inc.code}`, CH({ 'x-incident-ver': ver, 'x-incident-cursor': String(cursor) }), '', '2.2.2.2');
        assert.strictEqual(g.body.records, undefined);
        assert.strictEqual(g.body.devices[0].battery, 40);
        assert.strictEqual(g.body.cursor, cursor, 'the casualty cursor only moves when casualties are read');
        ver = g.body.ver;
        // A decision: the decisions come back.
        clock += 1000;
        await c.handle('POST', `/api/incident/${inc.code}/policy`, H(inc.commanderPin), JSON.stringify({ p1Hold: { on: true, by: 'Dr Z' } }), '2.2.2.2');
        g = await c.handle('GET', `/api/incident/${inc.code}`, CH({ 'x-incident-ver': ver, 'x-incident-cursor': String(cursor) }), '', '2.2.2.2');
        assert.strictEqual(g.body.policy.p1Hold.on, true);
        assert.strictEqual(g.body.decisions[g.body.decisions.length - 1].by, 'Dr Z');
        assert.strictEqual(g.body.policy.p1Hold.logKey, undefined, 'the log copy stays on the server');
    });
    await test('v0.19.12: a change written a little after the time in its key is still picked up', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        let g = await c.handle('GET', `/api/incident/${inc.code}`, S(inc.commanderPin), '', '2.2.2.2');
        const ver = g.body.ver, cursor = g.body.cursor;
        clock -= 20000;   // a report that started 20 s before the screen's read finishes after it
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('late1', 'L-1', 'P2', { updatedAt: clock })] }), '1.1.1.1');
        clock += 25000;
        g = await c.handle('GET', `/api/incident/${inc.code}`, S(inc.commanderPin, { 'x-incident-ver': ver, 'x-incident-cursor': String(cursor) }), '', '2.2.2.2');
        assert.strictEqual(g.body.delta, true);
        assert.deepStrictEqual(g.body.records.map(r => r.uid), ['late1']);
    });
    await test('v0.19.12: a big first load comes in parts, and the parts hold every casualty once', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock, pageBytes: 20000 });
        const inc = await mk(c);
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: many('p', 120, { notes: 'x'.repeat(500) }) }), '1.1.1.1');
        let g = await c.handle('GET', `/api/incident/${inc.code}`, S(inc.commanderPin), '', '2.2.2.2');
        assert.ok(g.body.more, 'first part says there is more');
        const got = g.body.records.slice();
        let parts = 1;
        while (g.body.more) {
            g = await c.handle('GET', `/api/incident/${inc.code}`, S(inc.commanderPin, { 'x-incident-page': g.body.more }), '', '2.2.2.2');
            assert.strictEqual(g.body.page, true);
            assert.ok(JSON.stringify(g.body).length < 30000);
            got.push(...g.body.records); parts++;
        }
        assert.ok(parts > 2);
        assert.strictEqual(got.length, 120);
        assert.strictEqual(new Set(got.map(r => r.uid)).size, 120);
    });
    await test('v0.19.12: a decision whose log entry was not written still shows in the log', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        await c.handle('POST', `/api/incident/${inc.code}/policy`, H(inc.commanderPin), JSON.stringify({ p1Hold: { on: true, by: 'Dr Y' } }), '2.2.2.2');
        for (const e of await store.list(`i/${inc.code}/dec/`)) await store.delete(e.key || e);   // as if the second write was lost
        const g = await c.handle('GET', `/api/incident/${inc.code}`, S(inc.commanderPin), '', '2.2.2.2');
        assert.strictEqual(g.body.decisions.length, 1);
        assert.strictEqual(g.body.decisions[0].by, 'Dr Y');
        const old = await c.handle('GET', `/api/incident/${inc.code}`, H(inc.commanderPin), '', '2.2.2.2');
        assert.strictEqual(old.body.decisions.length, 1, 'older screens see it too');
    });
    await test('a joined phone can change another phone\'s casualty (re-triage); the screen can see who first sent it', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('o1', 'O-1', 'P3', { updatedAt: clock })] }), '1.1.1.1');
        await joinAs(c, inc, 'DEVB');
        clock += 1000;
        const r = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVB', records: [rec('o1', 'O-1', 'P1', { updatedAt: clock })] }), '3.3.3.3');
        assert.strictEqual(r.body.accepted, 1);
        const g = await c.handle('GET', `/api/incident/${inc.code}`, S(inc.commanderPin), '', '2.2.2.2');
        const o = g.body.records.find(x => x.uid === 'o1');
        assert.strictEqual(o.category, 'P1');
        assert.strictEqual(o.reportedBy, 'DEVB');
        assert.strictEqual(o.firstReportedBy, 'DEVA');
        // ...but an older copy from the first phone does not undo it.
        const back = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', records: [rec('o1', 'O-1', 'P3', { updatedAt: clock - 500 })] }), '1.1.1.1');
        assert.strictEqual(back.body.kept, 1);
    });
    await test('a phone cannot join under a device code another phone holds (409), nor past the phone limit (409)', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        const taken = await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'DEVA', triager: 'Impostor' }), '6.6.6.6');
        assert.strictEqual(taken.status, 409); assert.strictEqual(taken.body.error, 'device_taken');
        const dk = {};
        for (let i = 1; i < 200; i++) { const j = await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'P' + i, triager: 'x' }), '3.3.3.3'); assert.strictEqual(j.status, 200); dk['P' + i] = j.body.deviceKey; }
        const over = await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'P200', triager: 'x' }), '3.3.3.3');
        assert.strictEqual(over.status, 409); assert.strictEqual(over.body.error, 'too_many_devices');
        // A phone already in the incident can still join again.
        assert.strictEqual((await c.handle('POST', `/api/incident/${inc.code}/join`, H(inc.pin), JSON.stringify({ deviceId: 'P5', triager: 'x', deviceKey: dk.P5 }), '3.3.3.3')).status, 200);
    });
    await test('v0.19.12: an incident with one PIN (before v0.19.6) tells phones so, so they show it', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        const meta = await store.get(`i/${inc.code}/meta`); delete meta.cmdHash; delete meta.viewHash; await store.set(`i/${inc.code}/meta`, meta);
        const j = await joinAs(c, inc, 'DEVB');
        assert.strictEqual(j.level, 'commander'); assert.strictEqual(j.singlePin, true);
        const p = await c.handle('PUT', `/api/incident/${inc.code}/records`, H(inc.pin), JSON.stringify({ deviceId: 'DEVB', records: [] }), '3.3.3.3');
        assert.strictEqual(p.body.singlePin, true);
    });
    await test('v0.19.12: an access key from before v0.19.8 no longer counts as a triager\'s key', async () => {
        const store = makeStore();
        const c = createCore({ store, now: () => clock });
        const inc = await mk(c);
        const meta = await store.get(`i/${inc.code}/meta`);
        const crypto = require('crypto');
        const sh = (x) => crypto.createHash('sha256').update(String(x)).digest('hex').slice(0, 16);
        const legacyKey = sh(meta.keySecret + ':access:' + meta.code) + sh(meta.code + ':' + meta.keySecret);
        // Lock the incident with wrong PINs from many addresses, then try the triagers' PIN from an address that has guessed.
        for (let i = 0; i < 110; i++) await c.handle('GET', `/api/incident/${inc.code}`, H('000000'), '', '10.0.' + Math.floor(i / 20) + '.' + i);
        const withOld = await c.handle('POST', `/api/incident/${inc.code}/join`, Object.assign(H(inc.pin), { 'x-incident-key': legacyKey }), JSON.stringify({ deviceId: 'DEVQ' }), '10.0.0.1');
        assert.strictEqual(withOld.status, 429);
        const withNew = await c.handle('POST', `/api/incident/${inc.code}/join`, Object.assign(H(inc.commanderPin), { 'x-incident-key': inc.accessKey }), JSON.stringify({ deviceId: 'DEVR' }), '10.0.0.1');
        assert.strictEqual(withNew.status, 200);
    });
    console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
