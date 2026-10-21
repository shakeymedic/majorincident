// HTTP entry point for the incident commander backend: /api/incident and /api/incident/*
// All logic lives in netlify/lib/incident-core.js so it can be tested without Netlify.
import { createRequire } from 'node:module';
import { pickStore } from '../lib/pick-store.mjs';
const require = createRequire(import.meta.url);
const { createCore } = require('../lib/incident-core.js');
const firestore = require('../lib/firestore-store.js');

let core = null, storeName = '';
function getCore() {
    if (!core) { const p = pickStore(firestore); storeName = p.name; console.log('[incident] store', storeName); if (!process.env.RATE_LIMIT_SALT) console.warn('[incident] RATE_LIMIT_SALT is not set; rate-limit keys are unsalted'); core = createCore({ store: p.store, rateSalt: process.env.RATE_LIMIT_SALT || '', log: (...a) => console.log('[incident]', ...a) }); }
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
    const h = Object.assign({ 'X-Content-Type-Options': 'nosniff', 'X-Incident-Store': storeName }, r.headers || {});
    return new Response(r.body === null || r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: h });
};

// region: London, so requests are handled in the UK (Netlify Pro). The data itself is wherever pickStore() says.
export const config = { path: ['/api/incident', '/api/incident/*'], region: 'lhr' };
