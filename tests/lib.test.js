// Lightweight tests for lib.js — runs under plain Node (no test framework).
// Usage: node tests/lib.test.js
const assert = require('assert');
const lib = require('../lib.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name); console.error('    ' + (e && e.stack ? e.stack : e)); failed++; }
}
function group(name, fn) { console.log('\n' + name); fn(); }

group('escapeHTML', () => {
    test('escapes basic XSS payloads', () => {
        assert.strictEqual(lib.escapeHTML('<img src=x onerror=alert(1)>'),
            '&lt;img src=x onerror=alert(1)&gt;');
        assert.strictEqual(lib.escapeHTML(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
    });
    test('handles null/undefined safely', () => {
        assert.strictEqual(lib.escapeHTML(null), '');
        assert.strictEqual(lib.escapeHTML(undefined), '');
    });
});

group('fnv1a', () => {
    test('is deterministic and order-sensitive', () => {
        assert.strictEqual(lib.fnv1a('a'), lib.fnv1a('a'));
        assert.notStrictEqual(lib.fnv1a('ab'), lib.fnv1a('ba'));
    });
    test('produces 8-char hex', () => {
        assert.match(lib.fnv1a('any-string'), /^[0-9a-f]{8}$/);
    });
});

group('buildPatientPayload', () => {
    const sample = {
        id: 'TST-001', time: '12:34', timestamp: 1700000000000,
        tool: 'TST', category: 'P1', action: 'Immediate', reason: 'Catastrophic Bleeding',
        triager: 'Medic 1', highRisk: true, sector: 'CCS',
        notes: 'Bleeding right leg', demos: '35M',
        interventions: { Tourniquet: { time: '12:35', ts: 1700000060000 } },
        evacuated: false, evacDest: '', evacVehicle: '',
        _rev: 2,
    };
    test('contains versioning, expiry, integrity hash', () => {
        const ctx = { now: 1700000000000, sender: 'Medic 1', appVersion: '0.4.0' };
        const w = lib.buildPatientPayload(sample, { ttlMs: 60000 }, ctx);
        assert.strictEqual(w.t, 'MIT_P');
        assert.strictEqual(w.v, lib.QR_SCHEMA_VERSION);
        assert.strictEqual(w.rv, 2);
        assert.strictEqual(w.g, 1700000000000);
        assert.strictEqual(w.x, 1700000000000 + 60000);
        assert.match(w.h, /^[0-9a-f]{8}$/);
        assert.strictEqual(w.sndr, 'Medic 1');
        assert.strictEqual(w.app, '0.4.0');
        assert.deepStrictEqual(w.d.in, sample.interventions);
    });
    test('omits empty fields', () => {
        const w = lib.buildPatientPayload({ id: 'X', category: 'P3' }, {}, { now: 1700000000000 });
        assert.ok(!('al' in w.d));
        assert.ok(!('hr' in w.d));
        assert.ok(!('in' in w.d));
    });
});

group('validatePatientWrapper', () => {
    const ctx = { now: 1700000000000, sender: 'Medic 1' };
    const sample = { id: 'TST-001', category: 'P1', triager: 'Medic 1' };
    test('accepts a freshly-built payload', () => {
        const w = lib.buildPatientPayload(sample, { ttlMs: 60000 }, ctx);
        const r = lib.validatePatientWrapper(w, { now: ctx.now });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.meta.integrityOk, true);
        assert.strictEqual(r.data.id, 'TST-001');
        assert.strictEqual(r.data.category, 'P1');
    });
    test('rejects expired payloads', () => {
        const w = lib.buildPatientPayload(sample, { ttlMs: 60000 }, ctx);
        const r = lib.validatePatientWrapper(w, { now: ctx.now + 120000 });
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /expired/i);
    });
    test('rejects future-clock payloads', () => {
        const w = lib.buildPatientPayload(sample, { ttlMs: 60000 }, { now: ctx.now + 600000 });
        const r = lib.validatePatientWrapper(w, { now: ctx.now });
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /future/i);
    });
    test('rejects tampered integrity', () => {
        const w = lib.buildPatientPayload(sample, { ttlMs: 60000 }, ctx);
        // Mutate after hashing to force mismatch; remains valid for parse but integrityOk=false
        w.d.c = 'P3';
        const r = lib.validatePatientWrapper(w, { now: ctx.now });
        assert.strictEqual(r.ok, true); // schema-valid but integrity flagged
        assert.strictEqual(r.meta.integrityOk, false);
    });
    test('rejects missing patient id', () => {
        const w = lib.buildPatientPayload({ category: 'P1' }, { ttlMs: 60000 }, ctx);
        const r = lib.validatePatientWrapper(w, { now: ctx.now });
        assert.strictEqual(r.ok, false);
    });
    test('rejects unknown category', () => {
        const w = lib.buildPatientPayload({ id: 'X', category: 'PURPLE' }, { ttlMs: 60000 }, ctx);
        const r = lib.validatePatientWrapper(w, { now: ctx.now });
        assert.strictEqual(r.ok, false);
    });
    test('rejects non-MITT payloads', () => {
        const r = lib.validatePatientWrapper({ t: 'OTHER', d: { i: 'x', c: 'P1' } });
        assert.strictEqual(r.ok, false);
    });
});

group('mergePatientRecords', () => {
    const localBase = {
        id: 'TST-001', category: 'P2', triager: 'Local Medic',
        notes: 'Initial assessment.', _rev: 3,
        interventions: { 'Wound Packing': { time: '11:00', ts: 1 } },
    };
    test('preserves local interventions', () => {
        const incoming = { id: 'TST-001', category: 'P1', notes: 'Re-check' };
        const out = lib.mergePatientRecords(localBase, incoming, { recordVersion: 5, sender: 'Other' });
        assert.ok(out.interventions['Wound Packing'], 'local intervention preserved');
        assert.strictEqual(out.category, 'P1', 'newer remote wins on category');
    });
    test('does not silently overwrite older remote', () => {
        const incoming = { id: 'TST-001', category: 'DEAD', notes: 'Old data' };
        const out = lib.mergePatientRecords(localBase, incoming, { recordVersion: 1, sender: 'Other' });
        assert.strictEqual(out.category, 'P2', 'older remote does not overwrite');
    });
    test('appends incoming notes with sender tag', () => {
        const incoming = { id: 'TST-001', notes: 'Spinal precautions' };
        const out = lib.mergePatientRecords(localBase, incoming, { recordVersion: 5, sender: 'Other' });
        assert.match(out.notes, /Spinal precautions/);
        assert.match(out.notes, /Imported from Other/);
    });
    test('unions interventions without dropping local', () => {
        const incoming = { interventions: { Tourniquet: { time: '11:30' } } };
        const out = lib.mergePatientRecords(localBase, incoming, { recordVersion: 5 });
        assert.ok(out.interventions['Tourniquet']);
        assert.ok(out.interventions['Wound Packing']);
    });
});

group('buildAckPayload', () => {
    test('uses provided receiver name verbatim', () => {
        const ack = lib.buildAckPayload('TST-001', 'Receiver Medic', { now: 1700000000000, appVersion: '0.5.0' });
        assert.strictEqual(ack.t, 'MIT_ACK');
        assert.strictEqual(ack.pid, 'TST-001');
        assert.strictEqual(ack.rcv, 'Receiver Medic');
        assert.strictEqual(ack.g, 1700000000000);
        assert.strictEqual(ack.app, '0.5.0');
    });
    test('regression: ACK records the local accepting user, NOT the sender', () => {
        // Simulates acceptPreview: the local user (triagerName) is the receiver.
        // The sender's name must never end up in `rcv`, otherwise when the
        // sender scans the ACK their device logs HANDOVER_ACCEPTED against the
        // wrong identity.
        const senderName = 'Sender Medic';
        const localTriager = 'Local Medic';
        const ack = lib.buildAckPayload('TST-001', localTriager, {});
        assert.strictEqual(ack.rcv, localTriager);
        assert.notStrictEqual(ack.rcv, senderName);
    });
    test('handles empty receiver gracefully', () => {
        const ack = lib.buildAckPayload('TST-001', '', {});
        assert.strictEqual(ack.rcv, '');
    });
});

group('triage flows', () => {
    test('TST: walking yes -> P3', () => {
        assert.deepStrictEqual(lib.tstNext('walking', true), { type: 'result', category: 'P3', reason: 'Walking' });
    });
    test('TST: bleeding yes -> P1', () => {
        assert.strictEqual(lib.tstNext('bleeding', true).category, 'P1');
    });
    test('TST: not breathing -> DEAD', () => {
        assert.strictEqual(lib.tstNext('breathing', false).category, 'DEAD');
    });
    test('MITT: cat_bleed yes -> P1', () => {
        assert.strictEqual(lib.mittNext('cat_bleed', true).category, 'P1');
    });
    test('MITT: hr no (>=100) -> P1', () => {
        assert.strictEqual(lib.mittNext('hr', false).category, 'P1');
    });
    test('MITT: hr yes (<100) -> P2', () => {
        assert.strictEqual(lib.mittNext('hr', true).category, 'P2');
    });
    test('MITT: voice no -> P1', () => {
        assert.strictEqual(lib.mittNext('voice', false).category, 'P1');
    });
});

console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
