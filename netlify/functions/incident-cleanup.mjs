// Hourly sweep: delete incidents that have had no writes for 24 hours (the phones keep the real record).
import { createRequire } from 'node:module';
import { pickStore } from '../lib/pick-store.mjs';
const require = createRequire(import.meta.url);
const { createCore } = require('../lib/incident-core.js');

export default async () => {
    const { store, name } = pickStore();
    const result = await createCore({ store, log: (...a) => console.log('[incident-cleanup]', ...a) }).cleanup();
    console.log('[incident-cleanup]', name, JSON.stringify(result));
    return new Response(JSON.stringify(Object.assign({ store: name }, result)), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '@hourly', region: 'lhr' };
