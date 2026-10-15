// Hourly sweep: delete incidents that have had no writes for 24 hours (the phones keep the real record).
import { getStore } from '@netlify/blobs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCore } = require('../lib/incident-core.js');

export default async () => {
    const s = getStore({ name: 'incidents', consistency: 'strong' });
    const store = {
        async get(key) { try { return await s.get(key, { type: 'json' }); } catch (e) { return null; } },
        async set(key, value) { await s.setJSON(key, value); },
        async delete(key) { await s.delete(key); },
        async list(prefix) { const r = await s.list({ prefix }); return (r.blobs || []).map(b => b.key).sort(); },
    };
    const result = await createCore({ store, log: (...a) => console.log('[incident-cleanup]', ...a) }).cleanup();
    console.log('[incident-cleanup]', JSON.stringify(result));
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '@hourly' };
