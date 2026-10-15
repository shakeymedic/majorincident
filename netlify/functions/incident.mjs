// HTTP entry point for the incident commander backend: /api/incident and /api/incident/*
// All logic lives in netlify/lib/incident-core.js so it can be tested without Netlify.
import { getStore } from '@netlify/blobs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCore } = require('../lib/incident-core.js');

function blobStore() {
    const s = getStore({ name: 'incidents', consistency: 'strong' });
    return {
        async get(key) { try { return await s.get(key, { type: 'json' }); } catch (e) { return null; } },
        async set(key, value) { await s.setJSON(key, value); },
        async delete(key) { await s.delete(key); },
        async list(prefix) { const r = await s.list({ prefix }); return (r.blobs || []).map(b => b.key).sort(); },
    };
}

let core = null;
function getCore() {
    if (!core) core = createCore({ store: blobStore(), log: (...a) => console.log('[incident]', ...a) });
    return core;
}

export default async (req, context) => {
    const url = new URL(req.url);
    const headers = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let bodyText = '';
    if (req.method === 'POST' || req.method === 'PUT') { try { bodyText = await req.text(); } catch (e) { bodyText = ''; } }
    const client = (context && context.ip) || headers['x-nf-client-connection-ip'] || 'unknown';
    const r = await getCore().handle(req.method, url.pathname, headers, bodyText, client);
    const h = Object.assign({ 'X-Content-Type-Options': 'nosniff' }, r.headers || {});
    return new Response(r.body === null || r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: h });
};

export const config = { path: ['/api/incident', '/api/incident/*'] };
