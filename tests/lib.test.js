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

group('structured injuries', () => {
    test('buildInjuryMark normalises x/y and classifies region/side', () => {
        const m = lib.buildInjuryMark({ x: 30, y: 50, label: 'Burn', severity: 'severe', ts: 1700000000000 });
        assert.strictEqual(m.region, 'Head/Neck');
        assert.strictEqual(m.side, 'Left');
        assert.ok(m.x > 0 && m.x < 1);
        assert.ok(m.y > 0 && m.y < 1);
        assert.strictEqual(m.label, 'Burn');
        assert.strictEqual(m.severity, 'severe');
    });
    test('classifyBodymapPoint covers torso/legs/right side', () => {
        assert.deepStrictEqual(lib.classifyBodymapPoint(150, 300), { region: 'Legs', side: 'Right' });
        assert.deepStrictEqual(lib.classifyBodymapPoint(110, 150), { region: 'Torso/Arms', side: 'Right' });
    });
    test('injuriesToText formats marks for legacy notes', () => {
        const m = lib.buildInjuryMark({ x: 100, y: 150, label: 'Bleed', severity: 'moderate', ts: 1700000000000 });
        const txt = lib.injuriesToText([m]);
        assert.match(txt, /Torso\/Arms/);
        assert.match(txt, /Bleed/);
    });
    test('sanitiseInjuries clamps fields and rejects junk', () => {
        const bad = [null, 'string', { x: -5, y: 99, label: 'A'.repeat(200), severity: 'XX'.repeat(20) }];
        const ok = lib.sanitiseInjuries(bad);
        assert.strictEqual(ok.length, 1);
        assert.strictEqual(ok[0].x, 0);
        assert.strictEqual(ok[0].y, 1);
        assert.ok(ok[0].label.length <= 64);
    });
    test('round-trip through QR preserves injuries', () => {
        const entry = { id: 'X', category: 'P1', injuries: [{ region: 'Head/Neck', side: 'Left', x: 0.1, y: 0.1, label: 'Cut', severity: 'minor', time: '12:00', ts: 1 }] };
        const w = lib.buildPatientPayload(entry, {}, { now: 1700000000000 });
        const r = lib.validatePatientWrapper(w, { now: 1700000000000 });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.data.injuries.length, 1);
        assert.strictEqual(r.data.injuries[0].label, 'Cut');
    });
});

group('mergePatientRecords + injuries', () => {
    test('union injury marks without dropping local', () => {
        const local = { id: 'A', category: 'P2', _rev: 1, injuries: [{ region: 'Legs', x: 0.5, y: 0.7, label: 'Frac', ts: 1 }] };
        const incoming = { id: 'A', injuries: [{ region: 'Torso/Arms', x: 0.5, y: 0.4, label: 'Burn', ts: 2 }] };
        const out = lib.mergePatientRecords(local, incoming, { recordVersion: 2 });
        assert.strictEqual(out.injuries.length, 2);
    });
    test('reassessment fields preserved across merge if incoming newer', () => {
        const local = { id: 'A', category: 'P1', _rev: 1, lastReassessed: 100 };
        const incoming = { id: 'A', lastReassessed: 200, reassessOutcome: 'worsened' };
        const out = lib.mergePatientRecords(local, incoming, { recordVersion: 2 });
        assert.strictEqual(out.lastReassessed, 200);
        assert.strictEqual(out.reassessOutcome, 'worsened');
    });
});

group('bulk handover', () => {
    const ctx = { now: 1700000000000, sender: 'Lead 1', appVersion: '0.5.0' };
    const entries = [
        { id: 'TST-001', category: 'P1', triager: 'A', _rev: 1 },
        { id: 'TST-002', category: 'P2', triager: 'A', _rev: 1 },
    ];
    test('build/validate round-trip', () => {
        const w = lib.buildBulkPayload(entries, { sector: 'CCS', ttlMs: 60000 }, ctx);
        assert.strictEqual(w.t, 'MIT_BULK');
        assert.strictEqual(w.n, 2);
        assert.match(w.h, /^[0-9a-f]{8}$/);
        const r = lib.validateBulkWrapper(w, { now: ctx.now });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.data.length, 2);
        assert.strictEqual(r.data[0].id, 'TST-001');
        assert.strictEqual(r.meta.sector, 'CCS');
    });
    test('rejects expired bulk', () => {
        const w = lib.buildBulkPayload(entries, { ttlMs: 60000 }, ctx);
        const r = lib.validateBulkWrapper(w, { now: ctx.now + 120000 });
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /expired/i);
    });
    test('bulkPayloadFits flags oversize payloads', () => {
        const big = Array.from({ length: 60 }, (_, i) => ({
            id: 'X-' + i, category: 'P1', triager: 'A',
            notes: 'Lorem ipsum dolor sit amet, '.repeat(8),
        }));
        const w = lib.buildBulkPayload(big, {}, ctx);
        assert.strictEqual(lib.bulkPayloadFits(w), false);
    });
});

group('duplicate matching', () => {
    test('exact ID returns 1.0', () => {
        assert.strictEqual(lib.similarityScore({ id: 'A' }, { id: 'A' }), 1);
    });
    test('different IDs but matching demos+sector+time score high', () => {
        const a = { id: 'A', demos: '35M', sector: 'CCS', category: 'P1', timestamp: 1000 };
        const b = { id: 'B', demos: '35M', sector: 'CCS', category: 'P1', timestamp: 1000 };
        const s = lib.similarityScore(a, b);
        assert.ok(s > 0.85, 'expected high similarity, got ' + s);
    });
    test('GPS proximity contributes to score', () => {
        const a = { id: 'A', location: { lat: '53.480000', lng: '-2.242600' } };
        const b = { id: 'B', location: { lat: '53.480010', lng: '-2.242600' } };
        const s = lib.similarityScore(a, b);
        assert.ok(s > 0.5);
    });
    test('findDuplicateCandidates respects threshold and never silently merges', () => {
        const incoming = { id: 'NEW', demos: '40F', sector: 'Decon', category: 'P2', timestamp: 5000 };
        const existing = [
            { id: 'OLD', demos: '40F', sector: 'Decon', category: 'P2', timestamp: 5000 },
            { id: 'X',   demos: '12M', sector: 'Other', category: 'P3', timestamp: 9999999 },
        ];
        const cands = lib.findDuplicateCandidates(incoming, existing);
        assert.strictEqual(cands.length, 1);
        assert.strictEqual(cands[0].candidate.id, 'OLD');
        assert.ok(cands[0].score >= 0.65);
    });
});

group('reassessment', () => {
    test('P1 due in 10 minutes from triage', () => {
        const e = { id: 'A', category: 'P1', timestamp: 1000 };
        assert.strictEqual(lib.nextReassessmentDue(e), 1000 + 10*60*1000);
    });
    test('DEAD has no reassessment', () => {
        assert.strictEqual(lib.nextReassessmentDue({ id: 'A', category: 'DEAD' }), null);
    });
    test('reassessmentStatus flags overdue', () => {
        const e = { id: 'A', category: 'P1', timestamp: 0 };
        const s = lib.reassessmentStatus(e, 60*60*1000);
        assert.strictEqual(s.state, 'overdue');
    });
    test('applyReassessment bumps lastReassessed and rev', () => {
        const e = { id: 'A', category: 'P1', timestamp: 1, _rev: 2 };
        const out = lib.applyReassessment(e, 'improved', 1000);
        assert.strictEqual(out.lastReassessed, 1000);
        assert.strictEqual(out.reassessOutcome, 'improved');
        assert.strictEqual(out._rev, 3);
    });
});

group('deterioration', () => {
    test('P2 -> P1 is worsening', () => {
        assert.strictEqual(lib.categoryWorsened('P2', 'P1'), true);
    });
    test('P1 -> DEAD is worsening', () => {
        assert.strictEqual(lib.categoryWorsened('P1', 'DEAD'), true);
    });
    test('P2 -> P3 (improvement) is NOT worsening', () => {
        assert.strictEqual(lib.categoryWorsened('P2', 'P3'), false);
    });
    test('same category is not worsening', () => {
        assert.strictEqual(lib.categoryWorsened('P1', 'P1'), false);
    });
});

group('timeline', () => {
    test('combines triage, interventions, injuries, audit in chronological order', () => {
        const entry = {
            id: 'A', category: 'P1', reason: 'Bleed', tool: 'TST', timestamp: 1000,
            interventions: { Tourniquet: { time: '12:00', ts: 2000 } },
            injuries: [{ region: 'Legs', side: 'Right', label: 'Frac', ts: 1500 }],
            lastReassessed: 3000, reassessOutcome: 'unchanged',
        };
        const audit = [
            { patientId: 'A', action: 'EVACUATION', clinTime: 4000, sysTime: 4000, details: 'AMB-1' },
            { patientId: 'B', action: 'X', clinTime: 999, sysTime: 999 },
        ];
        const tl = lib.buildPatientTimeline(entry, audit);
        const ts = tl.map(e => e.ts);
        const sorted = ts.slice().sort((a,b)=>a-b);
        assert.deepStrictEqual(ts, sorted);
        const kinds = tl.map(e => e.kind);
        assert.ok(kinds.includes('triage'));
        assert.ok(kinds.includes('intervention'));
        assert.ok(kinds.includes('injury'));
        assert.ok(kinds.includes('reassess'));
        assert.ok(kinds.includes('audit'));
    });
});

group('shortCodeFromHash', () => {
    test('produces 6-char base32 codes', () => {
        const c = lib.shortCodeFromHash('abc12345');
        assert.match(c, /^[0-9A-HJKMNP-TV-Z]{6}$/);
    });
});

console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
