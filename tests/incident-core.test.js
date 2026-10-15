// Tests for the incident commander backend (netlify/lib/incident-core.js) with an in-memory store.
// Usage: node tests/incident-core.test.js
const assert = require('assert');
const { createCore, memoryStore, TTL_MS, STALE_DEVICE_MS } = require('../netlify/lib/incident-core.js');

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
    const store = memoryStore();
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
        assert.strictEqual(store.size(), 0);
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
    console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
