// Google Cloud Firestore store for the incident commander backend, so shared incident data can live in a
// UK region (europe-west2, London) rather than Netlify Blobs, which has no UK region.
// Same interface as the other stores (see incident-core.js): get, set, delete, list(prefix) -> [{ key, etag }].
// Each key is one document in one collection: { k: key, v: JSON text, e: etag }. The etag is a hash of the
// content, as in memoryStore, so a commander screen only re-reads what actually changed.
'use strict';
const crypto = require('crypto');

const DEFAULT_COLLECTION = 'mi_kv';
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
