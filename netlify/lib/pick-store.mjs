// Chooses where the incident commander data is kept. Firestore (UK, London) once its three settings are in the
// Netlify environment; Netlify Blobs until then, so the site keeps working while the switch is set up.
import { getStore } from '@netlify/blobs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { firestoreConfig, firestoreFromConfig } = require('./firestore-store.js');

function blobStore() {
    const s = getStore({ name: 'incidents', consistency: 'strong' });
    return {
        async get(key) { try { return await s.get(key, { type: 'json' }); } catch (e) { return null; } },
        async set(key, value) { await s.setJSON(key, value); },
        async delete(key) { await s.delete(key); },
        async list(prefix) { const r = await s.list({ prefix }); return (r.blobs || []).map(b => ({ key: b.key, etag: b.etag || '' })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0); },
    };
}

// Returns { store, name }. name goes in the X-Incident-Store response header so the live site shows which is in use.
export function pickStore(env = process.env) {
    const cfg = firestoreConfig(env);
    if (cfg) return { store: firestoreFromConfig(cfg), name: 'firestore' };
    return { store: blobStore(), name: 'netlify-blobs' };
}
