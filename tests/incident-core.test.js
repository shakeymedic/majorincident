// Tests for the incident commander backend (netlify/lib/incident-core.js) with an in-memory store.
// Usage: node tests/incident-core.test.js
// tests/firestore-store.test.js runs this same suite through the Firestore store by setting global.__makeIncidentStore.
const assert = require('assert');
const { createCore, memoryStore, TTL_MS, STALE_DEVICE_MS } = require('../netlify/lib/incident-core.js');

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
    let code = '', pin = '';
    await test('create returns a 6-char code and a 6-digit PIN', async () => {
        const r = await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA', triager: 'Medic A', name: 'Station fire', incidentCode: 'ex-1', app: '0.10.0' }), '1.1.1.1');
        assert.strictEqual(r.status, 201);
        assert.match(r.body.code, /^[A-HJ-NP-Z2-9]{6}$/);
        assert.match(r.body.pin, /^\d{6}$/);
        assert.strictEqual(r.body.expiresAt, clock + TTL_MS);
        code = r.body.code; pin = r.body.pin;
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
    await test('unknown code is 404 even with a PIN; code is case-insensitive', async () => {
        assert.strictEqual((await core.handle('GET', '/api/incident/ZZZZZZ', H(pin), '', '2.2.2.2')).status, 404);
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
    await test('close deletes everything; the code then reads as unknown', async () => {
        const r = await core.handle('POST', `/api/incident/${code}/close`, H(pin), '', '1.1.1.1');
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.deleted >= 6);
        assert.strictEqual((await store.list('i/')).length, 0);
        assert.strictEqual((await core.handle('GET', `/api/incident/${code}`, H(pin), '', '2.2.2.2')).status, 404);
    });
    await test('an incident with no writes for 24 hours is deleted on access (410) and by the sweep', async () => {
        const c1 = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        const c2 = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        clock += TTL_MS - 1000;
        await core.handle('PUT', `/api/incident/${c2.code}/records`, H(c2.pin), JSON.stringify({ deviceId: 'DEVA', records: [] }), '1.1.1.1'); // keeps c2 alive
        clock += 2000;
        assert.strictEqual((await core.handle('GET', `/api/incident/${c1.code}`, H(c1.pin), '', '2.2.2.2')).status, 410);
        const c3 = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        clock += TTL_MS - 3000;
        await core.handle('PUT', `/api/incident/${c2.code}/records`, H(c2.pin), JSON.stringify({ deviceId: 'DEVA', records: [] }), '1.1.1.1'); // keeps c2 alive again
        clock += 4000; // c3 is now past its 24 hours; c2 was written 4 s ago
        const sweep = await core.cleanup();
        assert.strictEqual(sweep.incidents, 2);
        assert.strictEqual((await core.handle('GET', `/api/incident/${c3.code}`, H(c3.pin), '', '2.2.2.2')).status, 404);
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
    await test('the view-only PIN can read but not join, push or close; the right PIN still does everything', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA', triager: 'Medic A' }), '1.1.1.1')).body;
        assert.match(c.viewPin, /^\d{6}$/);
        assert.notStrictEqual(c.viewPin, c.pin);
        const g = await core.handle('GET', `/api/incident/${c.code}`, H(c.viewPin), '', '2.2.2.2');
        assert.strictEqual(g.status, 200);
        assert.strictEqual(g.body.viewOnly, true);
        assert.strictEqual((await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).body.viewOnly, false);
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
        assert.strictEqual((await core.handle('POST', `/api/incident/${c.code}/duress-clear`, H(c.pin), JSON.stringify({ deviceId: 'NOPE' }), '3.3.3.3')).status, 404);
        const ack = await core.handle('POST', `/api/incident/${c.code}/duress-clear`, H(c.pin), JSON.stringify({ deviceId: 'DEVA' }), '3.3.3.3');
        assert.strictEqual(ack.status, 200);
        assert.ok(ack.body.duress.clearedAt > 0);
        assert.strictEqual(ack.body.duress.clearedBy, 'commander');
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
    await test('two phones pushing at the same moment never leave the commander screen a change behind', async () => {
        // A store where every operation takes a little time, so the two pushes interleave as they would on Netlify.
        const slow = makeStore({ jitter: 3 });
        const core2 = createCore({ store: slow, now: () => clock });
        const c = (await core2.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
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
    await test('the wrong-PIN lock-out survives a server restart and is cleared by the sweep after 15 minutes', async () => {
        const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'DEVA' }), '1.1.1.1')).body;
        for (let i = 0; i < 25; i++) await core.handle('GET', `/api/incident/${c.code}`, H('000000'), '', '8.8.8.8');
        const fresh = createCore({ store, now: () => clock });   // a cold start with an empty memory and the same storage
        assert.strictEqual((await fresh.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '8.8.8.8')).status, 429);
        assert.strictEqual((await fresh.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '2.2.2.2')).status, 200);
        assert.ok((await store.list('rl/')).length >= 1);
        assert.strictEqual(JSON.stringify(await store.list('rl/')).indexOf('8.8.8.8'), -1, 'the address itself is not stored');
        clock += 15 * 60 * 1000 + 1;
        const sw = await fresh.cleanup();
        assert.ok(sw.removedLocks >= 1);
        assert.strictEqual((await store.list('rl/')).length, 0);
        assert.strictEqual((await fresh.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '8.8.8.8')).status, 200);
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
        const m = await core4.handle('POST', `/api/incident/${c.code}/marks`, H(c.pin), JSON.stringify({ marks: [{ type: 'inner', lat: 52.45, lng: -1.9, radius: 150 }, { type: 'rvp', lat: 52.46, lng: -1.91, label: 'Main gate' }, { type: 'nonsense', lat: 1, lng: 1 }, { type: 'hazard', lat: 999, lng: 1 }] }), '2.2.2.2');
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
    console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
