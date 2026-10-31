/* Incident commander screen. Kept out of commander.html so the page's script policy needs no 'unsafe-inline':
   clicks and changes are wired below with data-act attributes instead of onclick="" handlers. */
const REFRESH_MS = 30 * 1000;
// A tab nobody is looking at checks less often; it refreshes at once when it is shown again.
const HIDDEN_REFRESH_MS = 60 * 1000;
const $ = (id) => document.getElementById(id);
const esc = MITTLib.escapeHTML;
let cfg = null;           // { code, pin }
let data = null;          // last payload
let etag = '';
let knownSeq = '';       // sequence number of the data on screen; sent back so an unchanged incident costs a 304
// v0.19.12: the server's change numbers for what is on screen ("r.d.p.<access>") and when the casualties were last
// read (server time). Sent back, so an unchanged incident costs a 304 and a changed one sends only what changed.
let syncVer = '', syncCursor = 0, serverOffset = 0;
let timer = null;
let lastOkAt = 0;
let map = null, cluster = null, ccsMarker = null, circles = null;
const markerByUid = new Map();   // uid -> { m: marker, sig, r }: markers are updated in place, so an open pop-up stays open
let firstFit = true;
let demo = null;          // { startedAt } while showing the made-up demo incident (no network at all)
let demoMarks = [];       // map markings placed during the demo (kept in the page only)
let demoPolicy = null;    // incident decisions made during the demo (kept in the page only)
let marksLayer = null, marking = false;
let teamsLayer = null;      // triager positions (only phones that opted in) and calls for help
let wallRequested = false;

function loadCfg() {
    try { const s = sessionStorage.getItem('mit_commander'); if (s) cfg = JSON.parse(s); } catch (e) {}
    const raw = (location.hash || '').replace('#', '').toUpperCase();
    if (raw.split('/')[0] === 'DEMO') { cfg = null; if (/\/WALL/.test(raw)) wallRequested = true; return 'demo'; }
    const h = raw.split('/')[0].replace(/[^A-Z0-9]/g, '');
    if (h && h.length === 6) $('in-code').value = h;
    if (h && h.length === 6 && cfg && cfg.code && cfg.code !== h) cfg = null; // a link to another incident wins over this tab's saved sign-in
    // Opened on the phone that is sharing (same site, same browser): sign in with that phone's own code and PIN.
    if (!cfg) {
        try {
            ['mit_commander', 'trn_mit_commander'].forEach(k => {
                if (cfg) return;
                const app = JSON.parse(localStorage.getItem(k) || 'null');
                // The phone that started the incident holds the commander PIN; a phone that joined only has the triagers' PIN (view only here).
                if (app && app.code && app.pin && (!h || h === app.code)) cfg = { code: app.code, pin: app.cmdPin || app.pin, key: app.accessKey || '', by: (localStorage.getItem(k === 'trn_mit_commander' ? 'trn_mit_triager' : 'mit_triager') || localStorage.getItem('mit_triager') || '').slice(0, 80), fromPhone: true };
            });
        } catch (e) {}
    }
    let wall = /\/WALL/.test(raw);
    try { if (sessionStorage.getItem('mit_commander_wall') === '1') wall = true; } catch (e) {}
    // Wall mode hides the sign-in card, so it is only switched on once signed in (start()/startDemo()).
    wallRequested = wall;
    if (cfg && cfg.code) { $('in-code').value = cfg.code; $('in-pin').value = cfg.pin || ''; }
}
function saveCfg() { try { sessionStorage.setItem('mit_commander', JSON.stringify(cfg)); } catch (e) {} }
// Headers for every request: the PIN, plus the incident key the server handed back after the first good PIN
// (it lets this screen through the incident-wide wrong-PIN lock-out that strangers' guesses can trigger).
function hdrs(json) { const h = { 'x-incident-pin': cfg.pin }; if (cfg.key) h['x-incident-key'] = cfg.key; if (json) h['Content-Type'] = 'application/json'; return h; }
// Every decision is recorded with who made it (v0.19.5 test: withdrawals and MITT prompts were saved with no name).
async function whoDecides() {
    if (demo) return 'Demo commander';
    if (cfg && cfg.by) return cfg.by;
    const v = await ask({ title: 'Your name and role', message: 'Every decision on this screen is recorded with the name of who made it. You are asked once.', input: 'e.g. Silver, Insp A Kaur', okLabel: 'Save' });
    const by = typeof v === 'string' ? v.trim().slice(0, 80) : '';
    if (!by) return '';
    cfg.by = by; saveCfg();
    return by;
}
function setStatus(cls, text) { const p = $('status-pill'); p.className = 'pill ' + cls; p.textContent = text; }
function signIn() {
    const code = $('in-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const pin = $('in-pin').value.replace(/\D/g, '').slice(0, 6);
    $('signin-error').classList.add('hidden');
    if (code.length !== 6 || pin.length !== 6) { $('signin-error').textContent = 'The code is 6 letters or digits and the PIN is 6 digits.'; $('signin-error').classList.remove('hidden'); return; }
    cfg = { code, pin, by: ($('in-by') ? $('in-by').value : '').trim().slice(0, 80) };
    saveCfg();
    start();
}
function signOut() {
    if (demo) { demo = null; firstFit = true; try { history.replaceState(null, '', location.pathname); } catch (e) {} $('training-banner').textContent = 'TRAINING INCIDENT — practice data, not real patients'; }
    cfg = null; data = null; etag = ''; knownSeq = ''; syncVer = ''; syncCursor = 0;
    try { sessionStorage.removeItem('mit_commander'); } catch (e) {}
    if (timer) clearTimeout(timer);
    $('dash').classList.add('hidden'); $('signin').classList.remove('hidden'); $('btn-signout').style.display = 'none'; $('btn-fs').style.display = 'none'; $('btn-start-page').style.display = 'none'; $('btn-sound').style.display = 'none'; $('btn-print').style.display = 'none'; $('btn-sound-unlock').style.display = 'none';
    ALERTS.seen = null; ALERTS.list = []; $('alerts').classList.add('hidden');
    $('training-banner').classList.add('hidden');
    lastOkAt = 0; setStatus('wait', 'Not connected'); renderHeader(); setUpdated('');
}
function setText(id, t) { $(id).textContent = t; }
let updBase = '';
function setUpdated(t) { updBase = t; tickClock(); }
function agoShort(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' s ago' : s < 3600 ? Math.floor(s / 60) + ' min ago' : Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min ago'; }
function elapsedText(ms) { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min'; }
function toggleFullscreen() {
    try {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
    } catch (e) {}
}
function renderHeader() {
    if (!data) { $('hdr-incident').innerHTML = ''; return; }
    const bits = [];
    if (data.name) bits.push(`<span class="inc-name">${esc(data.name)}</span>`);
    bits.push(`<span class="chip">Code <b>${esc(data.code || '')}</b></span>`);
    if (data.incidentCode) bits.push(`<span class="chip">Incident <b>${esc(data.incidentCode)}</b></span>`);
    if (data.createdAt) bits.push(`<span class="chip">Running <b id="hdr-elapsed">${elapsedText(Date.now() - data.createdAt)}</b></span>`);
    // First and in amber, so an observer cannot miss that nothing here can be changed (v0.19.4 retest).
    if (data.viewOnly) bits.unshift(data.access === 'triager' ? `<span class="chip chip-view" title="Opened with the triagers' PIN: you can watch but not change anything. Use the commander PIN to make decisions.">👁 View only (triagers' PIN)</span>` : `<span class="chip chip-view" title="Opened with the view-only PIN: you can watch but not change anything">👁 View only</span>`);
    $('hdr-incident').innerHTML = bits.join('');
}
function start() {
    if (wallRequested) { wallRequested = false; setWall(true); }
    $('signin').classList.add('hidden'); $('dash').classList.remove('hidden'); $('btn-signout').style.display = ''; $('btn-wall').style.display = ''; $('btn-fs').style.display = document.fullscreenEnabled ? '' : 'none';
    $('btn-sound').style.display = ''; $('btn-print').style.display = ''; renderSoundBtn();
    $('btn-signout').textContent = 'Sign out';
    checkSoundUnlocked();
    refreshNow();
}
// Wall display: for a big screen in the command post. Toggle with the button, the W key, or #CODE/wall in the link.
function setWall(on) {
    document.body.classList.toggle('wall', !!on);
    $('btn-wall').textContent = on ? 'Normal view' : 'Wall display';
    try { sessionStorage.setItem('mit_commander_wall', on ? '1' : ''); } catch (e) {}
    if (map) setTimeout(() => { map.invalidateSize(); fitMap(); }, 150);
}
function toggleWall() { setWall(!document.body.classList.contains('wall')); }
function tickClock() {
    $('clock').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('hdr-updated').textContent = updBase ? updBase + (lastOkAt ? ' · ' + agoShort(Date.now() - lastOkAt) : '') : '';
    const el = $('hdr-elapsed'); if (el && data && data.createdAt) el.textContent = elapsedText(Date.now() - data.createdAt);
}
setInterval(tickClock, 1000); tickClock();
// Demo: the made-up incident from MITTLib.buildDemoScenario, built in the page. Casualties arrive, deteriorate and
// are evacuated over the first few minutes. Nothing is fetched or sent.
function startDemo() {
    if (timer) clearTimeout(timer);
    cfg = null; etag = ''; knownSeq = ''; syncVer = ''; syncCursor = 0; firstFit = true;
    try { sessionStorage.removeItem('mit_commander'); } catch (e) {}
    demo = { startedAt: Date.now() };
    // The demo has a P1 Hold casualty, so the demo starts with P1 Hold allowed.
    demoPolicy = { p1Hold: { on: true, at: Date.now(), by: 'MERIT doctor (demo)' } };
    $('training-banner').textContent = 'DEMO — a made-up incident for showing the app. Not real patients; nothing is sent or received.';
    if (wallRequested) { wallRequested = false; setWall(true); }
    $('signin').classList.add('hidden'); $('dash').classList.remove('hidden'); $('btn-signout').style.display = ''; $('btn-wall').style.display = ''; $('btn-fs').style.display = document.fullscreenEnabled ? '' : 'none';
    $('btn-signout').style.display = 'none'; $('btn-start-page').style.display = '';
    $('btn-sound').style.display = ''; $('btn-print').style.display = ''; renderSoundBtn();
    checkSoundUnlocked();
    demoTick();
}
function demoTick() {
    if (!demo) return;
    if (timer) clearTimeout(timer);
    const now = Date.now();
    const d = MITTLib.buildDemoScenario({ now, elapsedMs: now - demo.startedAt });
    const order = { P1: 0, P1_HOLD: 1, P2: 2, P3: 3, NOT_BREATHING: 4, DEAD: 5 };
    const records = d.records.map(r => Object.assign(MITTLib.sanitisePatientRecord(r), { reportedBy: r.deviceId, reportedAt: r.updatedAt }))
        .sort((x, y) => ((x.category in order ? order[x.category] : 99) - (y.category in order ? order[y.category] : 99)) || (x.timestamp || 0) - (y.timestamp || 0));
    data = { marks: demoMarks, marksAt: 0, policy: demoPolicy || {}, policyAt: 0, code: d.incident.code, name: d.incident.name, incidentCode: d.incident.incidentCode, training: true, demo: true, createdAt: d.incident.createdAt, updatedAt: now, expiresAt: now + 24 * 3600 * 1000, ccs: d.incident.ccs, methane: Object.assign({}, d.incident.methane, { timestamp: d.incident.createdAt + 7 * 60 * 1000, by: 'MERIT doctor', device: 'DEMODR' }), devices: d.devices.map(x => Object.assign({}, x, { stale: false })), records, serverTime: now };
    lastOkAt = now;
    setStatus('live', 'Demo');
    const next = d.incident.nextEventInMs;
    setUpdated(`Updated ${time(now)}${next ? ' • more happens shortly' : ''}`);
    $('conn-warn').classList.add('hidden');
    render();
    setText('counts-note', 'On scene counts (big number) and totals including evacuated. Demo: casualties arrive, deteriorate and are evacuated over the first few minutes. Tap ↩ Start page to go back and pick another role.');
    timer = setTimeout(demoTick, next ? Math.min(10000, next + 200) : 30000);
}
async function refreshNow() {
    if (demo) { demoTick(); return; }
    if (!cfg) return;
    if (timer) clearTimeout(timer);
    $('btn-refresh').disabled = true;
    try {
        const headers = hdrs();
        headers['x-incident-sync'] = '2';
        if (data && data.sync === 2 && syncVer) { headers['x-incident-ver'] = syncVer; headers['x-incident-cursor'] = String(syncCursor); }
        else { if (etag) headers['If-None-Match'] = etag; if (knownSeq) headers['X-Incident-Seq'] = knownSeq; }
        const r = await getIncident(headers);
        if (r.status === 304) { lastOkAt = Date.now(); setStatus('live', 'Live'); setUpdated(`Checked ${time(Date.now())} • no change`); $('conn-warn').classList.add('hidden'); render({ sameData: true }); return; }
        if (r.status === 401 || r.status === 404 || r.status === 410 || r.status === 429) {
            let msg = 'Could not open this incident.', why = '';
            try { const j = await r.json(); msg = j.message || msg; why = j.error || ''; } catch (e) {}
            if (!data) { signOut(); $('signin').classList.remove('hidden'); $('signin-error').textContent = msg; $('signin-error').classList.remove('hidden'); return; }
            const gone = r.status === 404 || r.status === 410;
            // The server says whether it was ended or expired; an ended incident was labelled "expired" (v0.19.7 stress test).
            setStatus('bad', r.status === 410 ? (why === 'expired' ? 'Incident expired' : 'Incident ended') : r.status === 404 ? 'Incident ended' : 'Access refused');
            // An ended incident must not look live: the old figures are greyed and labelled with when they were last received.
            $('conn-warn').textContent = msg + (gone ? ` Everything below is the last copy this page received${lastOkAt ? ' at ' + time(lastOkAt) : ''}: it is NOT live.` : '');
            $('conn-warn').classList.remove('hidden');
            document.body.classList.toggle('incident-gone', gone);
            if (gone) setUpdated(`Incident ended • last copy ${lastOkAt ? time(lastOkAt) : 'unknown'}`);
            return;
        }
        if (!r.ok) throw new Error('Server error ' + r.status);
        const body = await r.json();
        if (body.sync === 2) {
            if (body.delta && data && data.sync === 2) data = mergeDelta(data, body);
            else {
                // A first load comes in parts (a big incident with long notes would not fit one reply).
                let recs = body.records || [], more = body.more;
                while (more) {
                    setUpdated(`Loading casualties… ${recs.length} so far`);
                    const pr = await getIncident(Object.assign(hdrs(), { 'x-incident-sync': '2', 'x-incident-page': more }));
                    if (!pr.ok) throw new Error('Server error ' + pr.status);
                    const pb = await pr.json();
                    recs = recs.concat(pb.records || []); more = pb.more;
                }
                body.records = recs;
                data = body;
            }
            sortRecords(data.records || []);
            syncVer = body.ver || ''; syncCursor = body.cursor || 0;
            serverOffset = (body.serverTime || Date.now()) - Date.now();
        } else {
            data = body;   // a server from before v0.19.12
            syncVer = '';
            etag = r.headers.get('ETag') || '';
            knownSeq = r.headers.get('X-Incident-Seq') || (data.seq !== undefined ? String(data.seq) : '');
        }
        if (data.accessKey && data.accessKey !== cfg.key) { cfg.key = data.accessKey; saveCfg(); }
        document.body.classList.remove('incident-gone');
        lastOkAt = Date.now();
        setStatus('live', 'Live');
        setUpdated(`Updated ${time(Date.now())}`);
        $('conn-warn').classList.add('hidden');
        render();
    } catch (e) {
        setStatus('bad', 'No connection');
        $('conn-warn').textContent = `SERVER UNREACHABLE (${e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'offline'}). ${lastOkAt ? 'Showing the data from ' + time(lastOkAt) + '; phones keep their records and send them when the link is back.' : 'Nothing received yet.'} Retrying every 30 seconds. Fallback: phones can use Hand over › Send patients to another device to show their records as QR codes for the control room's phone to scan.`;
        $('conn-warn').classList.remove('hidden');
    } finally {
        $('btn-refresh').disabled = false;
        if (cfg) timer = setTimeout(refreshNow, document.hidden ? HIDDEN_REFRESH_MS : REFRESH_MS);
    }
}
// One GET of the incident, given up after 20 s.
async function getIncident(headers) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    try { return await fetch(`/api/incident/${encodeURIComponent(cfg.code)}`, { headers, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }); }
    finally { if (to) clearTimeout(to); }
}
// Only what changed since the last read: changed casualties replace their old copies; phones, decisions and
// markings replace the old lists when they are sent; the incident's own details always come.
function mergeDelta(old, body) {
    const next = Object.assign({}, old, body);
    if (Array.isArray(body.records)) {
        const byId = new Map((old.records || []).map(r => [r.uid, r]));
        body.records.forEach(r => { if (r && r.uid) byId.set(r.uid, r); });
        next.records = Array.from(byId.values());
    } else next.records = old.records || [];
    return next;
}
const CAT_ORDER = { P1: 0, P1_HOLD: 1, P2: 2, P3: 3, NOT_BREATHING: 4, DEAD: 5 };
function sortRecords(list) { list.sort((x, y) => ((x.category in CAT_ORDER ? CAT_ORDER[x.category] : 99) - (y.category in CAT_ORDER ? CAT_ORDER[y.category] : 99)) || (x.timestamp || 0) - (y.timestamp || 0)); return list; }
function time(ts) { return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function hm(ts) { return ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''; }
function age(ts) { return ts ? MITTLib.formatLocationAge(ts, Date.now()) : '—'; }
function place(r) { return [r.sector, r.landmark, r.floor ? 'Floor ' + r.floor : '', r.area].filter(Boolean).join(', '); }
function loc(r) { return r.currentLocation || r.location || null; }
function cat(c) { const i = MITTLib.CATEGORY_INFO[c] || { short: c, colour: '#4C6272', text: '#fff' }; return `<span class="cat-chip" style="background:${i.colour};color:${i.text}">${esc(i.short)}</span>`; }
let stageFilter = 'scene';   // scene | field | ccs | evacuated | all
const TABLE_STEP = 200, ATT_MAX = 100;
let tableLimit = TABLE_STEP;
function setStageFilter(f) {
    stageFilter = f;
    tableLimit = TABLE_STEP;
    $('show-evac').checked = f === 'all' || f === 'evacuated';
    document.querySelectorAll('#stage-seg button').forEach(b => b.classList.toggle('on', b.getAttribute('data-stage') === f));
    render();
}
const stage = (r) => MITTLib.patientStage(r);
// TST = the sieve (first look, anyone); MITT = the sort (clinician). A patient who has only had the sieve still needs the sort.
function hadMitt(r) { return r.tool === 'MITT' || (r.triageHistory || []).some(t => t.tool === 'MITT'); }
function toolChip(r) { return hadMitt(r) ? '<span class="tool-chip mitt" title="Has had MITT (sort) triage">MITT</span>' : '<span class="tool-chip tst" title="TST sieve only: no MITT sort yet">TST only</span>'; }
const byUid = (uid) => ((data && data.records) || []).find(r => r.uid === uid) || null;
function stageTag(r) { const st = stage(r); const i = MITTLib.STAGE_INFO[st]; return `<span class="stage-tag ${st}">${esc(i.short)}</span>`; }
function visibleRecords() {
    const all = (data && data.records) || [];
    if (stageFilter === 'all') return all;
    if (stageFilter === 'scene') return all.filter(r => !r.evacuated);
    if (stageFilter === 'tst') return all.filter(r => !r.evacuated && !hadMitt(r));
    return all.filter(r => stage(r) === stageFilter);
}

// opts.sameData: the server said nothing changed, so the map is left alone (redrawing it closes any open popup).
// Everything else is redrawn because overdue times move on with the clock.
function render(opts) {
    if (!data) return;
    const sameData = !!(opts && opts.sameData);
    const now = Date.now();
    renderHeader();
    $('training-banner').classList.toggle('hidden', !data.training);
    const all = data.records || [];
    const onScene = all.filter(r => !r.evacuated);
    const order = ['P1', 'P1_HOLD', 'P2', 'P3', 'NOT_BREATHING', 'DEAD'];
    $('counts').innerHTML = order.map(c => { const i = MITTLib.CATEGORY_INFO[c]; const here = onScene.filter(r => r.category === c); const n = here.length, t = all.filter(r => r.category === c).length, cc = here.filter(r => stage(r) === 'ccs').length; return `<div class="count" style="background:${i.colour};color:${i.text}"><div class="n">${n}</div><div class="l">${esc(i.short)}</div><div class="s">${n - cc} field • ${cc} CCS</div><div class="t">${t} in total</div></div>`; }).join('') +
        `<div class="count" style="background:#4C6272"><div class="n">${all.filter(r => r.evacuated).length}</div><div class="l">Evacuated</div><div class="s">${Object.keys(MITTLib.stageCounts(all).hospitals).length} destination${Object.keys(MITTLib.stageCounts(all).hospitals).length === 1 ? '' : 's'}</div><div class="t">${all.length} casualties in total</div></div>`;
    const sc = MITTLib.stageCounts(all);
    const hosp = Object.keys(sc.hospitals).sort((a, b) => sc.hospitals[b] - sc.hospitals[a]);
    const fieldSectors = {};
    onScene.filter(r => stage(r) === 'field').forEach(r => { const k = r.sector || 'No sector'; fieldSectors[k] = (fieldSectors[k] || 0) + 1; });
    const fieldSub = Object.keys(fieldSectors).sort().map(k => `${esc(k)} <b>${fieldSectors[k]}</b>`).join(' • ') || 'nobody left in the field';
    const ccsCats = order.filter(c => onScene.some(r => stage(r) === 'ccs' && r.category === c)).map(c => `${esc(MITTLib.CATEGORY_INFO[c].short)} <b>${onScene.filter(r => stage(r) === 'ccs' && r.category === c).length}</b>`).join(' • ') || 'none yet';
    const hospSub = hosp.map(h => `${esc(h)} <b>${sc.hospitals[h]}</b>`).join(' • ') || 'none yet';
    $('stages').innerHTML = `<div class="stage"><div class="n">${sc.field}</div><div><div class="lbl">In the field</div><div class="sub">${fieldSub}</div></div></div>` +
        `<div class="stage ccs"><div class="n">${sc.ccs}</div><div><div class="lbl">At the casualty clearing station</div><div class="sub">${ccsCats}</div></div></div>` +
        `<div class="stage evac"><div class="n">${sc.evacuated}</div><div><div class="lbl">Evacuated</div><div class="sub">${hospSub}</div></div></div>` +
        (() => { const t = onScene.filter(r => !hadMitt(r)); const sub = order.filter(c => t.some(r => r.category === c)).map(c => `${esc(MITTLib.CATEGORY_INFO[c].short)} <b>${t.filter(r => r.category === c).length}</b>`).join(' • '); return `<div class="stage tst"><div class="n">${t.length}</div><div><div class="lbl">TST only</div><div class="sub">${t.length ? 'no MITT sort yet: ' + sub : 'everyone on scene has had MITT'}</div></div></div>`; })();
    setText('counts-note', `Big number = on scene now (field + casualty clearing station); "in total" includes evacuated. CCS on the small labels = casualty clearing station (set on the phone, or inferred from the sector name). Server time ${hm(data.serverTime)}; data deleted ${hm(data.expiresAt)} tomorrow unless updated.`);
    // phones (from v0.19.12 the phone list is only sent when it changes, so "not heard from" is worked out here)
    const devs = data.devices || [];
    if (data.sync === 2) devs.forEach(d => { d.stale = (now + serverOffset) - (d.lastSeen || 0) > 5 * 60 * 1000; });
    renderFull();
    $('phones').innerHTML = devs.map(d => `<div class="phone${d.stale ? ' stale' : ''}${sos(d) ? ' sos' : ''}"><span class="dot"></span><b>${esc(d.triager || 'Unnamed')} <span class="muted">${esc(d.deviceId)}</span>${batteryTag(d)}${sos(d) ? ' <span class="cat-chip sos-chip" title="Called for help">🆘 HELP</span>' : ''}${d.oldApp ? ' <span class="cat-chip" style="background:#c9a700;color:#000;font-size:0.72rem;padding:1px 6px" title="This phone is on an old version of the app">Old app version</span>' : ''}</b><span class="ph-meta">${d.oldApp ? '<b>Old app version: ask them to close and reopen the app to update, then join again.</b> ' : ''}${d.role === 'creator' ? 'Started sharing • ' : ''}${d.commander ? 'Incident commander • ' : d.userRole === 'HCP' ? 'Clinician • ' : d.userRole === 'NON_HCP' ? 'Non-clinical • ' : ''}${d.sector ? esc(d.sector) + ' • ' : ''}${d.records || 0} record${d.records === 1 ? '' : 's'} • last report ${age(d.lastSeen)}${d.stale ? ' • <b>not heard from</b>' : ''}${d.position ? ` • 📍 ${posStale(d.position, now) ? '<b>' : ''}position ${age(d.position.timestamp)}${posStale(d.position, now) ? '</b>' : ''}` : ''}</span></div>`).join('') || '<p class="muted">No phones yet.</p>';
    setText('phones-note', `${devs.length} phone${devs.length === 1 ? '' : 's'}; red = no report for 5 minutes${devs.some(d => d.position) ? ' • 📍 = shares its position (opt-in on the phone)' : ''}`);
    renderSos(devs);
    // sectors
    const sectors = {};
    onScene.filter(r => stage(r) === 'field').forEach(r => { const s = r.sector || 'No sector'; sectors[s] = sectors[s] || { P1: 0, P1_HOLD: 0, P2: 0, P3: 0, NOT_BREATHING: 0, DEAD: 0, n: 0 }; sectors[s][r.category] = (sectors[s][r.category] || 0) + 1; sectors[s].n++; });
    const ccsRecs = onScene.filter(r => stage(r) === 'ccs');
    const sectorRows = Object.keys(sectors).sort().map(s => `<div class="sector-row"><span class="sname">${esc(s)}</span>${order.filter(c => sectors[s][c]).map(c => `${cat(c)} <b>${sectors[s][c]}</b>`).join(' ')}<span class="muted">${sectors[s].n}</span></div>`).join('') || '<p class="muted">Nobody left in the field.</p>';
    const ccsRow = ccsRecs.length ? `<div class="sector-row"><span class="sname">Casualty clearing station</span>${order.filter(c => ccsRecs.some(r => r.category === c)).map(c => `${cat(c)} <b>${ccsRecs.filter(r => r.category === c).length}</b>`).join(' ')}<span class="muted">${ccsRecs.length}</span></div>` : '<p class="muted">None at the CCS yet.</p>';
    const hospRows = hosp.map(h => { const rs = all.filter(r => r.evacuated && (String(r.evacDest || '').trim() || 'Destination not recorded') === h); return `<div class="hosp-row"><span class="hname">${esc(h)}</span>${order.filter(c => rs.some(r => r.category === c)).map(c => `${cat(c)} <b>${rs.filter(r => r.category === c).length}</b>`).join(' ')}<span class="hn">${rs.length}</span></div>`; }).join('') || '<p class="muted">Nobody evacuated yet.</p>';
    $('sectors').innerHTML = `<div class="where-h">In the field, by sector (${sc.field})</div>${sectorRows}<div class="where-h">At the casualty clearing station (${sc.ccs})</div>${ccsRow}<div class="where-h">Evacuated, by hospital (${sc.evacuated})</div>${hospRows}`;
    setText('where-note', `${sc.field} field • ${sc.ccs} CCS • ${sc.evacuated} evacuated`);
    // attention
    const att = [];
    onScene.forEach(r => {
        const rs = MITTLib.reassessmentStatus(r, now, MITTLib.REASSESS_INTERVALS);
        const overdue = rs.state === 'overdue' ? `Reassessment overdue by ${Math.round(rs.overdueMs / 60000)} min` : '';
        // A Not Breathing casualty is listed once, with its overdue time on the same line (v0.19.12: it was listed twice).
        if (r.category === 'NOT_BREATHING') att.push({ k: 0, r, t: 'Breathing not detected — needs a clinician (MITT)' + (overdue ? ' • ' + overdue.toLowerCase() : '') });
        else if (overdue) att.push({ k: 0, r, t: overdue });
        if (r.interventions && r.interventions.Tourniquet) att.push({ k: 1, r, t: `Tourniquet on since ${esc(r.interventions.Tourniquet.time || '?')}` });
        if (r.highRisk) att.push({ k: 2, r, t: 'Flagged high risk of deterioration' });
    });
    att.sort((a, b) => a.k - b.k);
    // At 3,000 casualties this list could hold thousands of rows; the first ATT_MAX are drawn (most urgent first).
    const attShown = att.slice(0, ATT_MAX);
    $('attention').innerHTML = att.length ? `<div class="att">${attShown.map(a => `<div class="att-row k${a.k}" data-act="openPatient" data-uid="${esc(a.r.uid)}" role="button" tabindex="0">${cat(a.r.category)}<span class="id">${esc(shortId(a.r.id))} ${toolChip(a.r)}</span><span class="why"><b>${a.t}</b><span>${stageTag(a.r)} ${esc(place(a.r) || 'no place recorded')}</span></span><span class="age">${age(a.r.updatedAt || a.r.reportedAt)}</span></div>`).join('')}${att.length > attShown.length ? `<p class="muted">…and ${att.length - attShown.length} more. Use the casualty list to see them all.</p>` : ''}</div>` : '<div class="all-clear">Nothing outstanding</div>';
    setText('attention-note', att.length ? `${att.length} item${att.length === 1 ? '' : 's'} • overdue first${att.length > attShown.length ? ` • first ${attShown.length} shown` : ''}` : 'overdue reassessments, tourniquets, high risk');
    // table
    const vis = visibleRecords();
    // Only the first rows are drawn (3,000 rows made the page freeze on each refresh); more on request.
    const shownRows = vis.slice(0, tableLimit);
    const rowsHtml = shownRows.map(r => {
        const rs = MITTLib.reassessmentStatus(r, now, MITTLib.REASSESS_INTERVALS);
        const l = loc(r);
        const grid = l && l.lat ? MITTLib.toOsGridRef(l.lat, l.lng) : null;
        const ints = Object.keys(r.interventions || {}).map(k => `${esc(k)} ${esc((r.interventions[k] && r.interventions[k].time) || '')}`.trim()).join(', ');
        const re = rs.state === 'na' ? '—' : rs.state === 'overdue' ? `<b style="color:#DA291C">Overdue ${Math.round(rs.overdueMs / 60000)} min</b>` : rs.state === 'due-soon' ? 'Due now' : `Due ${hm(rs.dueAt)}`;
        const fresh = !r.evacuated && (now - (r.updatedAt || r.reportedAt || 0)) < 90000;
        return `<tr class="pt ${r.evacuated ? 'evac' : ''}${rs.state === 'overdue' && !r.evacuated ? ' overdue' : ''}${fresh ? ' fresh' : ''}" data-act="openPatient" data-uid="${esc(r.uid)}" tabindex="0"><td><span class="id">${esc(r.id)}</span>${r.cardNo ? `<div><b>Card ${esc(r.cardNo)}</b></div>` : ''}<div class="muted">${hm(r.timestamp)}${r.highRisk ? ' • <span class="flag">HIGH RISK</span>' : ''}${r.evacuated ? ' • evacuated' + (r.evacDest ? ' to ' + esc(r.evacDest) : '') : ''}</div></td>` +
            `<td>${cat(r.category)}<div style="margin-top:4px">${toolChip(r)}</div></td><td>${stageTag(r)}${r.evacuated ? ` <b>${esc(r.evacDest || 'destination not recorded')}</b>${r.evacVehicle ? ' <span class="muted">' + esc(r.evacVehicle) + '</span>' : ''}` : r.atCcs && r.ccsAt ? ` <span class="muted">since ${hm(r.ccsAt)}</span>` : ''}<div>${esc(place(r) || '—')}</div>${grid ? `<div class="muted">${esc(grid)}${l.acc ? ' ±' + Math.round(l.acc) + ' m' : ''}</div>` : '<div class="muted">no position</div>'}</td>` +
            `<td>${ints || '<span class="muted">none</span>'}</td><td>${re}</td><td>${esc(r.triager || '')}<div class="muted">${esc(r.reportedBy || '')}${r.firstReportedBy && r.reportedBy && r.firstReportedBy !== r.reportedBy ? ' (first sent by ' + esc(r.firstReportedBy) + ')' : ''} • ${age(r.updatedAt || r.reportedAt)}</div></td></tr>`;
    }).join('') + (vis.length > shownRows.length ? `<tr class="more-rows"><td colspan="6"><button type="button" class="btn small sec" data-act="moreRows">Show ${Math.min(TABLE_STEP, vis.length - shownRows.length)} more</button> <button type="button" class="btn small sec" data-act="allRows">Show all ${vis.length}</button> <span class="muted">${vis.length - shownRows.length} not shown (slow on big incidents)</span></td></tr>` : '');
    const rowsEl = $('rows');
    if (rowsEl._html !== rowsHtml) { rowsEl._html = rowsHtml; rowsEl.innerHTML = rowsHtml; }
    setText('list-note', `${vis.length} in this view${vis.length > shownRows.length ? `, first ${shownRows.length} shown` : ''}, priority first • tap a row for full details • highlighted = updated in the last 90 s`);
    if (openUid) renderPatient(byUid(openUid));
    renderLegend();
    if (!sameData || !map) renderMap(vis);
    else renderTeams(devs, now);   // nothing changed: only the triagers' "x min ago" labels move on
    detectAlerts(all, devs, now);
    renderMethane();
    renderHospitals(all);
    renderTimeline(all);
    renderDebrief(all);
    renderMarkTools();
    renderDecisions();
}

// ---------- Debrief timings (same figures as the phones, for every linked phone) ----------
function debriefRowsHtml(t) {
    return t.rows.map(r => `<tr><td>${esc(r.label)}</td><td class="t">${r.at ? `${hm(r.at)} <span class="muted">+${r.mins} min</span>` : '<span class="muted">not yet</span>'}</td><td class="muted">${esc(r.note || '')}</td></tr>`).join('') +
        (t.p1SceneMedianMins !== null ? `<tr><td>P1 time on scene (median of ${t.p1SceneCount})</td><td class="t">${t.p1SceneMedianMins} min</td><td class="muted">first record to leaving</td></tr>` : '');
}
function renderDebrief(all) {
    const t = MITTLib.debriefTimings(all, { startedAt: data.createdAt });
    $('debrief').innerHTML = t.count ? `<table class="debrief"><tbody>${debriefRowsHtml(t)}</tbody></table>` : '<p class="muted">Nothing recorded yet.</p>';
    setText('debrief-note', t.count ? `minutes from ${hm(t.start)} (incident started or first record)` : '');
}

// ---------- Shared map markings: placed here, sent to every linked phone with its next report ----------
function canMark() { return !!data && (demo || (cfg && !data.viewOnly)); }
function markTypeChanged() {
    const ty = MITTLib.MAP_MARK_TYPES[$('mark-type').value];
    $('mark-radius').style.display = ty.circle ? '' : 'none';
    if (ty.circle) $('mark-radius').value = ty.radius;
}
function renderMarkTools() {
    $('mark-tools').style.display = canMark() ? '' : 'none';
    const marks = MITTLib.normaliseMapMarks(data.marks || []);
    $('mark-list').innerHTML = marks.map(m => { const ty = MITTLib.MAP_MARK_TYPES[m.type]; return `<span class="mark-chip" style="background:${ty.colour}">${esc(ty.short)}${m.label ? ': ' + esc(m.label) : ''}${m.radius ? ` <small>${m.radius} m</small>` : ''}${canMark() ? `<button type="button" title="Remove" aria-label="Remove ${esc(ty.label)}" data-act="removeMark" data-id="${esc(m.id)}">✕</button>` : ''}</span>`; }).join('');
}
function startMarking() {
    if (!canMark() || !ensureMap()) return;
    marking = !marking;
    document.body.classList.toggle('marking', marking);
    $('btn-mark').textContent = marking ? 'Cancel' : 'Place on map';
    setText('mark-hint', marking ? 'Click the map where it goes.' : '');
}
// Only the change is sent ({ add } or { remove }), so two people marking the map at the same moment both keep
// their changes (v0.19.9 stress test: the whole list was sent, and one person's edits were lost).
async function saveMarks(change) {
    const marks = MITTLib.normaliseMapMarks(change.add ? (data.marks || []).concat(change.add) : (data.marks || []).filter(m => (change.remove || []).indexOf(m.id) === -1));
    if (demo) { demoMarks = marks; data.marks = marks; render(); return true; }
    const by = await whoDecides();
    if (!by) return false;
    try {
        const r = await fetch(`/api/incident/${encodeURIComponent(cfg.code)}/marks`, { method: 'POST', headers: hdrs(true), body: JSON.stringify(Object.assign({ by }, change.add ? { add: change.add } : { remove: change.remove })), cache: 'no-store' });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) { tell(b.message || `Could not save the map markings (server replied ${r.status}).`); return false; }
        data.marks = b.marks || marks; data.marksAt = b.marksAt || Date.now();
        render();
        setText('mark-hint', 'Saved. Phones get it with their next report (within a minute).');
        return true;
    } catch (e) { tell('Could not reach the server, so the map markings were not saved. Try again.'); return false; }
}
function onMapClickMark(ev) {
    if (!marking) return;
    startMarking();
    const type = $('mark-type').value;
    const mark = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, lat: ev.latlng.lat, lng: ev.latlng.lng, label: $('mark-label').value.trim(), radius: Number($('mark-radius').value) || undefined, at: Date.now() };
    $('mark-label').value = '';
    saveMarks({ add: [mark] });
}
function removeMark(id) { saveMarks({ remove: [id] }); }
let marksDrawn = null;
function renderMarks() {
    if (!map) return;
    if (!marksLayer) marksLayer = L.layerGroup().addTo(map);
    // Redrawn only when the markings change, so an open pop-up on one stays open.
    const sig = JSON.stringify(data.marks || []);
    if (sig === marksDrawn) return;
    marksDrawn = sig;
    marksLayer.clearLayers();
    MITTLib.normaliseMapMarks(data.marks || []).forEach(m => {
        const ty = MITTLib.MAP_MARK_TYPES[m.type];
        const pop = `<b>${esc(ty.label)}</b>${m.label ? '<br>' + esc(m.label) : ''}${m.radius ? `<br>Radius about ${m.radius} m` : ''}`;
        if (ty.circle) marksLayer.addLayer(L.circle([m.lat, m.lng], { radius: m.radius, color: ty.colour, weight: 3, dashArray: '8 6', fill: false, interactive: false }));
        // A cordon's label sits on its northern edge, so an inner and outer cordon round the same point both read.
        marksLayer.addLayer(L.marker([ty.circle ? m.lat + m.radius / 111320 : m.lat, m.lng], { icon: L.divIcon({ html: `<span class="mk-mark" style="background:${ty.colour}">${esc(m.label ? ty.short + ': ' + m.label : ty.short)}</span>`, className: 'mk-wrap', iconSize: [0, 0] }), zIndexOffset: 900 }).bindPopup(pop));
    });
}

// ---------- Clinical decisions for the incident (P1 Hold allowed; MITT now in use) ----------
// P1 Hold is hidden on every phone until the commander allows it here, with the name of who decided (G2).
// The MITT prompt tells the chosen groups of phones that MITT is in use; clinicians can also switch on their own (G6).
const DEFAULT_PROMPT_SECTORS = ['Casualty clearing station'];
function policyNow() { return MITTLib.normalisePolicy((data && data.policy) || {}); }
function sectorGroups() {
    const seen = {};
    DEFAULT_PROMPT_SECTORS.concat((data.devices || []).map(d => d.sector), (data.records || []).filter(r => !r.evacuated).map(r => r.sector))
        .forEach(x => { const t = String(x || '').trim(); if (t && !seen[t.toLowerCase()]) seen[t.toLowerCase()] = t; });
    return Object.keys(seen).sort().map(k => seen[k]);
}
// The commander's own phone is not counted: the commander is the one sending the prompt.
function promptTargets(groups) { return (data.devices || []).filter(d => !d.commander && MITTLib.policyPromptApplies(groups, { role: d.userRole, sector: d.sector })); }
function phonesIn(group) { return promptTargets([group]).length; }
function renderDecisions() {
    const box = $('decisions');
    if (!box || !data) return;
    const p = policyNow();
    const can = canMark();
    const hold = p.p1Hold && p.p1Hold.on ? p.p1Hold : null;
    const holdHtml = `<div class="dec"><h3>P1 Hold</h3><div class="state">${hold ? `ALLOWED since ${hm(hold.at)} • decision by ${esc(hold.by || 'not recorded')}` : 'Not in use (default)'}${p.p1Hold && !hold && p.p1Hold.at ? ` <span class="muted">withdrawn ${hm(p.p1Hold.at)}${p.p1Hold.by ? ' by ' + esc(p.p1Hold.by) : ''}</span>` : ''}</div>` +
        `<p class="muted" style="margin:4px 0">Not nationally signed off. While off, clinicians' phones do not offer it. Allow it only on a senior clinical decision, and record who made it.</p>` +
        (can ? (hold ? `<button type="button" class="btn small sec" data-act="setP1Hold" data-on="0">Withdraw P1 Hold</button>` : `<div class="row"><input type="text" id="p1hold-by" maxlength="80" placeholder="Decision by (name and role)" aria-label="P1 Hold decision by"><button type="button" class="btn small" data-act="setP1Hold" data-on="1">Allow P1 Hold</button></div>`) : '') + `</div>`;
    const m = p.mitt;
    const groups = sectorGroups();
    const opt = (g, label) => `<label><input type="checkbox" class="mitt-grp" value="${esc(g)}"> ${esc(label)} <span class="muted">(${phonesIn(g)} phone${phonesIn(g) === 1 ? '' : 's'})</span></label>`;
    const mittHtml = `<div class="dec"><h3>MITT now in use</h3><div class="state">${m ? `Prompt sent ${hm(m.at)} to ${esc(m.groups.map(MITTLib.policyGroupLabel).join(', '))}${m.by ? ' by ' + esc(m.by) : ''}` : 'No prompt sent. Phones use TST unless a clinician switches.'}</div>` +
        `<p class="muted" style="margin:4px 0">Sends a prompt to the phones you choose. Clinicians can switch their main button to MITT; non-clinical phones are told to carry on with TST. Anyone can also switch on their own phone without a prompt.</p>` +
        (can ? `<div class="groups">${opt('hcp', 'All clinicians')}${groups.map(g => opt('sector:' + g, g)).join('')}${opt('all', 'Every phone')}</div><button type="button" class="btn small" data-act="sendMittPrompt">Send MITT prompt</button> <span class="muted" id="mitt-hint"></span>` : '') + `</div>`;
    // Redrawn on every refresh, so keep what the commander has ticked or typed but not yet sent.
    const ticked = Array.from(box.querySelectorAll('.mitt-grp:checked')).map(x => x.value);
    const byEl = $('p1hold-by'), typed = byEl ? byEl.value : '', hadFocus = byEl && document.activeElement === byEl;
    // Who decided what, newest first (kept on the server with every decision).
    const DEC = { 'p1hold-on': 'P1 Hold allowed', 'p1hold-off': 'P1 Hold withdrawn', mitt: 'MITT prompt sent', marks: 'Map markings changed', 'duress-cleared': 'Call for help cleared' };
    const log = (data.decisions || []).slice(-8).reverse();
    const logHtml = log.length ? `<div class="dec"><h3>Decision log</h3><ul class="dec-log">${log.map(d => `<li>${hm(d.at)} ${esc(DEC[d.what] || d.what)}${d.what === 'duress-cleared' && d.triager ? ' (' + esc(d.triager) + ')' : ''} — ${esc(d.by || 'not recorded')}</li>`).join('')}</ul></div>` : '';
    const html = holdHtml + mittHtml + logHtml;
    if (box._html === html) return;
    box._html = html;
    box.innerHTML = html;
    setText('decisions-note', 'phones get changes with their next report (within a minute)');
    box.querySelectorAll('.mitt-grp').forEach(x => { if (ticked.indexOf(x.value) > -1) x.checked = true; });
    if ($('p1hold-by')) { $('p1hold-by').value = typed; if (hadFocus) $('p1hold-by').focus(); }
}
async function savePolicy(change) {
    if (demo) {
        const t = Date.now();
        const p = policyNow();
        if (change.p1Hold) p.p1Hold = { on: !!change.p1Hold.on, at: t, by: change.p1Hold.by || '' };
        if (change.mitt) p.mitt = { id: 'demo' + t.toString(36), at: t, by: change.mitt.by || '', groups: MITTLib.normalisePolicyGroups(change.mitt.groups) };
        demoPolicy = MITTLib.normalisePolicy(p); data.policy = demoPolicy; render(); return true;
    }
    try {
        const r = await fetch(`/api/incident/${encodeURIComponent(cfg.code)}/policy`, { method: 'POST', headers: hdrs(true), body: JSON.stringify(change), cache: 'no-store' });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) { tell(b.message || `Could not save the decision (server replied ${r.status}).`); return false; }
        data.policy = b.policy || {}; data.policyAt = b.policyAt || Date.now();
        knownSeq = ''; etag = '';
        render();
        return true;
    } catch (e) { tell('Could not reach the server, so the decision was not saved. Try again.'); return false; }
}
async function setP1Hold(on) {
    if (!canMark()) return;
    if (!on) {
        if (!await ask({ title: 'Withdraw P1 Hold?', message: 'Clinicians\' phones stop offering it. Casualties already in P1 Hold keep it until a clinician changes them.', okLabel: 'Withdraw P1 Hold', danger: true })) return;
        const who = await whoDecides();
        if (who) savePolicy({ p1Hold: { on: false, by: who } });
        return;
    }
    const by = (($('p1hold-by') || {}).value || '').trim();
    if (!by) { await tell('Type who made the P1 Hold decision (name and role) first.', 'Name needed'); if ($('p1hold-by')) $('p1hold-by').focus(); return; }
    if (await ask({ title: 'Allow P1 Hold for this incident?', message: `Decision by: ${by}\n\nClinicians' phones will offer P1 Hold from their next report.`, okLabel: 'Allow P1 Hold' })) savePolicy({ p1Hold: { on: true, by } });
}
async function sendMittPrompt() {
    if (!canMark()) return;
    const groups = Array.from(document.querySelectorAll('.mitt-grp:checked')).map(x => x.value);
    if (!groups.length) { setText('mitt-hint', 'Tick who the prompt goes to first.'); return; }
    const n = promptTargets(groups).length;
    if (!await ask({ title: 'Send the MITT prompt?', message: `Tell ${groups.map(MITTLib.policyGroupLabel).join(', ')} that MITT is now in use?\n\n${n} phone${n === 1 ? '' : 's'} reporting now match. Phones that join later or change sector see it too if they match.`, okLabel: 'Send prompt' })) return;
    const who = await whoDecides();
    if (!who) return;
    savePolicy({ mitt: { groups, by: who } }).then(ok => { if (ok) setText('mitt-hint', 'Sent. Phones see it with their next report.'); });
}

// ---------- Alerts: things the control room must not miss, with a sound ----------
// Raised when something changes between two refreshes: a new P1 / P1 Hold / not-breathing casualty, a casualty
// whose category got worse, a tourniquet that has been on for an hour, a phone that has gone quiet. The first
// load raises nothing (everything is "new" then). Sound is a short WebAudio tone; no media file needed.
const TOURNIQUET_WARN_MS = 60 * 60 * 1000;
const ALERTS = { seen: null, list: [], sound: (() => { try { return localStorage.getItem('mit_cmd_sound') !== '0'; } catch (e) { return true; } })(), ctx: null, id: 0 };
function renderSoundBtn() { $('btn-sound').textContent = ALERTS.sound ? '🔔 Sound on' : '🔕 Sound off'; $('btn-sound').setAttribute('aria-pressed', ALERTS.sound ? 'true' : 'false'); }
function toggleSound() { ALERTS.sound = !ALERTS.sound; try { localStorage.setItem('mit_cmd_sound', ALERTS.sound ? '1' : '0'); } catch (e) {} renderSoundBtn(); if (ALERTS.sound) beep(1); checkSoundUnlocked(); }
// Browsers keep a page silent until someone taps it. A screen that signed in by itself (a wall display, the
// commander's own phone, a reload) would miss every alert sound, so show a "tap to enable sound" button until then.
function checkSoundUnlocked() {
    const b = $('btn-sound-unlock');
    let need = false;
    if (ALERTS.sound && !$('dash').classList.contains('hidden')) {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) { if (!ALERTS.ctx) ALERTS.ctx = new AC(); need = ALERTS.ctx.state === 'suspended'; }
        } catch (e) {}
    }
    b.style.display = need ? '' : 'none';
}
function unlockSound() {
    if (!ALERTS.ctx || ALERTS.ctx.state !== 'suspended') { checkSoundUnlocked(); return; }
    ALERTS.ctx.resume().then(() => { checkSoundUnlocked(); }).catch(() => {});
}
function beep(n) {
    if (!ALERTS.sound) return;
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!ALERTS.ctx) ALERTS.ctx = new AC();
        const ctx = ALERTS.ctx;
        if (ctx.state === 'suspended') ctx.resume();
        for (let i = 0; i < (n || 2); i++) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'sine'; o.frequency.value = i % 2 ? 1175 : 880;
            g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.22);
            g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + i * 0.22 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.22 + 0.2);
            o.connect(g); g.connect(ctx.destination);
            o.start(ctx.currentTime + i * 0.22); o.stop(ctx.currentTime + i * 0.22 + 0.21);
        }
    } catch (e) {}
}
function tourniquetSince(r) {
    const t = r.interventions && r.interventions.Tourniquet;
    if (!t) return null;
    if (t.ts) return Number(t.ts);
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t.time || ''));
    if (!m) return null;
    const d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() > Date.now() + 60000) d.setDate(d.getDate() - 1);   // "23:50" seen at 00:10 was yesterday
    return d.getTime();
}
function detectAlerts(records, devices, now) {
    const seen = ALERTS.seen;
    const next = { r: {}, d: {} };
    const fresh = [];
    records.forEach(r => {
        const prev = seen && seen.r[r.uid];
        const tq = tourniquetSince(r);
        const cur = { category: r.category, tq: !!(tq && now - tq >= TOURNIQUET_WARN_MS && !r.evacuated) };
        next.r[r.uid] = cur;
        if (!seen) return;
        if (!prev) {
            if (!r.evacuated && (r.category === 'P1' || r.category === 'P1_HOLD' || r.category === 'NOT_BREATHING')) fresh.push({ red: true, uid: r.uid, msg: `New ${MITTLib.categoryShort(r.category)}: ${esc(shortId(r.id))}`, sub: `${esc(place(r) || 'no place recorded')}${r.triager ? ' • ' + esc(r.triager) : ''}` });
            return;
        }
        if (prev.category !== r.category && MITTLib.categoryWorsened(prev.category, r.category) && !r.evacuated) fresh.push({ red: true, uid: r.uid, msg: `${esc(shortId(r.id))} got worse: ${MITTLib.categoryShort(prev.category)} → ${MITTLib.categoryShort(r.category)}`, sub: esc(place(r) || '') });
        if (cur.tq && !prev.tq) fresh.push({ red: false, uid: r.uid, msg: `${esc(shortId(r.id))}: tourniquet on for over an hour`, sub: `since ${esc((r.interventions.Tourniquet || {}).time || '?')} • ${esc(place(r) || '')}` });
    });
    (devices || []).forEach(d => {
        const low = typeof d.battery === 'number' && !d.charging && d.battery <= 10;
        const help = sos(d) ? Number(d.duress.at) : 0;
        next.d[d.deviceId] = { stale: !!d.stale, low, help };
        const prev = seen && seen.d[d.deviceId];
        if (prev && d.stale && !prev.stale) fresh.push({ red: false, msg: `Phone ${esc(d.triager || d.deviceId)} not heard from for 5 minutes`, sub: `last report ${esc(age(d.lastSeen))}` });
        if (prev && low && !prev.low) fresh.push({ red: false, msg: `Phone ${esc(d.triager || d.deviceId)}: battery ${d.battery}%`, sub: 'ask them to plug in or hand their patients to a charged phone' });
        // A call for help sounds even on the first load (the screen may have been opened because of it); the same call is not repeated.
        if (help && !(prev && prev.help === help)) fresh.push({ red: true, sos: true, msg: `🆘 ${esc(d.triager || d.deviceId)} needs help`, sub: `${esc(posText(d.duress.position || d.position))} • called at ${hm(help)} • the red banner above stays until it is cleared` });
    });
    ALERTS.seen = next;
    if (!fresh.length) return;
    fresh.forEach(a => { a.id = ++ALERTS.id; a.at = now; ALERTS.list.unshift(a); });
    ALERTS.list = ALERTS.list.slice(0, 20);
    renderAlerts(fresh.map(a => a.id));
    beep(fresh.some(a => a.sos) ? 6 : fresh.some(a => a.red) ? 3 : 2);
}
// ---------- Triager positions (opt-in on each phone) and calls for help ----------
const POS_STALE_MS = 5 * 60 * 1000;
function sos(d) { return !!(d && d.duress && d.duress.at && !d.duress.clearedAt); }
function posStale(p, now) { return !p || !p.timestamp || (now || Date.now()) - Number(p.timestamp) > POS_STALE_MS; }
function posText(p) {
    if (!p || !p.lat) return 'no position shared';
    const grid = MITTLib.toOsGridRef(Number(p.lat), Number(p.lng));
    return `${grid ? grid + ' • ' : ''}${MITTLib.formatCoords(Number(p.lat), Number(p.lng))}${p.acc ? ' ±' + Math.round(p.acc) + ' m' : ''} • ${age(p.timestamp)}`;
}
// ---------- Incident full (v0.19.12) ----------
// The server holds at most maxRecords casualties per incident. Past that, phones' new casualties are refused: the
// phones keep them as not sent and keep trying, and the server lists them here so the commander knows they exist
// (3,000-casualty test: the 3,001st was lost with no warning anywhere).
let fullSeen = -1;
function renderFull() {
    const box = $('full-warn');
    if (!box) return;
    const f = data && data.full, max = (data && data.maxRecords) || 0, count = data && typeof data.recordCount === 'number' ? data.recordCount : ((data && data.records) || []).length;
    const refused = f && f.count ? f.count : 0;
    if (!refused && !(max && count >= max * 0.9)) { box.classList.add('hidden'); box.innerHTML = ''; fullSeen = 0; return; }
    const n = (x) => Number(x).toLocaleString('en-GB');
    if (refused) {
        const list = (f.list || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
        const shown = list.slice(0, 12);
        box.className = 'danger full-warn';
        box.innerHTML = `<b>⚠ INCIDENT FULL: ${f.more ? 'more than ' : ''}${n(refused)} casualt${refused === 1 ? 'y' : 'ies'} could not be stored.</b> This incident has reached its limit of ${n(max || count)} casualties. The casualties below are <b>not</b> in the counts, list or map on this screen. The phones that recorded them still hold them, show them as not sent, and keep trying. Keep track of them another way (radio, paper triage cards, Hand over by QR to a phone in a second incident).` +
            `<ul class="full-list">${shown.map(x => `<li>${cat(x.category)} <b>${esc(shortId(x.id))}</b>${x.cardNo ? ' card ' + esc(x.cardNo) : ''}${x.sector ? ' • ' + esc(x.sector) : ''} • ${esc(x.triager || 'phone')} <span class="muted">${esc(x.device || '')}</span> • ${hm(x.at)}</li>`).join('')}</ul>${list.length > shown.length ? `<p class="muted">…and ${n(refused - shown.length)}${f.more ? '+' : ''} more.</p>` : ''}`;
    } else {
        box.className = 'danger full-warn near';
        box.innerHTML = `<b>Incident nearly full:</b> ${n(count)} of the ${n(max)} casualties one incident can hold. New casualties past ${n(max)} will not be stored; the phones will say so and keep them.`;
    }
    box.classList.remove('hidden');
    // A sound and an alert when more casualties are refused (not on the first load: the box says it).
    if (fullSeen >= 0 && refused > fullSeen) { ALERTS.list.unshift({ id: ++ALERTS.id, at: Date.now(), red: true, msg: `Incident full: ${n(refused - fullSeen)} more casualt${refused - fullSeen === 1 ? 'y' : 'ies'} could not be stored`, sub: 'see the red box at the top; the phones still hold them' }); ALERTS.list = ALERTS.list.slice(0, 20); renderAlerts([ALERTS.id]); beep(3); }
    fullSeen = refused;
}
// Red banner that stays while any phone's call for help is live, with a Clear button for the commander.
function renderSos(devs) {
    const box = $('sos');
    if (!box) return;
    const live = (devs || []).filter(sos).sort((a, b) => Number(a.duress.at) - Number(b.duress.at));
    if (!live.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.innerHTML = live.map(d => `<div class="sos-row"><span class="sos-icon">🆘</span><span class="msg"><b>${esc(d.triager || 'Unnamed')}</b> <span class="muted">${esc(d.deviceId)}</span> needs help<small>${esc(posText(d.duress.position || d.position))} • called at ${hm(d.duress.at)}${d.stale ? ' • <b>phone not heard from for 5 minutes</b>' : ''}</small></span>` +
        `<span class="sos-btns">${(d.duress.position || d.position) ? `<button type="button" class="btn small sec" data-act="showTeamOnMap" data-dev="${esc(d.deviceId)}">Show on map</button>` : ''}${canMark() ? `<button type="button" class="btn small" data-act="clearDuress" data-dev="${esc(d.deviceId)}">Clear: help is on its way</button>` : ''}</span></div>`).join('');
    box.classList.remove('hidden');
}
async function clearDuress(deviceId) {
    if (!canMark() || !data) return;
    const d = (data.devices || []).find(x => x.deviceId === deviceId);
    if (!d || !sos(d)) return;
    if (!await ask({ title: `Clear the call for help from ${d.triager || deviceId}?`, message: 'Only do this once someone is going to them. Their phone is told it was cleared; they can call again if they still need help.', okLabel: 'Clear: help is on its way' })) return;
    if (demo) { d.duress = Object.assign({}, d.duress, { clearedAt: Date.now(), clearedBy: 'commander' }); render(); return; }
    const by = await whoDecides();
    if (!by) return;
    try {
        const r = await fetch(`/api/incident/${encodeURIComponent(cfg.code)}/duress-clear`, { method: 'POST', headers: hdrs(true), body: JSON.stringify({ deviceId, by }), cache: 'no-store' });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) { tell(b.message || `Could not clear the call for help (server replied ${r.status}).`); return; }
        d.duress = b.duress || Object.assign({}, d.duress, { clearedAt: Date.now(), clearedBy: 'commander' });
        knownSeq = ''; etag = '';   // make sure the next poll brings the server's copy
        render();
        refreshNow();
    } catch (e) { tell('Could not reach the server, so the call for help was not cleared. Try again.'); }
}
function teamIcon(d, now) {
    const stale = posStale(d.position, now);
    const label = d.triager || d.deviceId;
    return L.divIcon({ html: `<div class="tm${stale ? ' tm-old' : ''}${sos(d) ? ' tm-sos' : ''}"><span class="tm-dot">${sos(d) ? '🆘' : '👤'}</span><span class="tm-name">${esc(label)}</span><span class="tm-age">${esc(age(d.position.timestamp))}</span></div>`, className: 'mk-wrap', iconSize: [0, 0], iconAnchor: [0, 0] });
}
// Triager markers are kept and updated in place (an open pop-up stays open); their accuracy circles are redrawn.
const teamByDev = new Map();
let teamCircles = null;
function teamPopup(d, p, now) { return `<div class="map-pop"><b>${sos(d) ? '🆘 ' : '👤 '}${esc(d.triager || 'Unnamed')}</b> <span class="muted">${esc(d.deviceId)}</span>${sos(d) ? ' <b style="color:#DA291C">NEEDS HELP</b>' : ''}<div class="map-pop-meta">${esc(posText(p))}${posStale(p, now) ? ' • <b>over 5 minutes old</b>' : ''}</div><div class="map-pop-meta">${d.records || 0} record${d.records === 1 ? '' : 's'} • last report ${esc(age(d.lastSeen))}</div>${sos(d) && canMark() ? `<button type="button" class="btn small" style="margin-top:6px" data-act="clearDuress" data-dev="${esc(d.deviceId)}">Clear: help is on its way</button>` : ''}</div>`; }
function renderTeams(devs, now) {
    if (!map) return;
    if (!teamsLayer) teamsLayer = L.layerGroup().addTo(map);
    if (!teamCircles) teamCircles = L.layerGroup().addTo(map);
    teamCircles.clearLayers();
    const seen = new Set();
    (devs || []).forEach(d => {
        const p = sos(d) && d.duress.position ? d.duress.position : d.position;
        if (!p || !p.lat) return;
        const ll = [Number(p.lat), Number(p.lng)];
        seen.add(d.deviceId);
        let m = teamByDev.get(d.deviceId);
        const icon = teamIcon(Object.assign({}, d, { position: p }), now);
        if (!m) { m = L.marker(ll, { icon }); m._dev = d.deviceId; m.bindPopup(''); teamsLayer.addLayer(m); teamByDev.set(d.deviceId, m); }
        else { m.setLatLng(ll); m.setIcon(icon); }
        m.setZIndexOffset(sos(d) ? 2000 : 1000);
        m.setPopupContent(teamPopup(d, p, now));
        if (p.acc && p.acc > 15) teamCircles.addLayer(L.circle(ll, { radius: Number(p.acc), color: sos(d) ? '#DA291C' : '#330072', weight: 1, opacity: 0.5, fillOpacity: 0.06, interactive: false }));
    });
    teamByDev.forEach((m, id) => { if (!seen.has(id)) { teamsLayer.removeLayer(m); teamByDev.delete(id); } });
}
function showTeamOnMap(deviceId) {
    if (!map || !teamsLayer) return;
    const m = teamByDev.get(deviceId);
    if (!m) return;
    try { $('map').scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 17));
    m.openPopup();
}
function renderAlerts(newIds) {
    const box = $('alerts');
    if (!ALERTS.list.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const isNew = (id) => (newIds || []).indexOf(id) > -1;
    box.innerHTML = ALERTS.list.map(a => `<div class="alert${a.red ? ' red' : ''}${isNew(a.id) ? ' new' : ''}"${a.uid ? ` data-act="openPatient" data-uid="${esc(a.uid)}" role="button" tabindex="0"` : ''}><span>${a.red ? '🔴' : '🟠'}</span><span class="msg">${a.msg}<small>${a.sub || ''}</small></span><span class="when">${hm(a.at)}</span><button type="button" class="x" title="Dismiss" data-act="dismissAlert" data-id="${a.id}" aria-label="Dismiss">✕</button></div>`).join('') +
        `<div class="alerts-foot"><button type="button" class="btn small sec" data-act="dismissAlert">Clear all</button></div>`;
    box.classList.remove('hidden');
}
function dismissAlert(id) { ALERTS.list = id ? ALERTS.list.filter(a => a.id !== id) : []; renderAlerts(); }

// ---------- METHANE (the newest one any phone has saved) ----------
function renderMethane() {
    const m = data && data.methane;
    const card = $('methane-card');
    if (!m) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const rows = [['M', 'Major incident', m.m], ['E', 'Exact location', m.e], ['T', 'Type', m.t], ['H', 'Hazards', m.h], ['A', 'Access', m.a], ['N', 'Number of casualties', m.n], ['E', 'Emergency services', m.e_svc]];
    $('methane').innerHTML = `<dl class="methane">${rows.map(r => `<dt title="${esc(r[1])}">${r[0]}</dt><dd>${r[2] ? esc(r[2]) : '<span class="muted">—</span>'}</dd>`).join('')}</dl>`;
    setText('methane-note', `${m.by ? 'by ' + m.by + ' • ' : ''}${hm(m.timestamp)}${m.device ? ' • phone ' + m.device : ''}`);
}

// ---------- Hospital board: who has gone where, against a capacity the control room types in ----------
function capKey() { return 'mit_cmd_cap_' + ((data && data.code) || ''); }
function loadCaps() { try { return JSON.parse(localStorage.getItem(capKey()) || '{}') || {}; } catch (e) { return {}; } }
function setCap(h, v) { try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {} const c = loadCaps(); const n = parseInt(v, 10); if (isFinite(n) && n >= 0) c[h] = n; else delete c[h]; try { localStorage.setItem(capKey(), JSON.stringify(c)); } catch (e) {} renderHospitals((data && data.records) || []); }
// Capacity boxes carry the hospital name in data-h (escaped); one listener on the board, so no script is ever built from a phone-supplied name.
document.addEventListener('DOMContentLoaded', () => { $('hosp').addEventListener('change', e => { const t = e.target; if (t && t.matches && t.matches('input[data-h]')) setCap(t.getAttribute('data-h'), t.value); }); });
function addHospitalRow() { const sel = $('hosp-add'); const h = sel && sel.value; if (!h) return; const c = loadCaps(); if (c[h] === undefined) c[h] = 0; try { localStorage.setItem(capKey(), JSON.stringify(c)); } catch (e) {} renderHospitals((data && data.records) || []); }
function renderHospitals(all) {
    // Polls redraw the board every 30 s; do not wipe a capacity someone is still typing.
    const ae = document.activeElement;
    if (ae && ae.matches && ae.matches('#hosp input[data-h]')) return;
    const caps = loadCaps();
    const order = ['P1', 'P1_HOLD', 'P2', 'P3', 'NOT_BREATHING', 'DEAD'];
    const by = {};
    all.filter(r => r.evacuated).forEach(r => { const h = String(r.evacDest || '').trim() || 'Destination not recorded'; (by[h] = by[h] || []).push(r); });
    Object.keys(caps).forEach(h => { by[h] = by[h] || []; });
    const names = Object.keys(by).sort((a, b) => by[b].length - by[a].length || a.localeCompare(b));
    const defaults = (MITTLib.DEFAULT_HOSPITALS || []).filter(h => !by[h]);
    const rows = names.map(h => {
        const rs = by[h];
        const cap = caps[h];
        const over = cap !== undefined && cap > 0 && rs.length > cap;
        const vehicles = Array.from(new Set(rs.map(r => r.evacVehicle).filter(Boolean)));
        const last = rs.length ? Math.max.apply(null, rs.map(r => r.evacAt || r.handoverAt || r.updatedAt || 0)) : 0;
        return `<tr class="${over ? 'over' : ''}"><td><b>${esc(h)}</b>${vehicles.length ? `<div class="cap-note">${esc(vehicles.join(', '))}</div>` : ''}${last ? `<div class="cap-note">last ${hm(last)}</div>` : ''}</td>` +
            order.map(c => `<td class="n">${rs.filter(r => r.category === c).length || ''}</td>`).join('') +
            `<td class="n">${rs.length}</td><td><input type="number" min="0" inputmode="numeric" value="${cap === undefined ? '' : cap}" placeholder="—" data-h="${esc(h)}" title="Capacity agreed with this hospital"> ${over ? '<span class="flag">over</span>' : ''}</td></tr>`;
    }).join('');
    $('hosp').innerHTML = (names.length ? `<table class="hb"><thead><tr><th>Hospital</th>${order.map(c => `<th class="n">${esc(MITTLib.CATEGORY_INFO[c].short)}</th>`).join('')}<th class="n">Sent</th><th>Capacity</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">Nobody evacuated yet. Add a hospital to record its agreed capacity.</p>') +
        (defaults.length ? `<div class="row" style="margin-top:8px"><select id="hosp-add" style="font-size:0.9rem; padding:6px; max-width:60%"><option value="">Add a hospital…</option>${defaults.map(h => `<option>${esc(h)}</option>`).join('')}</select><button type="button" class="btn small sec" data-act="addHospitalRow">Add</button></div>` : '');
    const sent = all.filter(r => r.evacuated).length;
    setText('hosp-note', `${sent} evacuated to ${names.filter(h => by[h].length).length} destination${names.filter(h => by[h].length).length === 1 ? '' : 's'} • capacity is typed here and stays on this screen only`);
}

// ---------- Incident timeline, built from what the records already carry ----------
let timelineAll = false;
function timelineEvents(all) {
    const ev = [];
    all.forEach(r => {
        const id = shortId(r.id);
        const hist = r.triageHistory || [];
        if (hist.length) hist.forEach((t, i) => { if (t.ts) ev.push({ ts: t.ts, uid: r.uid, id, text: `${i === 0 ? 'Triaged' : t.kind === 'correction' ? 'Corrected' : 'Re-triaged'} ${esc(t.tool || '')} <b>${esc(MITTLib.categoryShort(t.category))}</b>`, sub: [t.reason, t.by].filter(Boolean).join(' • ') }); });
        else if (r.timestamp) ev.push({ ts: r.timestamp, uid: r.uid, id, text: `Triaged ${esc(r.tool || '')} <b>${esc(MITTLib.categoryShort(r.category))}</b>`, sub: [r.reason, r.triager].filter(Boolean).join(' • ') });
        Object.keys(r.interventions || {}).forEach(k => { const t = r.interventions[k]; if (t && t.ts) ev.push({ ts: t.ts, uid: r.uid, id, text: esc(k), sub: t.by || '' }); });
        if (r.lastDeteriorationAt) ev.push({ ts: r.lastDeteriorationAt, uid: r.uid, id, text: '<b style="color:#DA291C">Deteriorated</b>', sub: '' });
        if (r.ccsAt) ev.push({ ts: r.ccsAt, uid: r.uid, id, text: 'Arrived at the casualty clearing station', sub: '' });
        if (r.handoverAt && r.handoverTo) ev.push({ ts: r.handoverAt, uid: r.uid, id, text: `Handed to ${esc(r.handoverTo)}`, sub: r.handoverState || '' });
        if (r.evacuated) { const t = r.evacAt || (r.handoverAt && r.handoverState === 'accepted' ? r.handoverAt : 0) || r.updatedAt; if (t) ev.push({ ts: t, uid: r.uid, id, text: `<b>Evacuated</b> to ${esc(r.evacDest || 'destination not recorded')}`, sub: r.evacVehicle || '' }); }
    });
    ev.sort((a, b) => b.ts - a.ts);
    return ev;
}
function renderTimeline(all) {
    const ev = timelineEvents(all);
    const shown = timelineAll ? ev : ev.slice(0, 40);
    $('timeline').innerHTML = shown.map(e => `<li data-act="openPatient" data-uid="${esc(e.uid)}" role="button" tabindex="0"><span class="t">${hm(e.ts)}</span><span class="id">${esc(e.id)}</span><span class="ev">${e.text}${e.sub ? ` <small>${esc(e.sub)}</small>` : ''}</span></li>`).join('') || '<li class="muted">Nothing recorded yet.</li>';
    $('timeline-note').innerHTML = `${ev.length} event${ev.length === 1 ? '' : 's'}, newest first${ev.length > 40 ? ` • <a href="#" data-act="toggleTimeline">${timelineAll ? 'show latest 40' : 'show all'}</a>` : ''}`;
}

// ---------- Printable summary: a record for the incident log and the debrief ----------
function printSummary() {
    if (!data) return;
    const all = data.records || [];
    const order = ['P1', 'P1_HOLD', 'P2', 'P3', 'NOT_BREATHING', 'DEAD'];
    const sc = MITTLib.stageCounts(all);
    const onScene = all.filter(r => !r.evacuated);
    const m = data.methane;
    const when = new Date().toLocaleString('en-GB');
    const counts = `<table><thead><tr><th></th>${order.map(c => `<th>${esc(MITTLib.CATEGORY_INFO[c].short)}</th>`).join('')}<th>Total</th></tr></thead><tbody>` +
        `<tr><td>On scene (field + casualty clearing station)</td>${order.map(c => `<td>${onScene.filter(r => r.category === c).length}</td>`).join('')}<td>${onScene.length}</td></tr>` +
        `<tr><td>Evacuated</td>${order.map(c => `<td>${all.filter(r => r.evacuated && r.category === c).length}</td>`).join('')}<td>${sc.evacuated}</td></tr>` +
        `<tr><td><b>All casualties</b></td>${order.map(c => `<td><b>${all.filter(r => r.category === c).length}</b></td>`).join('')}<td><b>${all.length}</b></td></tr></tbody></table>` +
        `<p>In the field ${sc.field} • at the casualty clearing station ${sc.ccs} • evacuated ${sc.evacuated} • TST only (no MITT sort) ${onScene.filter(r => !hadMitt(r)).length}</p>`;
    const hosp = Object.keys(sc.hospitals).sort().map(h => { const rs = all.filter(r => r.evacuated && (String(r.evacDest || '').trim() || 'Destination not recorded') === h); return `<tr><td>${esc(h)}</td>${order.map(c => `<td>${rs.filter(r => r.category === c).length || ''}</td>`).join('')}<td>${rs.length}</td><td>${esc(Array.from(new Set(rs.map(r => r.evacVehicle).filter(Boolean))).join(', '))}</td></tr>`; }).join('');
    const phones = (data.devices || []).map(d => `<tr><td>${esc(d.triager || 'Unnamed')}</td><td>${esc(d.deviceId)}</td><td>${d.records || 0}</td><td>${hm(d.joinedAt)}</td><td>${hm(d.lastSeen)}</td></tr>`).join('');
    const tl = timelineEvents(all).slice().reverse().map(e => `<tr><td>${hm(e.ts)}</td><td>${esc(e.id)}</td><td>${e.text}${e.sub ? ` <span class="muted">${esc(e.sub)}</span>` : ''}</td></tr>`).join('');
    const rows = all.map(r => { const l = loc(r); const grid = l && l.lat ? MITTLib.toOsGridRef(l.lat, l.lng) : ''; return `<tr><td>${esc(r.id)}${r.cardNo ? `<br><b>card ${esc(r.cardNo)}</b>` : ''}</td><td>${cat(r.category)} ${hadMitt(r) ? 'MITT' : 'TST only'}</td><td>${esc(MITTLib.STAGE_INFO[stage(r)].short)}${r.evacuated ? ' → ' + esc(r.evacDest || '?') : ''}</td><td>${hm(r.timestamp)}</td><td>${esc(place(r) || '')}${grid ? ` <span class="muted">${esc(grid)}</span>` : ''}</td><td>${Object.keys(r.interventions || {}).map(k => esc(k) + ' ' + esc((r.interventions[k] || {}).time || '')).join(', ')}</td><td>${esc(r.triager || '')}</td></tr>`; }).join('');
    $('print-view').innerHTML = `<h1>Major Incident Triage — commander summary</h1>` +
        `<p>${data.name ? esc(data.name) + ' • ' : ''}Code ${esc(data.code || '')}${data.incidentCode ? ' • Incident ' + esc(data.incidentCode) : ''}${data.training ? ' • <b>TRAINING / EXERCISE</b>' : ''}<br>Started ${data.createdAt ? new Date(data.createdAt).toLocaleString('en-GB') : '?'} • printed ${when} • ${all.length} casualties from ${(data.devices || []).length} phones</p>` +
        `<h2>Counts</h2>${counts}` +
        (m ? `<h2>METHANE (${m.by ? esc(m.by) + ', ' : ''}${hm(m.timestamp)})</h2><table><tbody>${[['M', m.m], ['E', m.e], ['T', m.t], ['H', m.h], ['A', m.a], ['N', m.n], ['E', m.e_svc]].map(x => `<tr><th style="width:2em">${x[0]}</th><td>${esc(x[1] || '')}</td></tr>`).join('')}</tbody></table>` : '') +
        (() => { const t = MITTLib.debriefTimings(all, { startedAt: data.createdAt }); return t.count ? `<h2>Debrief timings</h2><table><tbody>${debriefRowsHtml(t)}</tbody></table>` : ''; })() +
        `<h2>Hospitals</h2>${hosp ? `<table><thead><tr><th>Hospital</th>${order.map(c => `<th>${esc(MITTLib.CATEGORY_INFO[c].short)}</th>`).join('')}<th>Sent</th><th>Vehicles</th></tr></thead><tbody>${hosp}</tbody></table>` : '<p>Nobody evacuated.</p>'}` +
        `<h2>Phones</h2><table><thead><tr><th>Triager</th><th>Phone</th><th>Records</th><th>Joined</th><th>Last report</th></tr></thead><tbody>${phones}</tbody></table>` +
        `<h2>Casualties (${all.length})</h2><table><thead><tr><th>ID</th><th>Category</th><th>Stage</th><th>Triaged</th><th>Where</th><th>Interventions</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>` +
        `<h2>Timeline</h2><table><thead><tr><th>Time</th><th>ID</th><th>Event</th></tr></thead><tbody>${tl}</tbody></table>` +
        `<p class="muted">An aid for a live incident, not a clinical record: the phones keep the audit trail. Printed from the commander screen.</p>`;
    setTimeout(() => window.print(), 50);
}
function batteryTag(d) { if (typeof d.battery !== 'number' || d.charging || d.battery > 25) return ''; return ` <span class="cat-chip" style="background:${d.battery <= 10 ? '#DA291C' : '#c9a700'};color:#fff;font-size:0.72rem;padding:1px 6px" title="Battery">🔋 ${d.battery}%</span>`; }
// The phone's ID is "<prefix>-<TOOL>-<number>"; on the wall the prefix is noise, so show "TST 014" style.
function shortId(id) { const m = /^(?:.*-)?(TST|MITT)-(\d+)$/.exec(String(id || '')); return m ? `${m[1]} ${m[2]}` : String(id || ''); }
let legendDone = false;
function renderLegend() {
    if (legendDone) return; legendDone = true;
    const sw = (c, extra) => `<span class="sw${extra ? ' ' + extra : ''}" style="background:${MITTLib.CATEGORY_INFO[c] ? MITTLib.CATEGORY_INFO[c].colour : '#4C6272'}"></span>`;
    $('legend').innerHTML = ['P1', 'P2', 'P3', 'P1_HOLD', 'NOT_BREATHING', 'DEAD'].map(c => `<span class="lg">${sw(c)}${esc(MITTLib.CATEGORY_INFO[c].short)} <span class="muted">${esc(MITTLib.CATEGORY_INFO[c].label.toLowerCase())}</span></span>`).join('') +
        `<span class="lg opt"><span class="sw dash"></span>dashed = TST sieve</span><span class="lg opt"><span class="sw sq" style="background:#aaa"></span>square = at the casualty clearing station</span><span class="lg opt"><span class="sw sq" style="background:#007F3B"></span>CCS</span><span class="lg opt"><span class="sw sq" style="background:#330072"></span>👤 triager (opt-in; grey = over 5 min old, red = needs help)</span><span class="spacer"></span><span class="lg opt">Big number = on scene now • small = including evacuated • W wall • F full screen</span>`;
}
function markerIcon(r) {
    const info = MITTLib.CATEGORY_INFO[r.category] || { colour: '#005EB8', text: '#fff' };
    const tail = String(r.id || '').replace(/^.*-/, '').slice(-4) || '•';
    return L.divIcon({ html: `<div class="mk${r.tool === 'TST' ? ' mk-tst' : ''}${r.evacuated ? ' mk-evac' : ''}${stage(r) === 'ccs' ? ' mk-atccs' : ''}" style="background:${info.colour};color:${info.text};">${esc(tail)}</div>`, className: 'mk-wrap', iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -14] });
}
// A bubble of grouped casualties takes the colour of the most urgent category inside it, and shows how many of each
// (3,000-casualty test: bubbles were coloured by size, so a "green" bubble held four P1s and a Not Breathing).
// Urgency follows the app's priority order: P1, P1 Hold, P2, P3, Not Breathing, Dead. Evacuated casualties only
// colour a bubble that holds nobody else.
const MAP_ORDER = ['P1', 'P1_HOLD', 'P2', 'P3', 'NOT_BREATHING', 'DEAD'];
function clusterIcon(cl) {
    const ms = cl.getAllChildMarkers();
    const here = {}, all = {};
    ms.forEach(m => { const c = m.options.cat || ''; all[c] = (all[c] || 0) + 1; if (!m.options.evac) here[c] = (here[c] || 0) + 1; });
    const use = Object.keys(here).length ? here : all;
    const top = MAP_ORDER.find(c => use[c]) || '';
    const info = MITTLib.CATEGORY_INFO[top] || { colour: '#4C6272', text: '#fff' };
    const chips = MAP_ORDER.filter(c => use[c]).map(c => { const i = MITTLib.CATEGORY_INFO[c]; return `<i style="background:${i.colour};color:${i.text}" title="${esc(i.short)}">${use[c]}</i>`; }).join('');
    const label = MAP_ORDER.filter(c => use[c]).map(c => `${use[c]} ${MITTLib.CATEGORY_INFO[c].short}`).join(', ');
    return L.divIcon({ html: `<div class="cl${Object.keys(here).length ? '' : ' cl-evac'}" style="background:${info.colour};color:${info.text}" aria-label="${esc(ms.length + ' casualties: ' + label)}"><b>${ms.length}</b><span class="cl-cats">${chips}</span></div>`, className: 'mk-wrap cl-wrap', iconSize: [0, 0] });
}
function ensureMap() {
    if (map || typeof L === 'undefined') return !!map;
    map = L.map('map').setView([54.0, -2.0], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    cluster = L.markerClusterGroup({ maxClusterRadius: 40, spiderfyOnMaxZoom: true, showCoverageOnHover: false, disableClusteringAtZoom: 19, chunkedLoading: true, iconCreateFunction: clusterIcon });
    map.addLayer(cluster);
    circles = L.layerGroup().addTo(map);
    map.on('click', onMapClickMark);
    map.on('moveend', scheduleCircles);
    cluster.on('animationend', scheduleCircles);
    return true;
}
function markerSig(r) {
    const l = loc(r) || {};
    return [r.category, r.tool, r.evacuated ? 1 : 0, stage(r), l.lat, l.lng, l.acc, r.id, hadMitt(r) ? 1 : 0, r.highRisk ? 1 : 0, r.updatedAt || 0, r.triager || '', place(r)].join('|');
}
function markerPopup(r) {
    const l = loc(r) || {};
    const grid = l.lat ? MITTLib.toOsGridRef(Number(l.lat), Number(l.lng)) : '';
    return `<div class="map-pop"><b>${esc(r.id)}</b> ${cat(r.category)} ${toolChip(r)} ${stageTag(r)}${r.highRisk ? ' <b style="color:#DA291C">HIGH RISK</b>' : ''}<div class="map-pop-meta">${esc(place(r) || 'No place label')}</div><div class="map-pop-meta">${grid ? esc(grid) + ' • ' : ''}${l.acc ? '±' + Math.round(l.acc) + ' m • ' : ''}${esc(r.triager || '')} • ${age(r.updatedAt)}</div><button type="button" class="btn small" style="margin-top:6px" data-act="openPatient" data-uid="${esc(r.uid)}">Full details</button></div>`;
}
// Markers are kept between refreshes and only changed where a casualty changed, so an open pop-up stays open and a
// big incident is not redrawn from scratch every 30 seconds (3,000-casualty test).
function renderMap(records) {
    if (!ensureMap()) { setText('map-note', 'map library did not load'); return; }
    const want = new Map();
    records.forEach(r => { const l = loc(r); if (l && l.lat) want.set(r.uid, r); });
    const toRemove = [], toAdd = [], restyled = [];
    markerByUid.forEach((v, uid) => { if (!want.has(uid)) { toRemove.push(v.m); markerByUid.delete(uid); } });
    want.forEach((r, uid) => {
        const sig = markerSig(r);
        const cur = markerByUid.get(uid);
        const l = loc(r), ll = [Number(l.lat), Number(l.lng)];
        if (!cur) {
            const m = L.marker(ll, { icon: markerIcon(r), cat: r.category, evac: !!r.evacuated });
            m.bindPopup(markerPopup(r));
            m._uid = uid;
            markerByUid.set(uid, { m, sig, r });
            toAdd.push(m);
            return;
        }
        cur.r = r;
        if (cur.sig === sig) { if (cur.m.isPopupOpen && cur.m.isPopupOpen()) cur.m.setPopupContent(markerPopup(r)); return; }
        const moved = !cur.m.getLatLng().equals(L.latLng(ll));
        cur.sig = sig;
        cur.m.options.cat = r.category; cur.m.options.evac = !!r.evacuated;
        cur.m.setIcon(markerIcon(r));
        cur.m.setPopupContent(markerPopup(r));
        if (moved) { toRemove.push(cur.m); cur.m.setLatLng(ll); toAdd.push(cur.m); }
        else restyled.push(cur.m);
    });
    if (toRemove.length) cluster.removeLayers(toRemove);
    if (toAdd.length) cluster.addLayers(toAdd);
    if (restyled.length) cluster.refreshClusters(restyled);
    const n = want.size;
    if (data.ccs && data.ccs.lat) {
        const ll = [Number(data.ccs.lat), Number(data.ccs.lng)];
        if (!ccsMarker) ccsMarker = L.marker(ll, { icon: L.divIcon({ html: '<div class="mk mk-ccs">CCS</div>', className: 'mk-wrap', iconSize: [40, 28], iconAnchor: [20, 14] }) }).bindPopup('Casualty clearing station').addTo(map);
        else ccsMarker.setLatLng(ll);
    } else if (ccsMarker) { map.removeLayer(ccsMarker); ccsMarker = null; }
    renderMarks();
    renderTeams(data.devices, Date.now());
    const nt = (data.devices || []).filter(d => d.position || (sos(d) && d.duress.position)).length;
    setText('map-note', `${n} with a position${records.length - n ? `, ${records.length - n} without` : ''}${nt ? ` • ${nt} triager${nt === 1 ? '' : 's'}` : ''} • bubbles take the colour of their most urgent casualty`);
    if (firstFit && (n || ccsMarker || nt)) { firstFit = false; fitMap(); }
    scheduleCircles();
    setTimeout(() => map.invalidateSize(), 100);
}
// Accuracy circles are drawn only round casualties shown on their own (not grouped in a bubble) and in view, so they
// group with the bubbles (3,000-casualty test: 2,060 circles sat on top of the bubbles when zoomed out).
const CIRCLES_MAX = 300;
let circlesTimer = null;
function scheduleCircles() { if (circlesTimer) clearTimeout(circlesTimer); circlesTimer = setTimeout(() => { circlesTimer = null; updateCircles(); }, 150); }
function updateCircles() {
    if (!map || !circles) return;
    circles.clearLayers();
    const b = map.getBounds();
    let n = 0;
    markerByUid.forEach(({ m, r }) => {
        if (n >= CIRCLES_MAX) return;
        const l = loc(r);
        if (!l || !(Number(l.acc) > 15)) return;
        if (!b.contains(m.getLatLng()) || cluster.getVisibleParent(m) !== m) return;
        n++;
        circles.addLayer(L.circle(m.getLatLng(), { radius: Number(l.acc), color: MITTLib.CATEGORY_INFO[r.category] ? MITTLib.CATEGORY_INFO[r.category].colour : '#005EB8', weight: 1, opacity: 0.6, fillOpacity: 0.08, interactive: false }));
    });
}
function fitMap() {
    if (!map) return;
    const layers = [];
    markerByUid.forEach(v => layers.push(v.m));
    if (ccsMarker) layers.push(ccsMarker);
    teamByDev.forEach(m => layers.push(m));
    if (!layers.length) return;
    const b = L.featureGroup(layers).getBounds();
    map.fitBounds(b.pad(0.2), { maxZoom: 18 });
}
// ---------- In-app dialogs ----------
// The browser's own confirm()/alert() stop the whole page (no refresh, no alarms) until someone clicks,
// so the commander screen asks its questions in its own dialog instead.
let askResolve = null, askReturnFocus = null;
function ask(opts) {
    if (askResolve) askAnswer(false);
    const o = typeof opts === 'string' ? { message: opts } : opts;
    setText('ask-title', o.title || '');
    setText('ask-msg', o.message || '');
    $('ask-title').style.display = o.title ? '' : 'none';
    const ok = $('ask-ok'), cancel = $('ask-cancel');
    ok.textContent = o.okLabel || 'OK';
    ok.className = 'btn' + (o.danger ? ' danger' : '');
    cancel.textContent = o.cancelLabel || 'Cancel';
    cancel.style.display = o.alertOnly ? 'none' : '';
    // With o.input, the dialog has a text box and answers with its text (or null on Cancel).
    const inp = $('ask-input');
    askWantsText = !!o.input;
    inp.style.display = o.input ? '' : 'none';
    inp.value = ''; inp.placeholder = typeof o.input === 'string' ? o.input : '';
    askReturnFocus = document.activeElement;
    $('ask-modal').classList.add('open');
    try { (o.input ? inp : o.alertOnly ? ok : cancel).focus(); } catch (e) {}
    return new Promise(res => { askResolve = res; });
}
let askWantsText = false;
function askAnswer(ok) {
    $('ask-modal').classList.remove('open');
    const res = askResolve; askResolve = null;
    const back = askReturnFocus; askReturnFocus = null;
    if (back && back.isConnected && back.focus) { try { back.focus(); } catch (e) {} }
    if (res) res(askWantsText ? (ok ? $('ask-input').value : null) : !!ok);
}
function tell(message, title) { return ask({ title: title || '', message, alertOnly: true }); }

// ---------- Patient details (any row, attention item or marker) ----------
let openUid = null;
let ptReturnFocus = null;   // where focus goes back to when the details close
function openPatient(uid) {
    const r = byUid(uid); if (!r) return;
    if (!openUid) ptReturnFocus = document.activeElement;
    openUid = uid; renderPatient(r); $('pt-modal').classList.add('open');
    try { $('pt-close').focus(); } catch (e) {}
}
function closePatient() {
    const wasOpen = !!openUid;
    openUid = null; $('pt-modal').classList.remove('open');
    const back = ptReturnFocus; ptReturnFocus = null;
    if (wasOpen && back && back.isConnected && back.focus) { try { back.focus(); } catch (e) {} }
}
function showPatientOnMap() {
    const r = byUid(openUid); const l = r && loc(r);
    if (!l || !l.lat || !map) return;
    closePatient();
    if (document.body.classList.contains('wall')) setWall(false);
    map.setView([Number(l.lat), Number(l.lng)], Math.max(map.getZoom(), 18));
    const mm = markerByUid.get(r.uid), m = mm && mm.m;
    if (m) setTimeout(() => cluster.zoomToShowLayer(m, () => m.openPopup()), 200);
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function dhm(ts) { return ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'; }
function kv(rows) { return `<dl class="kv">${rows.filter(x => x[1] !== undefined && x[1] !== null && x[1] !== '').map(x => `<dt>${esc(x[0])}</dt><dd>${x[2] ? x[1] : esc(String(x[1]))}</dd>`).join('')}</dl>`; }
function renderPatient(r) {
    if (!r) { closePatient(); return; }
    const now = Date.now();
    const rs = MITTLib.reassessmentStatus(r, now, MITTLib.REASSESS_INTERVALS);
    const st = stage(r);
    setText('pt-id', r.id);
    $('pt-chips').innerHTML = `${cat(r.category)} ${toolChip(r)} ${stageTag(r)}${r.highRisk ? ' <span class="cat-chip" style="background:#DA291C;color:#fff">HIGH RISK</span>' : ''}${rs.state === 'overdue' ? ` <span class="cat-chip" style="background:#DA291C;color:#fff">Reassessment overdue ${Math.round(rs.overdueMs / 60000)} min</span>` : ''}`;
    const hist = (r.triageHistory || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const triage = `<ul class="tl">${hist.length ? hist.map(t => `<li><span class="t">${dhm(t.ts)}</span><span><b>${esc(t.tool || '')} ${esc(MITTLib.categoryShort(t.category))}</b> ${esc(t.reason || '')}${t.kind && t.kind !== 'triage' ? ` <span class="muted">(${esc(t.kind)})</span>` : ''}${t.by ? ` <span class="muted">by ${esc(t.by)}</span>` : ''}${t.action ? `<div class="muted">${esc(t.action)}</div>` : ''}</span></li>`).join('') : `<li><span class="t">${dhm(r.timestamp)}</span><span><b>${esc(r.tool || '')} ${esc(MITTLib.categoryShort(r.category))}</b> ${esc(r.reason || '')}</span></li>`}</ul>`;
    const ints = Object.keys(r.interventions || {});
    const intsHtml = ints.length ? `<div class="ints">${ints.map(k => `<span class="int">${esc(k)}<small>${esc((r.interventions[k] && r.interventions[k].time) || '')}</small></span>`).join('')}</div>` : '<span class="muted">None recorded</span>';
    const inj = r.injuries || [];
    const injHtml = inj.length ? `<div class="inj"><svg viewBox="0 0 200 400"><path d="M100,20 C120,20 130,40 130,60 C130,70 120,80 100,80 C80,80 70,70 70,60 C70,40 80,20 100,20 Z" fill="#e8ecef" stroke="#555" stroke-width="2"/><path d="M70,80 L40,100 L40,200 L60,200 L70,150 L70,250 L90,400 L110,400 L130,250 L130,150 L140,200 L160,200 L160,100 L130,80 Z" fill="#e8ecef" stroke="#555" stroke-width="2"/>${inj.map(m => `<circle cx="${(m.x * 200).toFixed(1)}" cy="${(m.y * 400).toFixed(1)}" r="9" fill="${m.severity === 'severe' ? '#DA291C' : m.severity === 'moderate' ? '#ff9800' : '#005EB8'}" stroke="#fff" stroke-width="2"/>`).join('')}</svg><ul>${inj.map(m => `<li><b>${esc([m.side, m.region].filter(Boolean).join(' '))}</b>${m.label ? ' ' + esc(m.label) : ''}${m.severity && m.severity !== 'unspecified' ? ` <span class="muted">(${esc(m.severity)})</span>` : ''}${m.time ? ` <span class="muted">${esc(m.time)}</span>` : ''}</li>`).join('')}</ul></div>` : '<span class="muted">None marked</span>';
    const l = loc(r);
    const grid = l && l.lat ? MITTLib.toOsGridRef(l.lat, l.lng) : '';
    const lh = (r.locationHistory || []).slice().sort((a, b) => (a.at || a.timestamp || 0) - (b.at || b.timestamp || 0));
    const locHtml = kv([['Place', place(r) || '—'], ['Grid ref', grid ? `${grid}${l.acc ? ' ±' + Math.round(l.acc) + ' m' : ''}` : 'no position'], ['Confidence', r.locationConfidence || '']]) +
        (lh.length > 1 ? `<ul class="tl" style="margin-top:6px">${lh.map(h => `<li><span class="t">${dhm(h.at || h.timestamp)}</span><span>${esc(h.reason || h.action || 'position')}${h.sector || h.landmark ? ` <span class="muted">${esc([h.sector, h.landmark, h.area].filter(Boolean).join(', '))}</span>` : ''}${h.lat ? ` <span class="muted">${esc(MITTLib.toOsGridRef(h.lat, h.lng) || '')}</span>` : ''}${h.user ? ` <span class="muted">by ${esc(h.user)}</span>` : ''}</span></li>`).join('')}</ul>` : '');
    const chain = kv([
        ['Stage', `${stageTag(r)} ${st === 'ccs' && r.ccsAt ? 'since ' + dhm(r.ccsAt) : ''}`, true],
        ['Evacuated to', r.evacuated ? (r.evacDest || 'destination not recorded') : ''],
        ['Vehicle / crew', r.evacVehicle || ''], ['Hospital ID', r.hospitalId || ''],
        ['Care handed to', r.handoverTo ? `${r.handoverTo}${r.handoverState ? ' (' + r.handoverState + ')' : ''}${r.handoverAt ? ' at ' + dhm(r.handoverAt) : ''}` : (r.handoverState ? r.handoverState : '')],
        ['Time of death', r.tod || ''],
    ]);
    const reass = kv([
        ['Last reassessed', r.lastReassessed ? `${dhm(r.lastReassessed)}${r.reassessOutcome ? ' • ' + r.reassessOutcome : ''}` : 'not yet'],
        ['Next due', rs.state === 'na' ? 'n/a' : rs.state === 'overdue' ? `<span class="flag">overdue by ${Math.round(rs.overdueMs / 60000)} min</span>` : rs.state === 'due-soon' ? 'now' : dhm(rs.dueAt), true],
        ['Deteriorated', r.lastDeteriorationAt ? dhm(r.lastDeteriorationAt) : ''],
    ]);
    const who = kv([['Triage card no.', r.cardNo || ''], ['Triaged by', `${r.triager || r.createdBy || '—'}${r.deviceId ? ' • phone ' + r.deviceId : ''}`], ['First triage', dhm(r.createdAt || r.timestamp)], ['Reported by', r.reportedBy ? `${r.reportedBy} • ${age(r.reportedAt || r.updatedAt)}` : ''], ['Last change', age(r.updatedAt)], ['Incident', r.incidentCode || '']]);
    $('pt-body').innerHTML =
        `<div class="pt-sec"><h4>Triage</h4>${triage}</div>` +
        `<div class="pt-sec"><h4>Reassessment</h4>${reass}<h4 style="margin-top:10px">Where</h4>${locHtml}</div>` +
        `<div class="pt-sec"><h4>Interventions</h4>${intsHtml}<h4 style="margin-top:10px">Injuries</h4>${injHtml}</div>` +
        `<div class="pt-sec"><h4>Casualty clearing station, evacuation and handover</h4>${chain}<h4 style="margin-top:10px">Recorded by</h4>${who}</div>` +
        `<div class="pt-sec wide"><h4>Patient details and notes</h4>${kv([['Demographics', r.demos || ''], ['Allergies', r.allergies || '']])}${r.notes ? `<div class="pt-note">${esc(r.notes)}</div>` : '<span class="muted">No notes</span>'}</div>`;
}
function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function stamp() { return MITTLib.isoWithOffset(Date.now()).replace(/[:.]/g, '-'); }
function exportFile(kind) {
    if (!data) return;
    const recs = visibleRecords();
    const opts = { name: `Major Incident Triage ${data.code} — casualties`, ccs: data.ccs };
    const text = kind === 'gpx' ? MITTLib.buildGpx(recs, opts) : kind === 'kml' ? MITTLib.buildKml(recs, opts) : MITTLib.buildGeoJson(recs, opts);
    download(`MITT_commander_${data.code}_${stamp()}.${kind}`, text, kind === 'gpx' ? 'application/gpx+xml' : kind === 'kml' ? 'application/vnd.google-earth.kml+xml' : 'application/geo+json');
}
function exportCsv() {
    if (!data) return;
    const c = MITTLib.csvCell;
    const head = ['id', 'cardNo', 'category', 'tool', 'triaged', 'sector', 'landmark', 'floor', 'area', 'osGridRef', 'lat', 'lng', 'accuracyM', 'interventions', 'highRisk', 'evacuated', 'evacDest', 'triager', 'reportedBy', 'updated'];
    const lines = [head.join(',')].concat(visibleRecords().map(r => { const l = loc(r) || {}; return [r.id, r.cardNo || '', r.category, r.tool, r.timestamp ? MITTLib.isoWithOffset(r.timestamp) : '', r.sector, r.landmark, r.floor, r.area, l.lat ? MITTLib.toOsGridRef(l.lat, l.lng) || '' : '', l.lat || '', l.lng || '', l.acc || '', Object.keys(r.interventions || {}).map(k => k + ' ' + ((r.interventions[k] || {}).time || '')).join('; '), r.highRisk ? 'yes' : '', r.evacuated ? 'yes' : '', r.evacDest, r.triager, r.reportedBy, r.updatedAt ? MITTLib.isoWithOffset(r.updatedAt) : ''].map(c).join(','); }));
    download(`MITT_commander_${data.code}_${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}
// ---------- Clicks, changes and keys: one listener each, no inline handlers ----------
const ACTIONS = {
    refreshNow, toggleWall, toggleFullscreen, toggleSound, unlockSound, printSummary, signOut, signIn, fitMap, exportCsv, startMarking,
    showPatientOnMap, closePatient, addHospitalRow,
    exportFile: (t) => exportFile(t.getAttribute('data-arg')),
    setStageFilter: (t) => setStageFilter(t.getAttribute('data-stage')),
    openPatient: (t) => openPatient(t.getAttribute('data-uid')),
    removeMark: (t) => removeMark(t.getAttribute('data-id')),
    clearDuress: (t) => clearDuress(t.getAttribute('data-dev')),
    setP1Hold: (t) => setP1Hold(t.getAttribute('data-on') === '1'),
    sendMittPrompt,
    askAnswer: (t) => askAnswer(t.getAttribute('data-ok') === '1'),
    showTeamOnMap: (t) => showTeamOnMap(t.getAttribute('data-dev')),
    dismissAlert: (t) => dismissAlert(t.hasAttribute('data-id') ? Number(t.getAttribute('data-id')) : undefined),
    toggleTimeline: () => { timelineAll = !timelineAll; renderTimeline((data && data.records) || []); },
    moreRows: () => { tableLimit += TABLE_STEP; render({ sameData: true }); },
    allRows: () => { tableLimit = Infinity; render({ sameData: true }); },
};
document.addEventListener('click', e => {
    if (e.target === $('ask-modal')) { askAnswer(false); return; }
    if (e.target === $('pt-modal')) { closePatient(); return; }
    const t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || !ACTIONS[t.getAttribute('data-act')]) return;
    if (t.tagName === 'A') e.preventDefault();
    ACTIONS[t.getAttribute('data-act')](t, e);
});
document.addEventListener('change', e => {
    if (e.target === $('mark-type')) markTypeChanged();
    else if (e.target === $('show-evac')) render();
});
// The first tap or key anywhere also lets sound play.
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (ALERTS.ctx && ALERTS.ctx.state === 'suspended') unlockSound(); }, true));
document.addEventListener('keydown', e => {
    // Rows, alerts and timeline entries open with Enter or Space, as a button would.
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('[data-act][tabindex]:not(button):not(a)')) { e.preventDefault(); e.target.click(); return; }
    if (askResolve) { if (e.key === 'Escape') { e.preventDefault(); askAnswer(false); } else if (e.key === 'Enter' && askWantsText) { e.preventDefault(); askAnswer(true); } return; }
    if (e.key === 'Escape' && openUid) { closePatient(); return; }
    if (e.key === 'Enter' && !$('signin').classList.contains('hidden')) signIn();
    if ((e.key === 'w' || e.key === 'W') && $('signin').classList.contains('hidden') && !/INPUT|TEXTAREA/.test((e.target && e.target.tagName) || '')) toggleWall();
    if ((e.key === 'f' || e.key === 'F') && $('signin').classList.contains('hidden') && !/INPUT|TEXTAREA/.test((e.target && e.target.tagName) || '')) toggleFullscreen();
    if ((e.key === 's' || e.key === 'S') && $('signin').classList.contains('hidden') && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) toggleSound();
    if ((e.key === 'p' || e.key === 'P') && $('signin').classList.contains('hidden') && !/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) printSummary();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && (cfg || demo)) refreshNow(); });
window.addEventListener('hashchange', () => { if (/^#DEMO/i.test(location.hash) && !demo) startDemo(); });
if (loadCfg() === 'demo') startDemo();
else if (cfg && cfg.code && cfg.pin) start();
