// Load test for the incident commander backend: many phones pushing at once, then commander reads of a big
// incident. Runs against the real request handling with an in-memory store whose every operation takes a
// little time (like a real blob store), so it measures round trips, not CPU.
// Usage: node tests/load.test.js            (defaults: 30 phones x 10 records, 2 ms per store operation)
//        PHONES=50 RECORDS=20 node tests/load.test.js
'use strict';
const assert = require('assert');
const { createCore, memoryStore } = require('../netlify/lib/incident-core.js');

const PHONES = +process.env.PHONES || 30;
const RECORDS = +process.env.RECORDS || 10;
const DELAY = process.env.DELAY !== undefined ? +process.env.DELAY : 2;
const MAX_READ_MS = +process.env.MAX_READ_MS || 1500;   // a Netlify function has 10 s; the commander page gives up at 20 s

function rec(uid, id, category, t) {
    return { uid, id, category, tool: 'TST', timestamp: t, updatedAt: t, triager: 'Load ' + uid.slice(0, 3), sector: 'Sector ' + (uid.charCodeAt(0) % 5), notes: 'load test '.repeat(20), currentLocation: { lat: 53.48 + Math.random() / 100, lng: -2.24 + Math.random() / 100, acc: 8, timestamp: t }, interventions: { Oxygen: { time: '10:00', ts: t } }, triageHistory: [{ ts: t, category, tool: 'TST', reason: 'Walking', by: 'x', kind: 'triage' }] };
}

(async () => {
    let clock = 1760000000000;
    const store = memoryStore({ delay: DELAY });
    const core = createCore({ store, now: () => clock });
    const H = (pin) => ({ 'x-incident-pin': pin });
    const c = (await core.handle('POST', '/api/incident', {}, JSON.stringify({ deviceId: 'CTRL00', triager: 'Control' }), '10.0.0.0')).body;
    console.log(`\nload: ${PHONES} phones x ${RECORDS} records, ${DELAY} ms per store operation`);

    // 1. Everyone joins at once.
    let t0 = Date.now();
    const joins = await Promise.all(Array.from({ length: PHONES }, (_, i) => core.handle('POST', `/api/incident/${c.code}/join`, H(c.pin), JSON.stringify({ deviceId: 'LOAD' + String(i).padStart(2, '0'), triager: 'Phone ' + i }), '10.0.0.' + i)));
    assert.ok(joins.every(j => j.status === 200), 'every phone joined');
    console.log(`  ✓ ${PHONES} phones joined together in ${Date.now() - t0} ms`);

    // 2. Everyone pushes at once, twice (first push creates, second updates), while the commander keeps polling.
    let known = '', polls = 0, fulls = 0, pollMs = 0, behind = 0;
    const poll = async () => {
        const s = Date.now();
        const r = await core.handle('GET', `/api/incident/${c.code}`, Object.assign(H(c.pin), { 'x-incident-seq': known }), '', '10.0.1.1');
        pollMs += Date.now() - s; polls++;
        if (r.status === 200) { known = r.headers['X-Incident-Seq']; fulls++; return r.body; }
        assert.strictEqual(r.status, 304);
        return null;
    };
    t0 = Date.now();
    for (let round = 0; round < 2; round++) {
        clock += 1000;
        const pushes = Array.from({ length: PHONES }, (_, i) => core.handle('PUT', `/api/incident/${c.code}/records`, H(c.pin), JSON.stringify({ deviceId: 'LOAD' + String(i).padStart(2, '0'), triager: 'Phone ' + i, totalRecords: RECORDS, records: Array.from({ length: RECORDS }, (_, k) => rec(`u${i}_${k}`, `P${i}-TST-${k}`, ['P1', 'P2', 'P3'][k % 3], clock + k)) }), '10.0.0.' + i));
        const polling = (async () => { while (true) { await new Promise(r => setTimeout(r, 15)); await poll(); if (pushes.every(p => p.settled)) break; } })();
        pushes.forEach(p => p.then(() => { p.settled = true; }));
        const results = await Promise.all(pushes);
        await polling;
        assert.ok(results.every(r => r.status === 200), 'every push accepted: ' + JSON.stringify(results.filter(r => r.status !== 200).map(r => r.body)));
    }
    const pushMs = Date.now() - t0;
    console.log(`  ✓ ${PHONES * RECORDS * 2} records pushed in two concurrent waves in ${pushMs} ms, with ${polls} commander polls meanwhile (${fulls} full reads, average ${Math.round(pollMs / Math.max(1, polls))} ms)`);

    // 3. After everything has landed, the commander must see every record on its next poll (or already have it).
    const after = await core.handle('GET', `/api/incident/${c.code}`, Object.assign(H(c.pin), { 'x-incident-seq': known }), '', '10.0.1.1');
    let body = after.body;
    if (after.status === 304) { body = (await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '10.0.1.2')).body; behind = body.records.length === PHONES * RECORDS ? 0 : 1; }
    assert.strictEqual(behind, 0, 'the commander was told "no change" while records were still missing');
    assert.strictEqual(body.records.length, PHONES * RECORDS);
    assert.strictEqual(body.devices.length, PHONES + 1);
    console.log(`  ✓ commander sees all ${body.records.length} records and ${body.devices.length} phones`);

    // 4. Full read time of the big incident, versus what fetching one blob at a time would cost.
    const ops0 = store.ops();
    t0 = Date.now();
    const full = await core.handle('GET', `/api/incident/${c.code}`, H(c.pin), '', '10.0.1.3');
    const readMs = Date.now() - t0;
    const ops = store.ops() - ops0;
    assert.strictEqual(full.status, 200);
    const sequentialMs = ops * DELAY;
    console.log(`  ✓ full read: ${readMs} ms for ${ops} store operations (one at a time would take about ${sequentialMs} ms); payload ${Math.round(JSON.stringify(full.body).length / 1024)} KB`);
    assert.ok(readMs < MAX_READ_MS, `full read took ${readMs} ms, limit ${MAX_READ_MS} ms`);

    // 5. An unchanged incident costs only the two listings.
    const ops1 = store.ops();
    const nc = await core.handle('GET', `/api/incident/${c.code}`, Object.assign(H(c.pin), { 'x-incident-seq': full.headers['X-Incident-Seq'] }), '', '10.0.1.3');
    assert.strictEqual(nc.status, 304);
    console.log(`  ✓ "no change" poll costs ${store.ops() - ops1} store operations`);
    console.log('\n✓ load test passed');
})().catch(e => { console.error('\n✗ load test failed\n', e && e.stack || e); process.exit(1); });
