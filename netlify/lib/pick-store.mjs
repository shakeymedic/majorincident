// Chooses where the incident commander data is kept. Firestore (UK, London) once its three settings are in the
// Netlify environment; Netlify Blobs until then, so the site keeps working while the switch is set up.
// The function files pass in firestore-store.js themselves: this file is bundled into each function, so a
// require() here would resolve from netlify/functions/, not from this folder.
import { getStore } from '@netlify/blobs';

function blobStore() {
    const s = getStore({ name: 'incidents', consistency: 'strong' });
    return {
        async get(key) { try { return await s.get(key, { type: 'json' }); } catch (e) { return null; } },
        async set(key, value) { await s.setJSON(key, value); },
        async delete(key) { await s.delete(key); },
        // Netlify Blobs has no atomic increment: a read and a write (two server copies at once can each miss the
        // other's count). Only used until Firestore is set up; production uses Firestore.
        async incr(key, fields) { let cur = null; try { cur = await s.get(key, { type: 'json' }); } catch (e) {} const n = (cur && cur.n) || {}; Object.keys(fields).forEach(f => { n[f] = (n[f] || 0) + fields[f]; }); await s.setJSON(key, { n }); },
        async counts(keys) { return Promise.all(keys.map(async k => { try { const v = await s.get(k, { type: 'json' }); return (v && v.n) || null; } catch (e) { return null; } })); },
        async list(prefix) { const r = await s.list({ prefix }); return (r.blobs || []).map(b => ({ key: b.key, etag: b.etag || '' })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0); },
    };
}

// Returns { store, name }. name goes in the X-Incident-Store response header so the live site shows which is in use.
export function pickStore(firestore, env = process.env) {
    const cfg = firestore.firestoreConfig(env);
    if (cfg) return { store: firestore.firestoreFromConfig(cfg), name: 'firestore' };
    return { store: blobStore(), name: 'netlify-blobs' };
}
