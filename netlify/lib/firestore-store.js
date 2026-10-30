// Google Cloud Firestore store for the incident commander backend, so shared incident data can live in a
// UK region (europe-west2, London) rather than Netlify Blobs, which has no UK region.
// Same interface as the other stores (see incident-core.js): get, set, delete, list(prefix) -> [{ key, etag }].
// Each key is one document in one collection: { k: key, v: JSON text, e: etag }. The etag is a hash of the
// content, as in memoryStore, so a commander screen only re-reads what actually changed.
'use strict';
const crypto = require('crypto');

const DEFAULT_COLLECTION = 'mi_kv';
const GET_CHUNK = 300;     // documents per getAll call
const WRITE_CHUNK = 400;   // writes per batch (Firestore allows 500)
const PREFIX_END = ''; // sorts after every character a key can hold

// Firestore document ids cannot contain '/', nor be '.', '..' or __x__, so every key is percent-encoded.
function docId(key) { return encodeURIComponent(String(key)).replace(/\./g, '%2E').replace(/_/g, '%5F'); }
function etagOf(text) { return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12); }

function firestoreStore(db, opts) {
    opts = opts || {};
    const col = db.collection(opts.collection || DEFAULT_COLLECTION);
    return {
        async get(key) {
            try {
                const snap = await col.doc(docId(key)).get();
                if (!snap.exists) return null;
                const v = snap.get('v');
                return typeof v === 'string' ? JSON.parse(v) : null;
            } catch (e) { return null; }
        },
        async set(key, value) {
            const text = JSON.stringify(value);
            await col.doc(docId(key)).set({ k: String(key), v: text, e: etagOf(text) });
        },
        async delete(key) { await col.doc(docId(key)).delete(); },
        // Many keys in one round trip each way (a commander read of 1,000 records took 6-8 s one document at a time).
        async getMany(keys) {
            const out = [];
            for (let i = 0; i < keys.length; i += GET_CHUNK) {
                const refs = keys.slice(i, i + GET_CHUNK).map(k => col.doc(docId(k)));
                let snaps = [];
                try { snaps = refs.length ? await db.getAll(...refs) : []; } catch (e) { snaps = []; }
                refs.forEach((r, j) => {
                    const sn = snaps[j];
                    let v = null;
                    try { const t = sn && sn.exists ? sn.get('v') : null; v = typeof t === 'string' ? JSON.parse(t) : null; } catch (e) { v = null; }
                    out.push(v);
                });
            }
            return out;
        },
        async setMany(entries) {
            for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
                const batch = db.batch();
                entries.slice(i, i + WRITE_CHUNK).forEach(([key, value]) => { const text = JSON.stringify(value); batch.set(col.doc(docId(key)), { k: String(key), v: text, e: etagOf(text) }); });
                await batch.commit();
            }
        },
        async deleteMany(keys) {
            for (let i = 0; i < keys.length; i += WRITE_CHUNK) {
                const batch = db.batch();
                keys.slice(i, i + WRITE_CHUNK).forEach(k => batch.delete(col.doc(docId(k))));
                await batch.commit();
            }
        },
        async list(prefix) {
            prefix = String(prefix || '');
            const snap = await col.where('k', '>=', prefix).where('k', '<', prefix + PREFIX_END).select('k', 'e').get();
            return snap.docs.map(d => ({ key: String(d.get('k') || ''), etag: String(d.get('e') || '') }))
                .filter(x => x.key.startsWith(prefix))
                .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        },
    };
}

// The Firestore settings from the environment, or null when they are not all set (the site then uses Netlify Blobs).
// FIRESTORE_PRIVATE_KEY may be pasted with real line breaks or with \n escapes; both work.
function firestoreConfig(env) {
    env = env || {};
    const projectId = String(env.FIRESTORE_PROJECT_ID || '').trim();
    const clientEmail = String(env.FIRESTORE_CLIENT_EMAIL || '').trim();
    const privateKey = String(env.FIRESTORE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
    if (!projectId || !clientEmail || !privateKey) return null;
    return {
        projectId,
        databaseId: String(env.FIRESTORE_DATABASE || '').trim() || '(default)',
        collection: String(env.FIRESTORE_COLLECTION || '').trim() || DEFAULT_COLLECTION,
        clientEmail,
        privateKey,
    };
}

function firestoreFromConfig(cfg) {
    const { Firestore } = require('@google-cloud/firestore');
    const db = new Firestore({
        projectId: cfg.projectId,
        databaseId: cfg.databaseId,
        credentials: { client_email: cfg.clientEmail, private_key: cfg.privateKey },
        preferRest: true,          // plain HTTPS, quicker to start in a short-lived function than gRPC
        ignoreUndefinedProperties: true,
    });
    return firestoreStore(db, { collection: cfg.collection });
}

module.exports = { firestoreStore, firestoreConfig, firestoreFromConfig, docId, DEFAULT_COLLECTION };
