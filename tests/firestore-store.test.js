// Tests for the Firestore store (netlify/lib/firestore-store.js), then the whole incident-core suite run through it.
// Usage: node tests/firestore-store.test.js
// Without FIRESTORE_EMULATOR_HOST it uses a small in-memory stand-in for the Firestore client (enough of the API
// the store calls). With it (gcloud emulators firestore start --host-port=127.0.0.1:8681, then
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8681) it uses the real @google-cloud/firestore client against the emulator.
const assert = require('assert');
const crypto = require('crypto');
const { firestoreStore, firestoreConfig, docId } = require('../netlify/lib/firestore-store.js');

// Stand-in for the parts of a Firestore client the store uses: collection, doc get/set/delete, where/select/get.
function fakeFirestore() {
    const cols = new Map();
    const snap = (data) => ({ exists: !!data, get: (f) => data ? data[f] : undefined });
    function query(docs, filters, fields) {
        return {
            where(f, op, v) { return query(docs, filters.concat([[f, op, v]]), fields); },
            select(...fs) { return query(docs, filters, fs); },
            async get() {
                const out = [];
                for (const [id, text] of docs) {
                    const d = JSON.parse(text);
                    if (/[/]/.test(id) || id === '.' || id === '..' || /^__.*__$/.test(id)) throw new Error('invalid document id ' + id);
                    if (!filters.every(([f, op, v]) => op === '>=' ? d[f] >= v : op === '<' ? d[f] < v : false)) continue;
                    const picked = fields ? Object.fromEntries(fields.map(f => [f, d[f]])) : d;
                    out.push({ id, get: (f) => picked[f] });
                }
                return { docs: out };
            },
        };
    }
    return {
        // Bulk read and batched writes, as the real client: getAll(...refs) keeps the order; a batch applies on commit.
        async getAll(...refs) { if (refs.length > 500) throw new Error('too many'); return Promise.all(refs.map(r => r.get())); },
        batch() {
            const ops = [];
            return {
                set(ref, data) { ops.push(() => ref.set(data)); if (ops.length > 500) throw new Error('batch too big'); return this; },
                delete(ref) { ops.push(() => ref.delete()); if (ops.length > 500) throw new Error('batch too big'); return this; },
                async commit() { for (const op of ops) await op(); },
            };
        },
        collection(name) {
            if (!cols.has(name)) cols.set(name, new Map());
            const docs = cols.get(name);
            return Object.assign(query(docs, [], null), {
                doc(id) {
                    if (/[/]/.test(id) || id === '.' || id === '..' || /^__.*__$/.test(id)) throw new Error('invalid document id ' + id);
                    return {
                        async get() { return snap(docs.has(id) ? JSON.parse(docs.get(id)) : null); },
                        async set(data) { docs.set(id, JSON.stringify(data)); },
                        async delete() { docs.delete(id); },
                    };
                },
            });
        },
    };
}

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
let db;
if (emulator) {
    // REST, as on the live site (preferRest). The emulator accepts the fixed 'owner' token, so no real sign-in.
    const { Firestore } = require('@google-cloud/firestore');
    const { OAuth2Client } = require('google-auth-library');
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3600e3 });
    db = new Firestore({ projectId: 'mitt-test', preferRest: true, authClient: auth });
} else {
    db = fakeFirestore();
}
const fresh = () => firestoreStore(db, { collection: 't_' + crypto.randomBytes(6).toString('hex') });

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name); console.error('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 12).join('\n    ') : e)); failed++; }
}

(async () => {
    console.log(`\nfirestore-store (${emulator ? 'emulator at ' + emulator : 'in-memory stand-in'})`);
    await test('settings: all three needed, \\n escapes in the key become line breaks, defaults filled in', async () => {
        assert.strictEqual(firestoreConfig({}), null);
        assert.strictEqual(firestoreConfig({ FIRESTORE_PROJECT_ID: 'p', FIRESTORE_CLIENT_EMAIL: 'e@x' }), null);
        const c = firestoreConfig({ FIRESTORE_PROJECT_ID: ' p ', FIRESTORE_CLIENT_EMAIL: 'e@x', FIRESTORE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n' });
        assert.strictEqual(c.projectId, 'p');
        assert.strictEqual(c.databaseId, '(default)');
        assert.strictEqual(c.collection, 'mi_kv');
        assert.strictEqual(c.privateKey, '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----');
        assert.strictEqual(firestoreConfig({ FIRESTORE_PROJECT_ID: 'p', FIRESTORE_CLIENT_EMAIL: 'e', FIRESTORE_PRIVATE_KEY: 'k', FIRESTORE_DATABASE: 'mitt-london' }).databaseId, 'mitt-london');
    });
    await test('document ids never hold a slash, a lone dot or __x__, and differ for different keys', async () => {
        const keys = ['i/ABC234/meta', 'i/ABC234/r/u-1', 'rl/0123abcd', '.', '..', '__x__', 'a.b', 'a%2Eb'];
        const ids = keys.map(docId);
        ids.forEach(id => { assert.ok(!id.includes('/')); assert.ok(id !== '.' && id !== '..'); assert.ok(!/^__.*__$/.test(id)); });
        assert.strictEqual(new Set(ids).size, keys.length);
    });
    await test('the live-site client builds from the settings without contacting Google', async () => {
        const { firestoreFromConfig } = require('../netlify/lib/firestore-store.js');
        const s = firestoreFromConfig(firestoreConfig({ FIRESTORE_PROJECT_ID: 'p', FIRESTORE_CLIENT_EMAIL: 'svc@p.iam.gserviceaccount.com', FIRESTORE_PRIVATE_KEY: 'not-a-real-key' }));
        assert.strictEqual(typeof s.list, 'function');
    });
    await test('get, set, delete round-trip; a missing key is null', async () => {
        const s = fresh();
        assert.strictEqual(await s.get('i/AAA/meta'), null);
        await s.set('i/AAA/meta', { a: 1, b: [1, 2], c: 'é' });
        assert.deepStrictEqual(await s.get('i/AAA/meta'), { a: 1, b: [1, 2], c: 'é' });
        await s.delete('i/AAA/meta');
        assert.strictEqual(await s.get('i/AAA/meta'), null);
        await s.delete('i/AAA/meta'); // deleting twice is fine
    });
    await test('list returns only the prefix, sorted, with an etag that changes only when the content does', async () => {
        const s = fresh();
        await s.set('i/BBB/r/2', { x: 2 });
        await s.set('i/BBB/r/1', { x: 1 });
        await s.set('i/BBB/d/1', { d: 1 });
        await s.set('i/BBC/r/1', { other: true });
        await s.set('rl/abc', { count: 1 });
        const r = await s.list('i/BBB/r/');
        assert.deepStrictEqual(r.map(e => e.key), ['i/BBB/r/1', 'i/BBB/r/2']);
        assert.ok(r.every(e => /^[0-9a-f]{12}$/.test(e.etag)));
        assert.deepStrictEqual((await s.list('i/')).map(e => e.key), ['i/BBB/d/1', 'i/BBB/r/1', 'i/BBB/r/2', 'i/BBC/r/1']);
        const before = (await s.list('i/BBB/r/'))[0].etag;
        await s.set('i/BBB/r/1', { x: 1 });
        assert.strictEqual((await s.list('i/BBB/r/'))[0].etag, before);
        await s.set('i/BBB/r/1', { x: 99 });
        assert.notStrictEqual((await s.list('i/BBB/r/'))[0].etag, before);
        assert.deepStrictEqual(await s.list('nothing/'), []);
    });
    await test('bulk read, write and delete keep the order and cross the batch limits (700 keys)', async () => {
        const s = fresh();
        const keys = Array.from({ length: 700 }, (_, i) => `i/BLK/r/${String(i).padStart(4, '0')}`);
        await s.setMany(keys.map((k, i) => [k, { n: i }]));
        const got = await s.getMany(keys.concat(['i/BLK/r/missing']));
        assert.strictEqual(got.length, 701);
        assert.ok(got.slice(0, 700).every((v, i) => v && v.n === i));
        assert.strictEqual(got[700], null);
        assert.strictEqual((await s.list('i/BLK/')).length, 700);
        await s.deleteMany(keys);
        assert.deepStrictEqual(await s.list('i/BLK/'), []);
    });
    console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);

    // Now the full backend suite with every store it makes being a fresh Firestore collection.
    global.__makeIncidentStore = () => fresh();
    require('./incident-core.test.js');
})();
