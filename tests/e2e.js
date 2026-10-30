// End-to-end tests: drives the real app in headless Chromium, simulating two phones.
// Usage: node tests/e2e.js   (needs the `playwright` package and a Chromium build)
const path = require('path');
const http = require('http');
const fs = require('fs');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }
// Allow the reference QR encoder to be installed locally or globally.
try { require.resolve('qrcode'); } catch (e) { module.paths.push(require('child_process').execSync('npm root -g').toString().trim()); }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
// The incident commander backend runs in-process with an in-memory store, so the e2e suite covers the
// real page code and the real request handling without Netlify.
const { createCore, memoryStore } = require('../netlify/lib/incident-core.js');
const apiCore = createCore({ store: memoryStore() });
function serve() {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            if (req.url.startsWith('/api/')) {
                let body = '';
                req.on('data', c => { body += c; });
                req.on('end', () => {
                    apiCore.handle(req.method, req.url.split('?')[0], req.headers, body, req.socket.remoteAddress).then(r => {
                        if (process.env.E2E_LOG) console.log(`    [api ${new Date().toISOString().slice(11, 23)}] ${req.method} ${req.url} -> ${r.status}${req.headers['x-incident-seq'] ? ' seq ' + req.headers['x-incident-seq'] : ''} ${body.slice(0, 60)}`);
                        res.writeHead(r.status, r.headers);
                        res.end(r.body === null || r.body === undefined ? '' : JSON.stringify(r.body));
                    });
                });
                return;
            }
            const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
            if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
            fs.createReadStream(p).pipe(res);
        }).listen(0, () => resolve(srv));
    });
}

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e)); failed++; }
}

(async () => {
    const srv = await serve();
    const url = `http://localhost:${srv.address().port}/index.html`;
    const browser = await chromium.launch();
    const errors = [];
    async function device(name, opts) {
        const ctx = await browser.newContext(Object.assign({ acceptDownloads: true, serviceWorkers: 'block', geolocation: { latitude: 53.4808, longitude: -2.2426, accuracy: 8 }, permissions: ['geolocation'] }, opts || {}));
        if (opts && opts.initScript) await ctx.addInitScript(opts.initScript);
        const page = await ctx.newPage();
        page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
        await page.goto(url);
        await page.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 10000 });
        page._ctx = ctx;
        return page;
    }
    async function setup(page, name, role) {
        await page.fill('#intro-triager', name);
        // Most tests are not about the commander link, so answer the start-screen link question with "not now".
        await page.evaluate(() => { try { sessionStorage.setItem('mit_cmd_link_dismissed', '1'); localStorage.setItem('mit_share_pos_asked', '1'); } catch (e) {} });
        await page.evaluate(r => setUserRole(r), role || 'HCP');
    }
    // Resolve the next in-app dialog with OK (true) or Cancel (false), optionally typing text.
    async function answerDialog(page, ok, text) {
        await page.waitForSelector('#confirm-modal', { state: 'visible', timeout: 5000 });
        if (text !== undefined) await page.fill('#confirm-input', text);
        await page.click(ok ? '#confirm-ok' : '#confirm-cancel');
    }
    // The commander screen's in-app dialog (v0.19.4).
    async function askAnswer(page, ok) {
        await page.waitForSelector('#ask-modal.open', { timeout: 5000 });
        await page.click(ok ? '#ask-ok' : '#ask-cancel');
    }
    const triage = (page, tool, answers) => page.evaluate(([t, a]) => { initiateTriage(t); a.forEach(x => handleAnswer(x)); }, [tool, answers]);
    const qrText = (page) => page.evaluate(() => document.getElementById('qr-modal').dataset.qrText);
    const scan = (page, text) => page.evaluate(t => onScanSuccess(t), text);
    // Decode a drawn QR canvas with the app's own decoder (ZXing via html5-qrcode) in a correctly sized host.
    const decodeCanvas = (page, sel) => page.evaluate(async (sel) => {
        const c = document.querySelector(sel);
        let host = document.getElementById('dec-host');
        if (!host) { host = document.createElement('div'); host.id = 'dec-host'; document.body.appendChild(host); }
        host.style.cssText = 'position:absolute; left:-9000px; top:0; width:' + c.width + 'px;';
        const blob = await new Promise(r => c.toBlob(r));
        try { return await new Html5Qrcode('dec-host').scanFile(new File([blob], 'q.png', { type: 'image/png' }), false); }
        catch (e) { return { zxingFailed: String(e && e.message || e), png: c.toDataURL('image/png') }; }
    }, sel).then(r => {
        if (typeof r === 'string') return r;
        // ZXing (html5-qrcode) cannot find some valid codes in a static image: about 1 in 8 patient QRs in a
        // local test, on main as well. The same images match a reference encoder module-for-module and decode
        // with jsQR, so check the image with jsQR as a second, independent standard decoder.
        const { PNG } = require('pngjs'); const jsQR = require('jsqr');
        const png = PNG.sync.read(Buffer.from(r.png.split(',')[1], 'base64'));
        const out = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
        if (!out) throw new Error('Neither ZXing nor jsQR could decode the QR image (ZXing: ' + r.zxingFailed + ')');
        return out.data;
    });
    // Check every module drawn on the canvas matches the QR model for that text (whole-pixel rendering).
    const canvasMatchesModel = (page, sel, text) => page.evaluate(([sel, text]) => {
        const c = document.querySelector(sel);
        const m = new QRCode(document.createElement('div'), { text, width: 64, height: 64, correctLevel: text.length < 600 ? QRCode.CorrectLevel.M : QRCode.CorrectLevel.L })._oQRCode;
        const n = m.getModuleCount(), scale = c.width / (n + 8);
        if (scale !== Math.floor(scale)) return 'non-integer module size ' + scale;
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
            const x = Math.floor((col + 4 + 0.5) * scale), y = Math.floor((r + 4 + 0.5) * scale);
            if ((px[(y * c.width + x) * 4] < 128) !== m.isDark(r, col)) return `module ${r},${col} wrong`;
        }
        for (let i = 0; i < 4 * scale; i++) if (px[(i * c.width + i) * 4] < 128) return 'quiet zone not white';
        return 'ok';
    }, [sel, text]);

    console.log('\ne2e: identity, triage and data safety');
    const A = await device('A');
    await test('name is required before starting', async () => {
        await A.evaluate(() => setUserRole('HCP'));
        await page_visible(A, '#confirm-modal');
        assert.match(await A.textContent('#confirm-title'), /Name required/);
        await A.click('#confirm-ok');
        await setup(A, 'Medic A');
        assert.strictEqual(await A.evaluate(() => triagerName), 'Medic A');
    });
    await test('leaving via Home then triaging again never reuses an ID; both patients visible', async () => {
        await triage(A, 'TST', [true]);            // P3
        await A.evaluate(() => resetToHome());
        await triage(A, 'TST', [false, true]);     // P1 severe bleeding
        const ids = await A.evaluate(() => incidentLog.map(e => e.id));
        assert.strictEqual(new Set(ids).size, 2, ids.join(','));
        assert.match(ids[0], /^[0-9A-Z]{4}-TST-001$/);
        await A.evaluate(() => showLog());
        assert.strictEqual(await A.$$eval('#log-body tr', r => r.length), 2);
    });
    await test('editing the ID on the question screen does not rename the previous patient', async () => {
        const before = await A.evaluate(() => incidentLog.map(e => e.id));
        await A.evaluate(() => { initiateTriage('TST'); editPatientId(); });
        await answerDialog(A, true, 'TAG-777');
        assert.deepStrictEqual(await A.evaluate(() => incidentLog.map(e => e.id)), before);
        await A.evaluate(() => handleAnswer(true));
        assert.strictEqual(await A.evaluate(() => incidentLog[incidentLog.length - 1].id), 'TAG-777');
    });
    await test('TST "not breathing" is recorded as Not Breathing (no time-of-death prompt)', async () => {
        await triage(A, 'TST', [false, false, false, false]);
        const e = await A.evaluate(() => incidentLog[incidentLog.length - 1]);
        assert.strictEqual(e.category, 'NOT_BREATHING');
        assert.strictEqual(await A.evaluate(() => getComputedStyle(document.getElementById('tod-modal')).display), 'none');
        assert.match(await A.textContent('#result-alerts'), /healthcare reassessment/i);
    });
    await test('v0.19.1: TST offers "Child under 2" on the first question only; it gives P1', async () => {
        await A.evaluate(() => initiateTriage('TST'));
        assert.strictEqual(await A.isVisible('#btn-under2'), true);
        await A.evaluate(() => handleAnswer(false));
        assert.strictEqual(await A.isVisible('#btn-under2'), false, 'only on Walking?');
        await A.evaluate(() => stepBack());
        assert.strictEqual(await A.isVisible('#btn-under2'), true);
        await A.click('#btn-under2');
        const e = await A.evaluate(() => incidentLog[incidentLog.length - 1]);
        assert.strictEqual(e.category, 'P1');
        assert.strictEqual(e.reason, 'Child Under 2');
        assert.strictEqual(e.tool, 'TST');
        await A.evaluate(() => { resetToHome(); initiateTriage('MITT'); });
        assert.strictEqual(await A.isVisible('#btn-under2'), false, 'not in MITT');
        await A.evaluate(() => resetToHome());
    });
    await test('MITT wording and outcomes match the NHS card; Dead needs no time of death', async () => {
        await A.evaluate(() => { initiateTriage('MITT'); ['cat_bleed', 'walking', 'breathing', 'voice', 'age', 'rr'].forEach((s, i) => handleAnswer(i >= 2)); });
        assert.strictEqual(await A.textContent('#question-text'), 'Heart rate 100 or more?');
        await A.evaluate(() => handleAnswer(true));
        assert.strictEqual(await A.evaluate(() => incidentLog[incidentLog.length - 1].category), 'P1');
        await A.evaluate(() => { initiateTriage('MITT'); handleAnswer(false); handleAnswer(false); handleAnswer(false); });
        await page_visible(A, '#tod-modal');
        await A.evaluate(() => confirmDeath('none'));
        const e = await A.evaluate(() => incidentLog[incidentLog.length - 1]);
        assert.strictEqual(e.category, 'DEAD');
        assert.match(await A.textContent('#tag-label'), /DECEASED/);
        assert.doesNotMatch(await A.textContent('#result-screen'), /EXPECTANT/);
    });
    await test('"Change last answer" corrects the same record and is audited', async () => {
        await triage(A, 'TST', [true]); // P3 by mistake
        const uid = await A.evaluate(() => currentEntry().uid);
        const n = await A.evaluate(() => incidentLog.length);
        await A.evaluate(() => { changeLastAnswer(); handleAnswer(false); handleAnswer(true); });
        const e = await A.evaluate(u => incidentLog.find(x => x.uid === u), uid);
        assert.strictEqual(e.category, 'P1');
        assert.strictEqual(await A.evaluate(() => incidentLog.length), n);
        assert.ok(await A.evaluate(() => auditLog.some(a => a.action === 'TRIAGE_CORRECTED')));
    });
    await test('re-triage updates the same record and keeps interventions/allergies', async () => {
        await triage(A, 'TST', [false, false, true, false]); // P2
        await A.evaluate(() => { toggleDetails(); document.getElementById('p-allergies').value = 'Penicillin'; markDirty('p-allergies'); commitDirtyFields(); recordIntervention(document.querySelector('[data-type="Tourniquet"]'), 'Tourniquet'); });
        const uid = await A.evaluate(() => currentEntry().uid);
        const n = await A.evaluate(() => incidentLog.length);
        await A.evaluate(() => reTriage());
        await A.evaluate(() => { initiateTriage('TST'); handleAnswer(false); handleAnswer(true); });
        const e = await A.evaluate(u => incidentLog.find(x => x.uid === u), uid);
        assert.strictEqual(await A.evaluate(() => incidentLog.length), n);
        assert.strictEqual(e.category, 'P1');
        assert.strictEqual(e.allergies, 'Penicillin');
        assert.ok(e.interventions.Tourniquet);
        assert.strictEqual(e.triageHistory.length, 2);
    });
    await test('"time of event" resets after one use and never back-dates the next patient', async () => {
        await A.evaluate(() => { toggleDetails(); document.getElementById('time-offset').value = '30'; recordIntervention(document.querySelector('[data-type="Chest Seal"]'), 'Chest Seal'); });
        assert.strictEqual(await A.inputValue('#time-offset'), '0');
        await A.evaluate(() => nextPatient());
        await A.evaluate(() => handleAnswer(true));
        const age = await A.evaluate(() => Date.now() - incidentLog[incidentLog.length - 1].timestamp);
        assert.ok(age < 5000, 'age ' + age);
    });
    await test('typed destination is saved when pressing Next Patient', async () => {
        await A.evaluate(() => toggleDetails());
        await A.fill('#p-evac-dest', 'Royal Infirmary');
        const uid = await A.evaluate(() => currentEntry().uid);
        await A.evaluate(() => nextPatient());
        assert.strictEqual(await A.evaluate(u => incidentLog.find(x => x.uid === u).evacDest, uid), 'Royal Infirmary');
        await A.evaluate(() => resetToHome());
    });
    await test('tabbing through location fields without editing adds no history or audit', async () => {
        await triage(A, 'TST', [false, false, true, true]);
        await A.evaluate(() => toggleDetails());
        const before = await A.evaluate(() => ({ h: currentEntry().locationHistory.length, a: auditLog.length, ts: (currentEntry().currentLocation || {}).timestamp }));
        for (let i = 0; i < 6; i++) { await A.focus('#p-sector'); await A.focus('#p-landmark'); await A.focus('#p-loc-lat'); }
        await A.focus('#p-notes');
        const after = await A.evaluate(() => ({ h: currentEntry().locationHistory.length, a: auditLog.length, ts: (currentEntry().currentLocation || {}).timestamp }));
        assert.deepStrictEqual(after, before);
        await A.fill('#p-landmark', 'Bus stop'); await A.focus('#p-notes');
        assert.strictEqual(await A.evaluate(() => currentEntry().landmark), 'Bus stop');
        assert.strictEqual(await A.evaluate(() => currentEntry().locationHistory.length), before.h + 1);
    });
    await test('a stale GPS position is never stamped on a new patient', async () => {
        await A.evaluate(() => { currentPosition = Object.assign({}, currentPosition || { lat: '53.4', lng: '-2.2', acc: 5 }, { timestamp: Date.now() - 10 * 60 * 1000 }); });
        await triage(A, 'TST', [true]);
        const e = await A.evaluate(() => currentEntry());
        assert.strictEqual(e.currentLocation, null);
    });

    console.log('\ne2e: single-patient handover between two phones');
    const B = await device('B');
    await setup(B, 'Medic B');
    await test('QR with emoji, accents and £ renders and decodes byte-for-byte from the image', async () => {
        await triage(A, 'TST', [false, false, true, false]); // P2
        await A.evaluate(() => { toggleDetails(); addInjuryText('💥 Blast'); document.getElementById('p-demos').value = 'Zoë 35F'; markDirty('p-demos'); document.getElementById('p-allergies').value = 'Latex'; markDirty('p-allergies'); commitDirtyFields(); });
        await A.evaluate(() => generatePatientQR());
        await page_visible(A, '#qr-modal');
        const text = await qrText(A);
        assert.strictEqual(await canvasMatchesModel(A, '#qrcode canvas', text), 'ok');
        const decoded = await decodeCanvas(A, '#qrcode canvas');
        assert.strictEqual(decoded, text);
        const v = await A.evaluate(async t => MITTLib.validatePatientWrapper(JSON.parse(await MITTLib.decodeTransportText(t))), decoded);
        assert.strictEqual(v.meta.integrityOk, true);
        assert.match(v.data.notes, /💥 Blast/);
        assert.strictEqual(v.data.demos, 'Zoë 35F');
    });
    let firstQr;
    await test('receiver previews, accepts, and the sender records the ACK', async () => {
        firstQr = await qrText(A);
        await A.evaluate(() => closeQR());
        await page_visible(A, '#handover-flow-modal');
        await scan(B, firstQr);
        await page_visible(B, '#preview-modal');
        assert.match(await B.textContent('#preview-content'), /New patient/);
        await B.evaluate(() => acceptPreview());
        const ack = await qrText(B);
        assert.match(ack, /MIT_ACK/);
        await B.evaluate(() => closeQR());
        await scan(A, ack);
        await page_visible(A, '#ack-success-modal');
        assert.match(await A.textContent('#ack-success-title'), /Handover accepted/);
        assert.strictEqual(await A.evaluate(() => currentEntry().handoverState), 'accepted');
        await A.evaluate(() => closeAckSuccess());
        const rec = await B.evaluate(() => incidentLog[0]);
        assert.strictEqual(rec.handoverState, 'received');
        assert.strictEqual(rec.allergies, 'Latex');
    });
    await test('sender upgrade P2 -> P1 reaches the receiver even after many receiver edits', async () => {
        await B.evaluate(() => { editEntry(0); for (let i = 0; i < 6; i++) { document.getElementById('p-notes').value += ' x'; markDirty('p-notes'); commitDirtyFields(); } });
        await A.evaluate(async () => { document.getElementById('p-cat-override').value = 'P1'; onCategoryOverride(); await generatePatientQR(); });
        await scan(B, await qrText(A));
        await page_visible(B, '#preview-modal');
        assert.match(await B.textContent('#preview-content'), /category: P2 → P1/);
        await B.evaluate(() => acceptPreview());
        assert.strictEqual(await B.evaluate(() => incidentLog[0].category), 'P1');
        assert.ok(await B.evaluate(() => auditLog.some(a => a.action === 'DETERIORATION')));
        await B.evaluate(() => closeQR());
        await A.evaluate(() => closeQR());
        await A.waitForTimeout(200);
        await A.evaluate(() => closeHandoverFlow());
    });
    await test('a lower incoming category is NOT applied unless the receiver chooses it', async () => {
        await A.evaluate(async () => { closeHandoverFlow(); document.getElementById('p-cat-override').value = 'P3'; onCategoryOverride(); await generatePatientQR(); });
        await scan(B, await qrText(A));
        await page_visible(B, '#preview-modal');
        assert.ok(await B.$('input[name="res-category"][value="local"]:checked'));
        await B.evaluate(() => acceptPreview());
        const r = await B.evaluate(() => incidentLog[0]);
        assert.strictEqual(r.category, 'P1');
        assert.ok(await B.evaluate(() => auditLog.some(a => a.action === 'IMPORT_DECISION' && /kept "P1"/.test(a.details))));
        await B.evaluate(() => closeQR());
    });
    await test('ACK for an older QR warns the sender that the receiver is out of date', async () => {
        const staleAck = await B.evaluate(() => MITTLib.toAsciiJSON(MITTLib.buildAckPayload(incidentLog[0].id, 'Medic B', { uid: incidentLog[0].uid, payloadHash: '00000000', recordVersion: 1 })));
        await A.evaluate(() => closeQR());
        await A.waitForTimeout(200);
        await A.evaluate(() => closeHandoverFlow());
        await scan(A, staleAck);
        await page_visible(A, '#ack-success-modal');
        assert.match(await A.textContent('#ack-success-title'), /older version/i);
        assert.strictEqual(await A.evaluate(() => currentEntry().handoverState), 'accepted-outdated');
        await A.evaluate(() => closeAckSuccess());
    });
    await test('ACK for an unknown patient is not recorded as a handover', async () => {
        await scan(A, JSON.stringify({ t: 'MIT_ACK', v: 1, pid: 'NOPE-1', rcv: 'X', g: Date.now() }));
        await page_visible(A, '#ack-success-modal');
        assert.match(await A.textContent('#ack-success-title'), /Not recorded/);
        await A.evaluate(() => closeAckSuccess());
    });
    await test('same ID but a different patient is imported under a new ID, never merged', async () => {
        const txt = await B.evaluate(() => MITTLib.toAsciiJSON(MITTLib.buildPatientPayload({ id: incidentLog[0].id, uid: 'someone-else', deviceId: 'ZZZZ', category: 'P3', demos: '80M' }, {}, { sender: 'Other' })));
        await scan(B, txt);
        await page_visible(B, '#preview-modal');
        assert.match(await B.textContent('#preview-content'), /DIFFERENT patient/);
        await B.evaluate(() => acceptPreview());
        const recs = await B.evaluate(() => incidentLog.map(e => [e.id, e.category]));
        assert.strictEqual(recs.length, 2);
        assert.ok(recs[1][0].endsWith('~ZZZZ'));
        assert.strictEqual(recs[0][1], 'P1');
        await B.evaluate(() => closeQR());
    });
    await test('"hand over to colleague" keeps notes, does not mark evacuated', async () => {
        await A.waitForTimeout(200);
        await A.evaluate(() => { document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; }); scanMode = 'HANDOVER'; });
        await scan(A, JSON.stringify({ t: 'MIT_USER', v: 2, name: 'Dr C', role: 'HCP' }));
        await answerDialog(A, false);
        await A.evaluate(() => { if (!document.getElementById('details-container').classList.contains('show')) toggleDetails(); });
        await A.fill('#p-allergies', 'Latex; Nuts'); await A.focus('#p-notes');
        const e = await A.evaluate(() => currentEntry());
        assert.strictEqual(e.handoverTo, 'Dr C');
        assert.strictEqual(e.evacuated, false);
        assert.match(e.notes, /Blast/);
    });

    console.log('\ne2e: multi-patient transfer');
    await test('50-patient transfer: compressed QR parts, any order, duplicates ignored, confirmed back to sender', async () => {
        await A.evaluate(() => {
            for (let i = 0; i < 50; i++) {
                initiateTriage('TST'); handleAnswer(false); handleAnswer(false); handleAnswer(true); handleAnswer(i % 2 === 0);
                currentEntry().notes = 'Blast injury to legs, lacerations, Zoë ' + i; currentEntry().sector = i % 3 ? 'Inner Cordon' : 'CCS';
            }
            resetToHome();
        });
        await A.evaluate(() => openAllPatientsTransfer());
        await A.evaluate(() => startAllPatientsQrTransfer());
        await page_visible(A, '#all-transfer-modal');
        const parts = await A.evaluate(() => transferQrTexts());
        const n = await A.evaluate(() => _allTransfer.payload.n);
        assert.ok(parts.length > 1 && parts.length < n, `parts ${parts.length} for ${n} patients`);
        // The displayed QR image must be drawn exactly (every module, quiet zone) for the first part.
        assert.strictEqual(await canvasMatchesModel(A, '#all-transfer-qrcode canvas', parts[0]), 'ok');
        assert.ok(parts.every(t => t.length <= 800), 'parts within size: ' + Math.max(...parts.map(t => t.length)));
        const order = parts.slice().reverse();
        order.splice(1, 0, parts[parts.length - 1]); // duplicate
        for (const p of order) { await B.evaluate(t => { _scanLastCode = null; return onScanSuccess(t); }, p); }
        await page_visible(B, '#bulk-receive-modal');
        await B.evaluate(() => acceptBulkPreview());
        assert.ok(await B.evaluate(n => incidentLog.length >= n, n));
        const tack = await qrText(B);
        assert.match(tack, /MIT_TACK/);
        await B.evaluate(() => closeQR());
        await scan(A, tack);
        await page_visible(A, '#ack-success-modal');
        assert.match(await A.textContent('#ack-success-title'), /Transfer confirmed/);
        await A.evaluate(() => closeAckSuccess());
        // Re-importing the same transfer creates nothing new.
        const before = await B.evaluate(() => incidentLog.length);
        await A.evaluate(() => { openAllPatientsTransfer(); return startAllPatientsQrTransfer(); });
        for (const p of await A.evaluate(() => transferQrTexts())) await B.evaluate(t => { _scanLastCode = null; return onScanSuccess(t); }, p);
        await page_visible(B, '#bulk-receive-modal');
        await B.evaluate(() => acceptBulkPreview());
        assert.strictEqual(await B.evaluate(() => incidentLog.length), before);
        await B.evaluate(() => closeQR());
        await A.evaluate(() => closeAllTransferModal());
    });
    await test('transfer file export/import round trip', async () => {
        await A.evaluate(() => openAllPatientsTransfer({ type: 'sector', sector: 'CCS' }));
        const [dl] = await Promise.all([A.waitForEvent('download'), A.evaluate(() => exportAllPatientsFile())]);
        const file = await dl.path();
        const txt = fs.readFileSync(file, 'utf8');
        assert.match(txt, /"t":"MIT_ALL"/);
        await A.evaluate(() => closeAllPreflightModal());
        const C = await device('C');
        await setup(C, 'Medic C');
        await C.setInputFiles('#all-transfer-file-input', file);
        await page_visible(C, '#bulk-receive-modal');
        await C.evaluate(() => acceptBulkPreview());
        assert.ok(await C.evaluate(() => incidentLog.length > 5 && incidentLog.every(e => e.sector === 'CCS')));
        await C._ctx.close();
    });

    console.log('\ne2e: persistence, audit and exports');
    await test('data and a verifiable audit chain survive a reload', async () => {
        const n = await A.evaluate(() => incidentLog.length);
        await A.waitForTimeout(300);
        await A.reload();
        await A.waitForFunction(() => dbReady === true);
        assert.strictEqual(await A.evaluate(() => incidentLog.length), n);
        const v = await A.evaluate(() => MITTLib.verifyAuditChain(auditLog));
        assert.strictEqual(v.ok, true, v.reason);
        assert.ok(await A.evaluate(() => auditLog.some(a => a.action === 'FIELD_UPDATED' && /Allergies/.test(a.details))));
        assert.ok(await A.evaluate(() => auditLog.some(a => a.action === 'USER_SESSION_START')));
    });
    await test('a tampered audit entry is detected on start-up', async () => {
        await A.evaluate(() => { auditLog[3].details = 'edited'; saveState(); });
        await A.waitForTimeout(300);
        await A.reload();
        await A.waitForFunction(() => dbReady === true);
        await page_visible(A, '#confirm-modal');
        assert.match(await A.textContent('#confirm-title'), /integrity/i);
        await A.click('#confirm-ok');
    });
    await test('CSV exports: ISO timestamps, formula guard, UTF-8', async () => {
        await A.evaluate(() => { editEntry(0); toggleDetails(); document.getElementById('p-notes').value = '=HYPERLINK("http://x")'; markDirty('p-notes'); commitDirtyFields(); });
        const [d1] = await Promise.all([A.waitForEvent('download'), A.evaluate(() => downloadCSV('SNAPSHOT'))]);
        const reg = fs.readFileSync(await d1.path(), 'utf8');
        assert.ok(reg.charCodeAt(0) === 0xFEFF);
        assert.match(reg, /"'=HYPERLINK/);
        assert.match(reg, /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d/);
        const [d2] = await Promise.all([A.waitForEvent('download'), A.evaluate(() => downloadCSV('AUDIT'))]);
        const aud = fs.readFileSync(await d2.path(), 'utf8');
        assert.match(aud.split('\n')[0], /Prev_Hash,.*Hash/);
    });
    await test('legacy data is migrated: TST DEAD -> Not Breathing, duplicate IDs kept and flagged, audit sealed', async () => {
        const L = await device('L');
        await L.evaluate(() => new Promise(res => {
            const tx = db.transaction('logs', 'readwrite');
            tx.objectStore('logs').put([{ id: 'TST-001', tool: 'TST', category: 'DEAD', reason: 'Apnoeic', timestamp: 1 }, { id: 'TST-002', tool: 'TST', category: 'P3', timestamp: 2 }, { id: 'TST-002', tool: 'TST', category: 'P1', timestamp: 3 }], 'incidentLog');
            tx.objectStore('logs').put([{ sysTime: 1, action: 'TRIAGE_COMPLETE', patientId: 'TST-001', user: 'old' }], 'auditLog');
            tx.oncomplete = res;
        }));
        await L.reload();
        await L.waitForFunction(() => dbReady === true);
        const r = await L.evaluate(() => ({ cats: incidentLog.map(e => e.category), dup: auditLog.some(a => a.action === 'DUPLICATE_ID_FOUND'), v: MITTLib.verifyAuditChain(auditLog).ok, sealed: auditLog[0].legacyUnsealed === true }));
        assert.deepStrictEqual(r.cats, ['NOT_BREATHING', 'P3', 'P1']);
        assert.ok(r.dup && r.v && r.sealed);
        await L._ctx.close();
    });
    await test('if IndexedDB is unavailable the user is warned and data is kept in backup storage', async () => {
        const F = await device('F', { initScript: () => { Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('blocked for test'); } } }); } });
        assert.ok(await F.isVisible('#storage-banner'));
        await setup(F, 'Medic F');
        await triage(F, 'TST', [true]);
        await F.waitForTimeout(200);
        await F.reload();
        await F.waitForFunction(() => dbReady === true);
        assert.strictEqual(await F.evaluate(() => incidentLog.length), 1);
        await F._ctx.close();
    });
    await test('reset requires an archive, keeps a wipe record, and restarts the chain citing the old head', async () => {
        const [dl] = await Promise.all([A.waitForEvent('download'), A.evaluate(() => { clearAllData(); }).then(() => answerDialog(A, true))]);
        assert.match(fs.readFileSync(await dl.path(), 'utf8'), /MITT_ARCHIVE/);
        await answerDialog(A, true);
        await answerDialog(A, true, 'DELETE');
        await A.waitForTimeout(1200);
        await A.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true);
        const s = await A.evaluate(() => ({ n: incidentLog.length, w: wipeHistory.length, first: auditLog[0].action, v: MITTLib.verifyAuditChain(auditLog).ok }));
        assert.strictEqual(s.n, 0); assert.strictEqual(s.w, 1); assert.strictEqual(s.first, 'DATA_WIPE'); assert.ok(s.v);
    });
    await test('the Android back button closes dialogs and never leaves the app', async () => {
        await A.evaluate(() => openModesMenu());
        await A.goBack();
        await A.waitForTimeout(200);
        assert.strictEqual(await A.evaluate(() => getComputedStyle(document.getElementById('modes-modal')).display), 'none');
        assert.ok(A.url().endsWith('index.html'));
        await A.goBack(); await A.waitForTimeout(200);
        assert.ok(A.url().endsWith('index.html'));
    });
    console.log('\ne2e: second-round bug fixes');
    const R = await device('R');
    await setup(R, 'Medic R');
    await test('leaving a "Change last answer" half-way never overwrites another patient', async () => {
        await triage(R, 'TST', [true]); // P3
        const first = await R.evaluate(() => currentEntry().uid);
        await R.evaluate(() => { changeLastAnswer(); resetToHome(); });
        await triage(R, 'TST', [false, true]); // new patient, P1
        const recs = await R.evaluate(() => incidentLog.map(e => [e.uid, e.category]));
        assert.strictEqual(recs.length, 2);
        assert.strictEqual(recs.find(r => r[0] === first)[1], 'P3');
    });
    await test('re-triage resets the reassessment clock', async () => {
        await R.evaluate(() => { const e = currentEntry(); e.timestamp -= 60 * 60 * 1000; e.lastReassessed = null; });
        assert.strictEqual(await R.evaluate(() => MITTLib.reassessmentStatus(currentEntry(), Date.now(), reassessIntervals).state), 'overdue');
        await R.evaluate(() => { reTriage(); initiateTriage('TST'); handleAnswer(false); handleAnswer(true); });
        assert.notStrictEqual(await R.evaluate(() => MITTLib.reassessmentStatus(currentEntry(), Date.now(), reassessIntervals).state), 'overdue');
    });
    await test('"Next patient" after opening an imported/MITT record uses the triager\'s own tool', async () => {
        const N = await device('N');
        await setup(N, 'PC Smith', 'NON_HCP');
        await N.evaluate(() => { incidentLog.push({ id: 'X-1', uid: 'x1', category: 'P2', tool: 'MITT', triageHistory: [], interventions: {}, fts: {} }); editEntry(incidentLog.length - 1); nextPatient(); });
        assert.strictEqual(await N.evaluate(() => currentTool), 'TST');
        await N._ctx.close();
    });
    await test('accepting a transfer never switches the receiver to another screen', async () => {
        await R.evaluate(() => { editEntry(0); resetToHome(); });
        const t = await R.evaluate(() => MITTLib.toAsciiJSON(MITTLib.buildAllPatientsPayload([{ id: 'ZZ-1', uid: 'zz1', category: 'P2' }], {}, { sender: 'Other' })));
        await scan(R, t);
        await page_visible(R, '#bulk-receive-modal');
        await R.evaluate(() => acceptBulkPreview());
        assert.ok(await R.evaluate(() => document.getElementById('home-screen').classList.contains('active')));
        await R.evaluate(() => closeQR());
    });
    await test('the patient timeline keeps events recorded before an ID change', async () => {
        await R.evaluate(() => { editEntry(0); recordIntervention(document.querySelector('[data-type="Oxygen"]'), 'Oxygen'); });
        const p = R.evaluate(() => editPatientId(true));
        await answerDialog(R, true, 'RENAMED-1'); await p;
        await R.evaluate(() => openTimelineForCurrent());
        const labels = await R.evaluate(() => Array.from(document.querySelectorAll('#timeline-list .tl-label')).map(x => x.textContent));
        assert.ok(labels.some(l => /Id Change/i.test(l)), labels.join(' | '));
        assert.ok(labels.some(l => /Retriage Started|Re-triage|Triage/i.test(l)));
        await R.evaluate(() => closeTimelineModal());
    });
    await test('a second copy of the app open on the same phone is detected and warned about', async () => {
        const second = await R._ctx.newPage();
        await second.goto(url);
        await second.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true);
        await second.waitForTimeout(300);
        assert.match(await second.textContent('#storage-banner'), /open in another tab/);
        assert.match(await R.textContent('#storage-banner'), /open in another tab/);
        await second.close();
    });
    await R._ctx.close();

    console.log('\ne2e: full-check fixes');
    await test('scanning the same ACK twice still says "accepted"; a real change after the QR is still caught', async () => {
        const S = await device('Sender'), R = await device('Receiver');
        await setup(S, 'Medic S'); await setup(R, 'Medic R');
        await triage(S, 'TST', [false, true]);
        await S.evaluate(() => { const e = currentEntry(); e.notes = 'Leg wound'; saveState(); return generatePatientQR(); });
        await scan(R, await qrText(S));
        await page_visible(R, '#preview-modal');
        await R.evaluate(() => acceptPreview());
        const ack = await qrText(R);
        await S.evaluate(() => closeQR());
        for (let i = 0; i < 2; i++) {
            await S.evaluate(() => { closeHandoverFlow(); closeAckSuccess(); _scanLastCode = null; });
            await scan(S, ack);
            await page_visible(S, '#ack-success-modal');
            assert.match(await S.textContent('#ack-success-title'), /Handover accepted/, 'scan ' + (i + 1));
            assert.strictEqual(await S.evaluate(() => currentEntry().handoverState), 'accepted');
        }
        await S.evaluate(() => { closeAckSuccess(); document.getElementById('p-allergies').value = 'Latex'; markDirty('p-allergies'); commitDirtyFields(); _scanLastCode = null; });
        await scan(S, ack);
        await page_visible(S, '#ack-success-modal');
        assert.match(await S.textContent('#ack-success-title'), /older version/i);
        await S._ctx.close(); await R._ctx.close();
    });
    await test('"Paste" opened from inside the scanner appears on top of it', async () => {
        const P = await device('Paste');
        await setup(P, 'Medic P');
        const onTop = await P.evaluate(() => {
            document.getElementById('scanner-modal').style.display = 'flex';
            openPasteCode();
            const r = document.getElementById('paste-input').getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!(hit && hit.closest('#paste-modal'));
        });
        assert.ok(onTop);
        await P._ctx.close();
    });
    await test('closing an incident also removes any copy of patients in backup browser storage', async () => {
        const Z = await device('Reset');
        await setup(Z, 'Medic Z');
        await triage(Z, 'TST', [true]);
        await Z.evaluate(() => localStorage.setItem(FALLBACK_KEY, JSON.stringify({ incidentLog: [{ id: 'OLD-1', uid: 'x', category: 'P1' }] })));
        const [dl] = await Promise.all([Z.waitForEvent('download'), Z.evaluate(() => { clearAllData(); }).then(() => answerDialog(Z, true))]);
        assert.ok(await dl.path());
        await answerDialog(Z, true);
        await answerDialog(Z, true, 'DELETE');
        await Z.waitForTimeout(1200);
        await Z.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true);
        assert.strictEqual(await Z.evaluate(() => localStorage.getItem(FALLBACK_KEY)), null);
        assert.strictEqual(await Z.evaluate(() => incidentLog.length), 0);
        await Z._ctx.close();
    });
    await test('on a 320-390 px phone every dashboard counter stays on one line', async () => {
        for (const width of [320, 360, 390]) {
            const D = await device('Dash ' + width, { viewport: { width, height: 700 }, isMobile: true, hasTouch: true });
            await setup(D, 'Medic D');
            await D.evaluate(() => { for (let i = 0; i < 12; i++) { initiateTriage('TST'); handleAnswer(i % 2 === 0); } resetToHome(); updateDashboard(); });
            const tall = await D.evaluate(() => Array.from(document.querySelectorAll('#global-dashboard .dash-num, #global-dashboard .dash-label'))
                .filter(e => e.offsetParent !== null && e.getBoundingClientRect().height > parseFloat(getComputedStyle(e).fontSize) * 1.6).map(e => e.id || e.textContent));
            assert.deepStrictEqual(tall, [], 'width ' + width);
            await D._ctx.close();
        }
    });
    await test('a dialog taller than the screen (gloved mode, small phone) can be scrolled to its top', async () => {
        const G = await device('Gloved', { viewport: { width: 320, height: 480 }, isMobile: true, hasTouch: true });
        await setup(G, 'Medic G');
        const top = await G.evaluate(() => {
            document.body.classList.add('gloved');
            const m = document.getElementById('tod-modal'); m.style.display = 'flex'; m.scrollTop = 0;
            return m.querySelector('.modal-box').getBoundingClientRect().top;
        });
        assert.ok(top >= 0, 'dialog top at ' + top);
        await G._ctx.close();
    });
    await test('text boxes are limited to what a receiving device keeps in full', async () => {
        const T = await device('Limits');
        const lim = await T.evaluate(() => ({ a: $('p-allergies').maxLength, n: $('p-notes').maxLength, d: $('p-demos').maxLength, id: $('manual-id-input').maxLength, L: MITTLib.FIELD_INPUT_LIMITS }));
        assert.strictEqual(lim.a, lim.L.allergies); assert.strictEqual(lim.n, lim.L.notes); assert.strictEqual(lim.d, lim.L.demos); assert.strictEqual(lim.id, lim.L.id);
        await T._ctx.close();
    });
    await test('editing a location label keeps a location confidence value that is not in the menu', async () => {
        const C = await device('Confidence');
        await setup(C, 'Medic C');
        await triage(C, 'TST', [true]);
        const conf = await C.evaluate(() => {
            const e = currentEntry(); e.locationConfidence = 'imported-other'; renderResultScreen(e);
            const f = document.getElementById('p-landmark'); f.value = 'Bus stop'; f.dispatchEvent(new Event('change'));
            return [e.locationConfidence, e.landmark];
        });
        assert.deepStrictEqual(conf, ['imported-other', 'Bus stop']);
        await C._ctx.close();
    });

    console.log('\ne2e: usable in seconds (first use, training, incident code, handover guidance)');
    await test('first launch needs only a name and a tap on a role; options stay tucked away', async () => {
        const F = await device('First use', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
        assert.strictEqual(await F.evaluate(() => document.getElementById('intro-options').open), false);
        await F.fill('#intro-triager', 'Medic F');
        await F.click('#btn-role-responder');
        assert.ok(await F.evaluate(() => document.getElementById('home-screen').classList.contains('active')));
        assert.strictEqual(await F.evaluate(() => userRole), 'NON_HCP');
        await F._ctx.close();
    });
    await test('home screen: START TRIAGE is the first, biggest button and starts TST; the rest is under "More"', async () => {
        const H = await device('Home', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
        await setup(H, 'Medic H');
        const layout = await H.evaluate(() => {
            const start = document.getElementById('btn-start-triage').getBoundingClientRect();
            const btns = Array.from(document.querySelectorAll('#home-screen button')).filter(b => b.offsetParent !== null);
            return { first: btns[0].id, startH: start.height, maxOtherH: Math.max(...btns.slice(1).map(b => b.getBoundingClientRect().height)), moreOpen: document.getElementById('home-more').open, top: start.top };
        });
        assert.strictEqual(layout.first, 'btn-start-triage');
        assert.ok(layout.startH > layout.maxOtherH, JSON.stringify(layout));
        assert.strictEqual(layout.moreOpen, false);
        await H.click('#btn-start-triage');
        assert.ok(await H.evaluate(() => document.getElementById('question-screen').classList.contains('active') && currentTool === 'TST'));
        await H._ctx.close();
    });
    await test('v0.17.1: one intended-purpose statement on the start screen, footer and Settings', async () => {
        const IP = await device('Purpose', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
        assert.match(await IP.textContent('.intro-purpose'), /Training and exercise use only\. Not for use with real patients\./);
        assert.ok(await IP.isVisible('.intro-purpose'));
        assert.match(await IP.textContent('footer'), /Training & exercise use only/);
        const fits = await IP.evaluate(() => { const m = document.querySelector('main'); return m.scrollHeight <= m.clientHeight + 2; });
        assert.ok(fits, 'start screen still fits');
        await IP._ctx.close();
    });
    await test('v0.17.0 back to basics: Hand over is visible on home and result, More holds the patient details, setup is in Settings, a double tap answers once', async () => {
        const B = await device('Basics', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        await setup(B, 'Medic B');
        assert.ok(await B.isVisible('#btn-home-handover'));
        assert.strictEqual(await B.evaluate(() => document.querySelector('#home-more').textContent.includes('Clear everything')), false, 'clearing lives in Settings');
        await B.evaluate(() => initiateTriage('TST'));
        await B.evaluate(() => { answerTap(false); answerTap(true); });   // second tap inside 0.4 s is ignored
        assert.strictEqual(await B.evaluate(() => document.getElementById('question-screen').dataset.stepId), 'bleeding');
        await B.evaluate(() => { _lastAnswerTap = 0; answerTap(true); });  // severe bleeding: P1
        assert.ok(await B.isVisible('#btn-handover'));
        const fits = await B.evaluate(() => { const m = document.querySelector('main'); const h = document.getElementById('btn-handover').getBoundingClientRect(); return m.scrollHeight <= m.clientHeight + 2 && h.bottom <= innerHeight; });
        assert.ok(fits, 'result fits without scrolling');
        assert.strictEqual(await B.isVisible('#sec-interventions'), false);
        await B.click('#btn-patient-more');
        assert.ok(await B.isVisible('#sec-interventions'));
        assert.match(await B.textContent('#pm-id'), /TST-001/);
        await B.evaluate(() => nextPatient());
        assert.strictEqual(await B.isVisible('#patient-more'), false, 'panel closes when leaving the patient');
        await B.evaluate(() => { resetToHome(); openModesMenu(); });
        assert.match(await B.textContent('#set-you-sum'), /Medic B · Clinician/);
        assert.ok(await B.isVisible('text=Change name or role'));
        await B._ctx.close();
    });
    await test('on a small phone (375x667 and 360x740) YES and NO are fully on screen for every TST and MITT question', async () => {
        for (const vp of [{ width: 375, height: 667 }, { width: 360, height: 740 }]) {
            const S = await device('Small ' + vp.width, { viewport: vp, isMobile: true, hasTouch: true });
            await setup(S, 'Medic S');
            for (const [tool, answers] of [['TST', [false, false, true, false]], ['MITT', [false, false, true, true, true, true, false]]]) {
                await S.evaluate(t => initiateTriage(t), tool);
                for (const ans of answers) {
                    const r = await S.evaluate(() => {
                        const box = sel => document.querySelector(sel).getBoundingClientRect();
                        const y = box('#question-screen .btn-yes'), n = box('#question-screen .btn-no'), q = box('#question-text');
                        return { step: document.getElementById('question-screen').dataset.stepId, ok: y.top >= 0 && n.top >= 0 && y.bottom <= innerHeight && n.bottom <= innerHeight && q.top >= 0, header: document.querySelector('header').getBoundingClientRect().height };
                    });
                    assert.ok(r.ok, `${vp.width}x${vp.height} ${tool}:${r.step} ` + JSON.stringify(r));
                    assert.ok(r.header < 80, 'header stays on one row: ' + r.header);
                    await S.evaluate(a => handleAnswer(a), ans);
                }
            }
            await S._ctx.close();
        }
    });
    await test('MITT counting help suggests the answer from a typed or counted rate, and the measured rate is kept with the result', async () => {
        const M = await device('Count');
        await setup(M, 'Medic C');
        await M.evaluate(() => { initiateTriage('MITT'); [false, false, true, true, true].forEach(a => handleAnswer(a)); });
        assert.strictEqual(await M.evaluate(() => document.getElementById('question-screen').dataset.stepId), 'rr');
        assert.ok(await M.isVisible('#q-count'));
        await M.fill('#q-count-input', '28');
        assert.match(await M.textContent('#q-count-result'), /RR 28\/min.*suggests NO/);
        await M.fill('#q-count-input', '16');
        assert.match(await M.textContent('#q-count-result'), /suggests YES/);
        await M.evaluate(() => handleAnswer(true));
        assert.ok(await M.isVisible('#q-count'));
        await M.fill('#q-count-input', '96');
        assert.match(await M.textContent('#q-count-result'), /HR 96\/min.*suggests NO/);
        await M.evaluate(() => handleAnswer(false));
        const e = await M.evaluate(() => currentEntry());
        assert.strictEqual(e.category, 'P2');
        assert.match(e.action, /Measured: RR 16\/min, HR 96\/min\./);
        // Not shown on questions without counting.
        await M.evaluate(() => initiateTriage('TST'));
        assert.strictEqual(await M.isVisible('#q-count'), false);
        await M._ctx.close();
    });
    await test('"MITT this patient now" re-triages the same TST record with MITT; TST handover needs no extra confirmation', async () => {
        const T = await device('MITT now');
        await setup(T, 'Medic N');
        await triage(T, 'TST', [false, false, true, false]);
        assert.ok(await T.isVisible('#btn-mitt-now'));
        assert.match(await T.textContent('#action-box'), /Reassess with MITT as soon as possible/);
        const uid = await T.evaluate(() => currentEntry().uid);
        await T.click('#btn-mitt-now');
        assert.strictEqual(await T.evaluate(() => currentTool), 'MITT');
        await T.evaluate(() => [false, false, true, true, true, true, true].forEach(a => handleAnswer(a)));
        const e = await T.evaluate(() => ({ n: incidentLog.length, uid: currentEntry().uid, cat: currentEntry().category, tool: currentEntry().tool, hist: currentEntry().triageHistory.length }));
        assert.deepStrictEqual(e, { n: 1, uid, cat: 'P1', tool: 'MITT', hist: 2 });
        assert.strictEqual(await T.isVisible('#btn-mitt-now'), false);
        await triage(T, 'TST', [true]);
        await T.evaluate(() => generatePatientQR());
        await page_visible(T, '#qr-modal');
        assert.strictEqual(await T.isVisible('#confirm-modal'), false);
        await T._ctx.close();
    });
    await test('non-clinical users get a simpler result screen and a readable role label', async () => {
        const P = await device('Police');
        await setup(P, 'PC Jones', 'NON_HCP');
        assert.strictEqual(await P.textContent('#header-role'), 'Non-clinical');
        assert.strictEqual(await P.evaluate(() => getComputedStyle(document.getElementById('header-role')).color), 'rgb(255, 255, 255)');
        await triage(P, 'TST', [false, true]);
        // Non-clinical users may record a reassessment check (Jake, 17 Oct 2026); the clinical-only actions stay hidden.
        assert.ok(await P.evaluate(() => document.getElementById('btn-reassess').getClientRects().length > 0), '#btn-reassess should be visible to non-clinical users');
        for (const sel of ['#btn-atmist', '#btn-mitt-now', '.int-btn[data-type="TXA"]', '.int-btn[data-type="Needle Decomp"]', '.int-btn[data-type="IO Access"]']) {
            assert.strictEqual(await P.evaluate(s => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }, sel), false, sel + ' should be hidden');
        }
        assert.ok(await P.evaluate(() => { openPatientMore(); document.getElementById('sec-interventions').open = true; return document.querySelector('.int-btn[data-type="Tourniquet"]').getClientRects().length > 0; }));
        await P._ctx.close();
    });
    await test('each question shows its number, and "Not sure?" always points to the more urgent answer', async () => {
        const Q = await device('Questions');
        await setup(Q, 'Medic Q');
        await Q.evaluate(() => initiateTriage('TST'));
        assert.match(await Q.textContent('#q-progress'), /Question 1 of up to 4/);
        await Q.evaluate(() => handleAnswer(false));
        assert.match(await Q.textContent('#q-progress'), /Question 2 of up to 4/);
        assert.match(await Q.textContent('#q-unsure'), /Tap YES/);
        // For every question, the "unsure" answer must lead to an outcome at least as urgent as the other answer.
        const bad = await Q.evaluate(() => {
            const rank = { P1: 0, P2: 1, P3: 2, NOT_BREATHING: 3, DEAD: 4 };
            const out = [];
            [['TST', tstFlow], ['MITT', mittFlow]].forEach(([tool, flow]) => {
                const best = (stepId, ans) => { const o = outcomeFor(tool, stepId, ans); return o.type === 'result' ? rank[o.category] : Math.min(best(o.step, true), best(o.step, false)); };
                flow.forEach(st => { const safe = best(st.id, st.unsure === 'YES'), other = best(st.id, st.unsure !== 'YES'); if (safe > other) out.push(`${tool}:${st.id}`); });
            });
            return out;
        });
        assert.deepStrictEqual(bad, []);
        await Q._ctx.close();
    });
    await test('training mode: separate records, orange banner, TRAIN- IDs, labelled exports; real records untouched', async () => {
        const T = await device('Training');
        await setup(T, 'Medic T');
        await triage(T, 'TST', [true]);
        const realUid = await T.evaluate(() => currentEntry().uid);
        await T.evaluate(() => { resetToHome(); toggleTrainingMode(true); });
        await answerDialog(T, true);
        await T.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true && TRAINING === true, null, { timeout: 10000 });
        assert.ok(await T.isVisible('.training-banner'));
        assert.strictEqual(await T.evaluate(() => incidentLog.length), 0);
        // The user and role carry over, so training opens straight on the home screen.
        assert.ok(await T.evaluate(() => document.getElementById('home-screen').classList.contains('active') && triagerName === 'Medic T'));
        await triage(T, 'TST', [true]);
        assert.match(await T.evaluate(() => currentEntry().id), /^TRAIN-/);
        let dlName = '';
        const [dl] = await Promise.all([T.waitForEvent('download'), T.evaluate(() => downloadCSV('SNAPSHOT'))]);
        dlName = dl.suggestedFilename();
        assert.match(dlName, /^MITT_TRAINING_/);
        T._trainingQr = await T.evaluate(async () => { currentEntry().notes = 'practice'; await generatePatientQR(); return document.getElementById('qr-modal').dataset.qrText; });
        await T.evaluate(() => { closeQR(); closeHandoverFlow(); toggleTrainingMode(false); });
        await answerDialog(T, true);
        await T.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true && TRAINING === false, null, { timeout: 10000 });
        assert.strictEqual(await T.isVisible('.training-banner'), false);
        const ids = await T.evaluate(() => incidentLog.map(e => e.uid + '|' + e.id));
        assert.strictEqual(ids.length, 1);
        assert.ok(ids[0].startsWith(realUid) && !/TRAIN-/.test(ids[0]));
        assert.ok(await T.evaluate(() => auditLog.some(a => a.action === 'TRAINING_MODE_ON') && auditLog.some(a => a.action === 'TRAINING_MODE_OFF')));
        // A real-mode phone refuses the training QR.
        await scan(T, T._trainingQr);
        await page_visible(T, '#confirm-modal');
        assert.match(await T.textContent('#confirm-title'), /TRAINING code/);
        await T.evaluate(() => resolveConfirm(true));
        assert.strictEqual(await T.evaluate(() => incidentLog.length), 1);
        await T._ctx.close();
    });
    await test('a training-mode phone refuses real patient codes, and "Delete all training data" empties only the practice log', async () => {
        const R2 = await device('Real sender'); const T2 = await device('Training receiver', { initScript: 'localStorage.setItem("mit_training", "1");' });
        await setup(R2, 'Medic R'); await setup(T2, 'Medic T');
        await triage(R2, 'TST', [false, true]);
        const realQr = await R2.evaluate(async () => { currentEntry().notes = 'real'; await generatePatientQR(); return document.getElementById('qr-modal').dataset.qrText; });
        await scan(T2, realQr);
        await page_visible(T2, '#confirm-modal');
        assert.match(await T2.textContent('#confirm-title'), /REAL patient code/);
        await T2.evaluate(() => resolveConfirm(true));
        await triage(T2, 'TST', [true]);
        assert.strictEqual(await T2.evaluate(() => incidentLog.length), 1);
        await T2.evaluate(() => { clearTrainingData(); });
        await answerDialog(T2, true);
        await T2.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 10000 });
        assert.strictEqual(await T2.evaluate(() => incidentLog.length), 0);
        await R2._ctx.close(); await T2._ctx.close();
    });
    await test('incident code: set once on the start screen, stamped on records, exports and file names; a patient from another incident is flagged', async () => {
        const I1 = await device('Incident A'), I2 = await device('Incident B');
        await I1.evaluate(() => { document.getElementById('intro-options').open = true; });
        await I1.fill('#intro-incident-code', 'mcr 0926!');
        await setup(I1, 'Medic A');
        assert.strictEqual(await I1.evaluate(() => incidentCode), 'MCR0926');
        assert.match(await I1.textContent('#header-incident'), /Incident MCR0926/);
        await triage(I1, 'TST', [true]);
        assert.strictEqual(await I1.evaluate(() => currentEntry().incidentCode), 'MCR0926');
        const [dl] = await Promise.all([I1.waitForEvent('download'), I1.evaluate(() => downloadCSV('SNAPSHOT'))]);
        assert.match(dl.suggestedFilename(), /^MITT_MCR0926_casualty_register_/);
        const csv = fs.readFileSync(await dl.path(), 'utf8');
        assert.match(csv.split('\n')[0], /Incident_Code/);
        assert.match(csv.split('\n')[1], /"MCR0926"/);
        await I2.evaluate(() => { document.getElementById('intro-options').open = true; });
        await I2.fill('#intro-incident-code', 'LDN-1');
        await setup(I2, 'Medic B');
        const qr = await I1.evaluate(async () => { currentEntry().notes = 'x'; await generatePatientQR(); return document.getElementById('qr-modal').dataset.qrText; });
        await scan(I2, qr);
        await page_visible(I2, '#preview-modal');
        assert.match(await I2.textContent('#preview-warn'), /incident MCR0926.*incident LDN-1/);
        assert.ok(await I1.evaluate(() => auditLog.some(a => a.action === 'INCIDENT_CODE_SET')));
        await I1._ctx.close(); await I2._ctx.close();
    });
    await test('guided handover: both phones show numbered steps, and the sender is led to the final scan', async () => {
        const S = await device('Guide sender'), R = await device('Guide receiver');
        await setup(S, 'Medic S'); await setup(R, 'Medic R');
        await triage(S, 'TST', [false, true]);
        await S.evaluate(async () => { currentEntry().notes = 'guided'; await generatePatientQR(); });
        const steps = await S.evaluate(() => Array.from(document.querySelectorAll('#qr-steps li')).map(li => li.className + ':' + li.textContent));
        assert.strictEqual(steps.length, 3);
        assert.match(steps[0], /^now:.*Receive patient/);
        await scan(R, await qrText(S));
        await page_visible(R, '#preview-modal');
        await R.evaluate(() => acceptPreview());
        const rsteps = await R.evaluate(() => Array.from(document.querySelectorAll('#qr-steps li')).map(li => li.className));
        assert.deepStrictEqual(rsteps, ['done', 'now', '']);
        await S.evaluate(() => closeQR());
        await page_visible(S, '#handover-flow-modal');
        assert.match(await S.textContent('#handover-flow-title'), /step 3 of 3/);
        assert.ok(await S.isVisible('text=Scan their confirmation code'));
        await S.evaluate(() => generateMyIdentityQR());
        assert.strictEqual(await S.isVisible('#qr-steps'), false);
        await S._ctx.close(); await R._ctx.close();
    });
    await test('"Ready offline" appears once every file the app needs is stored on the phone', async () => {
        const O = await device('Offline', { serviceWorkers: 'allow' });
        await O.waitForFunction(() => /Ready offline/.test(document.getElementById('offline-status').textContent), null, { timeout: 20000 });
        assert.match(await O.getAttribute('#offline-status', 'class'), /ready/);
        // And it really works offline: reload with the network cut.
        await O._ctx.setOffline(true);
        await O.reload();
        await O.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 10000 });
        assert.ok(await O.isVisible('#intro-triager'));
        await O._ctx.setOffline(false);
        await O._ctx.close();
    });
    await test('Android install prompt: an Install button appears, calls the browser prompt, and "Later" is remembered', async () => {
        const A2 = await device('Install');
        await setup(A2, 'Medic I');
        await A2.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted = true; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
        assert.ok(await A2.isVisible('#install-banner'));
        await A2.click('#install-banner .btn-primary');
        assert.ok(await A2.evaluate(() => window.__prompted === true));
        await A2.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; window.dispatchEvent(e); dismissInstallBanner(); const e2 = new Event('beforeinstallprompt'); e2.prompt = () => {}; window.dispatchEvent(e2); });
        assert.strictEqual(await A2.isVisible('#install-banner'), false);
        await A2._ctx.close();
    });
    await test('the printable quick-reference card loads, is linked from Settings and works offline', async () => {
        const QR = await device('Quick ref');
        assert.strictEqual(await QR.getAttribute('#modes-modal a[href="quick-reference.html"]', 'href'), 'quick-reference.html');
        const page = await QR._ctx.newPage();
        const res = await page.goto(url.replace('index.html', 'quick-reference.html'));
        assert.strictEqual(res.status(), 200);
        assert.match(await page.textContent('h1'), /quick reference/i);
        assert.ok(await page.isVisible('text=START TRIAGE'));
        assert.ok(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').includes("'./quick-reference.html'"));
        await QR._ctx.close();
    });

    console.log('\ne2e: iPhone / iPad compatibility');
    const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';
    const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
    const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
    await test('an older iPhone without DecompressionStream (iOS < 16.4) accepts a compressed QR from an Android phone', async () => {
        const S = await device('Android', Object.assign({ userAgent: ANDROID_UA }, phone));
        const I = await device('Old iPhone', Object.assign({ userAgent: IPHONE_UA, initScript: 'delete window.CompressionStream; delete window.DecompressionStream;' }, phone));
        await setup(S, 'Medic Android'); await setup(I, 'Medic iPhone');
        assert.strictEqual(await I.evaluate(() => MITTLib.compressionSupported()), false);
        await triage(S, 'TST', [false, false, true, false]);
        await S.evaluate(() => { const e = currentEntry(); e.notes = 'Blast injury, lacerations to both legs, tourniquet applied right thigh, Zoë, £20 in pocket. '.repeat(3); e.allergies = 'Latex'; saveState(); return generatePatientQR(); });
        const text = await qrText(S);
        assert.ok(text.startsWith('MITZ1:'), 'sender used compression');
        await scan(I, text);
        await page_visible(I, '#preview-modal');
        assert.match(await I.textContent('#preview-content'), /New patient/);
        await I.evaluate(() => acceptPreview());
        const got = await I.evaluate(() => incidentLog[incidentLog.length - 1]);
        assert.match(got.notes, /Zoë, £20/);
        assert.strictEqual(got.allergies, 'Latex');
        await S._ctx.close(); await I._ctx.close();
    });
    await test('iPhone in Safari is told to add to Home Screen (7-day deletion, separate storage); dismissal sticks', async () => {
        const I = await device('iPhone Safari', Object.assign({ userAgent: IPHONE_UA }, phone));
        assert.ok(await I.isVisible('#ios-install-banner'));
        assert.match(await I.textContent('#ios-install-banner'), /Add to Home Screen[\s\S]*7 days[\s\S]*stored separately/);
        await I.click('#ios-install-banner button');
        assert.strictEqual(await I.isVisible('#ios-install-banner'), false);
        await I.reload(); await I.waitForFunction(() => dbReady === true);
        assert.strictEqual(await I.isVisible('#ios-install-banner'), false);
        await I._ctx.close();
        const H = await device('iPhone Home Screen app', Object.assign({ userAgent: IPHONE_UA, initScript: 'Object.defineProperty(navigator, "standalone", { get: () => true });' }, phone));
        assert.strictEqual(await H.isVisible('#ios-install-banner'), false);
        await H._ctx.close();
        const Dr = await device('Android Chrome', Object.assign({ userAgent: ANDROID_UA }, phone));
        assert.strictEqual(await Dr.isVisible('#ios-install-banner'), false);
        await Dr._ctx.close();
    });
    await test('iPhone exports open the share sheet ("Save to Files"); a cancelled share is recorded in the audit', async () => {
        const stub = `window.__shared = []; window.__shareResult = 'ok';
            navigator.canShare = (d) => !!(d && d.files && d.files.length);
            navigator.share = (d) => { window.__shared.push({ name: d.files[0].name, type: d.files[0].type, size: d.files[0].size });
                return window.__shareResult === 'ok' ? Promise.resolve() : Promise.reject(new DOMException('cancelled', 'AbortError')); };`;
        const I = await device('iPhone export', Object.assign({ userAgent: IPHONE_UA, initScript: stub }, phone));
        await setup(I, 'Medic iPhone');
        await triage(I, 'TST', [true]);
        let downloaded = false; I.on('download', () => { downloaded = true; });
        await I.evaluate(() => downloadCSV('SNAPSHOT'));
        await I.waitForTimeout(200);
        const shared = await I.evaluate(() => window.__shared);
        assert.strictEqual(shared.length, 1);
        assert.match(shared[0].name, /^MITT_casualty_register_.*\.csv$/);
        assert.strictEqual(shared[0].type, 'text/csv');
        assert.ok(shared[0].size > 0);
        assert.strictEqual(downloaded, false);
        await I.evaluate(() => { window.__shareResult = 'cancel'; downloadArchive(); });
        await I.waitForTimeout(300);
        assert.ok(await I.evaluate(() => auditLog.some(a => a.action === 'FILE_SAVE_CANCELLED' && /MITT_archive_/.test(a.details))));
        await I._ctx.close();
    });
    await test('iPhone "Export transfer file" opens the share sheet straight from the tap (no background work first)', async () => {
        const stub = `window.__shared = []; navigator.canShare = (d) => !!(d && d.files); navigator.share = (d) => { window.__shared.push(d.files[0].name); return Promise.resolve(); };`;
        const I = await device('iPhone transfer file', Object.assign({ userAgent: IPHONE_UA, initScript: stub }, phone));
        await setup(I, 'Medic iPhone');
        await triage(I, 'TST', [true]);
        await I.evaluate(() => openAllPatientsTransfer());
        const sharedSync = await I.evaluate(() => { exportAllPatientsFile(); return window.__shared.slice(); });
        assert.strictEqual(sharedSync.length, 1);
        assert.match(sharedSync[0], /^MITT_transfer_.*\.json$/);
        const sharedSync2 = await I.evaluate(() => { window.__shared = []; shareAllPatientsFile(); return window.__shared.slice(); });
        assert.strictEqual(sharedSync2.length, 1);
        assert.ok(await I.evaluate(() => auditLog.some(a => a.action === 'TRANSFER_GENERATED' && /transfer file/.test(a.details))));
        await I._ctx.close();
    });
    await test('if the phone drops the database connection (iOS after backgrounding), saving reconnects and nothing is lost', async () => {
        const I = await device('iPhone reconnect', Object.assign({ userAgent: IPHONE_UA }, phone));
        await setup(I, 'Medic iPhone');
        await I.evaluate(() => db.close()); // every later transaction now throws InvalidStateError
        await triage(I, 'TST', [true]);
        const ok = await I.evaluate(() => saveState());
        assert.strictEqual(ok, true);
        assert.doesNotMatch(await I.textContent('#save-status'), /NOT SAVED/);
        assert.ok(await I.evaluate(() => auditLog.some(a => a.action === 'STORAGE_RECONNECTED')));
        const uid = await I.evaluate(() => currentEntry().uid);
        await I.evaluate(() => saveState());
        await I.reload(); await I.waitForFunction(() => dbReady === true);
        assert.ok(await I.evaluate(u => incidentLog.some(r => r.uid === u), uid));
        await I._ctx.close();
    });
    await test('no text box is under 16px (iPhones zoom the page when one is tapped)', async () => {
        const I = await device('iPhone fonts', Object.assign({ userAgent: IPHONE_UA }, phone));
        const small = await I.evaluate(() => Array.from(document.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=file]):not([type=hidden]), select, textarea'))
            .filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id || e.className));
        assert.deepStrictEqual(small, []);
        await I._ctx.close();
    });
    await test('with an iPhone notch and home bar, the header, dialogs, toast and footer stay clear of them', async () => {
        const I = await device('iPhone notch', Object.assign({ userAgent: IPHONE_UA }, phone));
        const cdp = await I._ctx.newCDPSession(I);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
        await setup(I, 'Medic iPhone');
        const m = await I.evaluate(() => {
            const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]);
            return { header: px(document.querySelector('header'), 'paddingTop'), modal: px(document.querySelector('.modal-overlay'), 'paddingTop'),
                modalBottom: px(document.querySelector('.modal-overlay'), 'paddingBottom'), footer: px(document.querySelector('footer'), 'paddingBottom') };
        });
        assert.ok(m.header >= 47, 'header ' + m.header);
        assert.ok(m.modal >= 47 && m.modalBottom >= 34, 'modal ' + m.modal + '/' + m.modalBottom);
        assert.ok(m.footer >= 34, 'footer ' + m.footer);
        await I.evaluate(() => showToast('hello'));
        await I.waitForTimeout(400);
        const top = await I.evaluate(() => document.getElementById('toast').getBoundingClientRect().top);
        assert.ok(top >= 47, 'toast top ' + top);
        await I._ctx.close();
    });
    await test('QR codes are identical to a standards-conformant reference encoder (versions 1-35)', async () => {
        const QR = require('qrcode');
        const samples = await A.evaluate(() => {
            const out = []; const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/{}":,\\-_ ';
            for (let len = 10; len <= 2300; len += 53) {
                let s = ''; for (let i = 0; i < len; i++) s += abc[(i * 7919 + len) % abc.length];
                const level = s.length < 600 ? 'M' : 'L';
                const m = new QRCode(document.createElement('div'), { text: s, width: 64, height: 64, correctLevel: QRCode.CorrectLevel[level] })._oQRCode;
                const mask = m.getBestMaskPattern(); m.makeImpl(false, mask);
                const g = []; for (let r = 0; r < m.moduleCount; r++) { let row = ''; for (let c = 0; c < m.moduleCount; c++) row += m.isDark(r, c) ? '1' : '0'; g.push(row); }
                out.push({ s, v: m.typeNumber, level, mask, g });
            }
            return out;
        });
        samples.forEach(x => {
            const ref = QR.create([{ data: Buffer.from(x.s), mode: 'byte' }], { version: x.v, errorCorrectionLevel: x.level, maskPattern: x.mask });
            for (let r = 0; r < ref.modules.size; r++) for (let c = 0; c < ref.modules.size; c++) {
                if ((ref.modules.get(r, c) ? '1' : '0') !== x.g[r][c]) throw new Error(`${x.s.length} chars v${x.v}${x.level}: module ${r},${c} differs`);
            }
        });
    });
    console.log('\ne2e: v0.9.0 location, map and phone layout');
    const M = await device('M', { permissions: ['geolocation', 'clipboard-read', 'clipboard-write'] });
    await setup(M, 'Medic M');
    let pinnedUid = null;
    await test('home screen has a Map button and the location pill shows the phone\'s accuracy', async () => {
        assert.ok(await M.isVisible('#btn-home-map'));
        await M.waitForFunction(() => currentPosition && currentPosition.lat, null, { timeout: 8000 });
        await M.evaluate(() => updateGPSIndicator());
        const pill = await M.evaluate(() => ({ text: document.getElementById('gps-indicator').textContent, cls: document.getElementById('gps-indicator').className }));
        assert.match(pill.text, /±8 m/);
        assert.match(pill.cls, /loc-good/);
    });
    await test('a new patient opens with every detail section closed', async () => {
        await triage(M, 'TST', [true]);
        assert.ok(await M.evaluate(() => currentEntry().currentLocation && currentEntry().currentLocation.lat));
        const open = await M.evaluate(() => Array.from(document.querySelectorAll('#details-container details.rs-sec')).filter(d => d.open).map(d => d.id));
        assert.deepStrictEqual(open, []);
        assert.ok(await M.evaluate(() => document.querySelectorAll('#details-container details.rs-sec').length >= 4));
    });
    await test('the location section shows an OS grid reference and an "Open in maps" button', async () => {
        const txt = await M.evaluate(() => document.getElementById('sec-location').textContent);
        assert.match(txt, /SJ \d{5} \d{5}/);
        assert.ok(await M.evaluate(() => document.getElementById('btn-loc-open-maps').style.display !== 'none'));
    });
    await test('the map shows one marker per located patient', async () => {
        await triage(M, 'MITT', [true]);
        pinnedUid = await M.evaluate(() => currentEntry().uid);
        await M.evaluate(() => showMap());
        await M.waitForTimeout(300);
        assert.ok(await M.isVisible('#map-screen'));
        assert.strictEqual(await M.evaluate(() => mapMarkerCluster.getLayers().length), 2);
        assert.match(await M.evaluate(() => document.getElementById('map-list').textContent), /-TST-001[\s\S]*-MITT-002/);
    });
    await test('pin on map: a tap places the patient and marks the position as manually corrected', async () => {
        await M.evaluate(uid => showMap({ pinUid: uid }), pinnedUid);
        assert.ok(await M.isVisible('#map-pin-banner'));
        await Promise.all([
            M.evaluate(() => patientMap.fire('click', { latlng: L.latLng(53.49, -2.25) })),
            answerDialog(M, true),
        ]);
        await M.waitForFunction(() => document.getElementById('map-pin-banner').style.display === 'none');
        const e = await M.evaluate(uid => incidentLog[indexByUid(uid)], pinnedUid);
        assert.strictEqual(Number(e.currentLocation.lat).toFixed(2), '53.49');
        assert.strictEqual(e.locationConfidence, 'manual-corrected');
        assert.strictEqual(e.currentLocation.source, 'map-pin');
        assert.ok(await M.evaluate(() => auditLog.some(a => a.action === 'LOCATION_UPDATE' && /Pinned on map/.test(a.details || a.detail || JSON.stringify(a)))));
    });
    await test('"Same place as last patient" copies the most recently positioned patient', async () => {
        await M.evaluate(() => { currentPosition = Object.assign({}, currentPosition, { timestamp: Date.now() - 10 * 60 * 1000 }); });
        await triage(M, 'TST', [false, true]);
        assert.strictEqual(await M.evaluate(() => currentEntry().currentLocation), null);
        await M.evaluate(() => copyLocationFromPrevious());
        const e = await M.evaluate(() => currentEntry());
        assert.strictEqual(Number(e.currentLocation.lat).toFixed(2), '53.49');
        assert.strictEqual(e.locationConfidence, 'manual-corrected');
        assert.match(e.currentLocation.source, /^copied:/);
        await M.evaluate(() => { currentPosition = Object.assign({}, currentPosition, { timestamp: Date.now() }); });
    });
    await test('METHANE "My location" fills the exact-location box with a grid reference', async () => {
        await M.evaluate(() => { showMethane(); document.getElementById('m-loc').value = ''; methaneUseMyLocation(); });
        assert.match(await M.inputValue('#m-loc'), /^SJ \d{5} \d{5} \/ 53\.48080, -2\.24260 \(±8 m, /);
    });
    await test('ATMIST can be copied as plain text', async () => {
        await M.evaluate(() => { generateAtmist(); copyAtmist(); });
        const clip = await M.evaluate(() => navigator.clipboard.readText());
        assert.match(clip, /ATMIST/);
        assert.match(clip, /Allergies/);
        assert.ok(await M.evaluate(() => auditLog.some(a => a.action === 'ATMIST_COPIED')));
        await M.evaluate(() => closeAtmist());
    });
    await test('"Open in…" offers a Google route plus GPX/KML/GeoJSON; the GPX has a waypoint per patient', async () => {
        await M.evaluate(() => { showMap(); openMapsChooserAll(); });
        await page_visible(M, '#maps-modal');
        const labels = await M.evaluate(() => Array.from(document.querySelectorAll('#maps-options .maps-opt > span')).map(s => s.textContent));
        assert.deepStrictEqual(labels, ['Google Maps', 'Save GPX file', 'Save KML file', 'Save GeoJSON file', 'Copy list']);
        const href = await M.evaluate(() => document.querySelector('#maps-options a').href);
        assert.match(href, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=53\.480800,-2\.242600&destination=/);
        const [dl] = await Promise.all([M.waitForEvent('download'), M.evaluate(() => exportMapFile('gpx'))]);
        const gpx = fs.readFileSync(await dl.path(), 'utf8');
        assert.strictEqual((gpx.match(/<wpt /g) || []).length, 3);
        assert.match(dl.suggestedFilename(), /casualty_map_.*\.gpx$/);
        assert.ok(await M.evaluate(() => auditLog.some(a => a.action === 'MAP_EXPORTED')));
    });
    await test('with location blocked the pill says so and tapping it explains how to allow it', async () => {
        const D = await device('Denied', { permissions: [] });
        await setup(D, 'Medic D');
        await D.waitForFunction(() => LOC.lastError && LOC.lastError.code === 1, null, { timeout: 8000 });
        await D.evaluate(() => updateGPSIndicator());
        assert.match(await D.evaluate(() => document.getElementById('gps-indicator').textContent), /Location off/);
        await D.click('#gps-indicator');
        await page_visible(D, '#loc-modal');
        assert.match(await D.evaluate(() => document.getElementById('loc-help-body').textContent), /blocked/);
        await D.evaluate(() => closeLocationHelp());
        await D._ctx.close();
    });
    await test('phone layout: home, result, map and location screens fit a 360px-wide phone without sideways scrolling', async () => {
        const P = await device('Small phone', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
        await setup(P, 'Medic P');
        const check = async (label) => {
            const w = await P.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
            assert.ok(w[0] <= w[1] + 1, `${label}: page is ${w[0]}px wide for a ${w[1]}px screen`);
        };
        await check('home');
        await triage(P, 'TST', [true]);
        await check('result');
        await P.evaluate(() => { document.getElementById('sec-location').open = true; });
        await check('location section');
        await P.evaluate(() => showMap());
        await P.waitForTimeout(300);
        await check('map');
        const mapH = await P.evaluate(() => document.getElementById('patient-map').getBoundingClientRect().height);
        assert.ok(mapH >= 300, 'map height ' + mapH);
        await P._ctx.close();
    });
    await M._ctx.close();

    console.log('\ne2e: incident commander (live sharing)');
    const CA = await device('Cmd A');
    await setup(CA, 'Medic Alpha');
    let share = null;
    await test('"Start sharing" creates an incident and shows the code, PIN, link and join QR', async () => {
        assert.strictEqual(await CA.evaluate(() => document.getElementById('cmd-pill').style.display), 'none');
        await CA.evaluate(() => { cmdStart(); });
        await answerDialog(CA, true);
        await CA.waitForFunction(() => cmdActive(), null, { timeout: 8000 });
        await page_visible(CA, '#cmd-modal');
        share = await CA.evaluate(() => ({ code: CMD.cfg.code, pin: CMD.cfg.pin, cmdPin: CMD.cfg.cmdPin, role: CMD.cfg.role, link: document.getElementById('cmd-link').href, qr: document.querySelector('#cmd-qr canvas, #cmd-qr img') !== null }));
        assert.match(share.code, /^[A-HJ-NP-Z2-9]{6}$/);
        assert.match(share.pin, /^\d{6}$/);
        assert.match(share.cmdPin, /^\d{6}$/);
        assert.notStrictEqual(share.cmdPin, share.pin, 'v0.19.6: the commander PIN is not the triagers\' PIN');
        assert.strictEqual(share.role, 'creator');
        assert.ok(share.link.endsWith('/commander.html#' + share.code), share.link);
        assert.ok(share.qr, 'join QR drawn');
        assert.ok(await CA.evaluate(() => auditLog.some(a => a.action === 'COMMANDER_SHARE_START')));
        await CA.evaluate(() => closeCmdDetails());
        assert.notStrictEqual(await CA.evaluate(() => document.getElementById('cmd-pill').style.display), 'none');
    });
    await test('a new patient is sent in the background within a few seconds', async () => {
        await triage(CA, 'TST', [true]);
        await CA.waitForFunction(() => CMD.dirty.size === 0 && CMD.lastSentAt > 0, null, { timeout: 10000 });
        assert.match(await CA.evaluate(() => document.getElementById('cmd-pill').textContent), /✓/);
        assert.ok(await CA.evaluate(() => auditLog.some(a => a.action === 'COMMANDER_PUSH')));
    });
    const CC = await device('Commander', { viewport: { width: 1280, height: 900 }, permissions: [] });
    await test('the commander page needs the code and PIN, then shows the casualty, the map marker and the phone', async () => {
        await CC.goto(url.replace('index.html', 'commander.html#' + share.code));
        assert.strictEqual(await CC.inputValue('#in-code'), share.code);
        await CC.fill('#in-pin', '000000');
        await CC.click('#signin button');
        await page_visible(CC, '#signin-error');
        assert.match(await CC.evaluate(() => document.getElementById('signin-error').textContent), /do not open a running incident/);
        await CC.fill('#in-pin', share.cmdPin);
        await CC.fill('#in-by', 'Silver, Insp Kaur');
        await CC.click('#signin button');
        await CC.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1, null, { timeout: 8000 });
        assert.match(await CC.evaluate(() => document.getElementById('status-pill').textContent), /Live/);
        assert.match(await CC.evaluate(() => document.getElementById('rows').textContent), /-TST-001/);
        assert.match(await CC.evaluate(() => document.getElementById('phones').textContent), /Medic Alpha/);
        assert.strictEqual(await CC.evaluate(() => cluster.getLayers().length), 1);
        assert.match(await CC.evaluate(() => document.getElementById('counts').textContent), /P3/);
    });
    const CB = await device('Cmd B');
    await setup(CB, 'Medic Bravo');
    await test('a second phone joins with the code and PIN; the commander sees both phones and both patients', async () => {
        assert.strictEqual(await CB.evaluate((s) => cmdJoin(s.code, s.pin), share), true);
        await triage(CB, 'MITT', [true]);
        await CB.evaluate(() => { const e = currentEntry(); e.highRisk = true; touch(e, ['highRisk']); saveState(); });
        await CB.waitForFunction(() => CMD.dirty.size === 0 && CMD.lastSentAt > 0, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2, null, { timeout: 8000 });
        const rows = await CC.evaluate(() => Array.from(document.querySelectorAll('#rows tr')).map(r => r.textContent));
        assert.match(rows[0], /-MITT-/); // P1 first
        assert.match(rows[0], /HIGH RISK/);
        assert.match(await CC.evaluate(() => document.getElementById('attention').textContent), /high risk/);
        assert.strictEqual(await CC.evaluate(() => document.querySelectorAll('.phone').length), 2);
        assert.strictEqual(await CC.evaluate(() => cluster.getLayers().length), 2);
    });
    await test('v0.18.0: position sharing is off until the phone says yes; the question is asked once when linking; on = a triager marker on the commander map, off = removed', async () => {
        // Nothing shared so far: no triager markers, no 📍 on the phones list
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.querySelectorAll('.phone').length === 2, null, { timeout: 8000 });
        assert.strictEqual(await CC.evaluate(() => teamsLayer ? teamsLayer.getLayers().length : 0), 0);
        assert.doesNotMatch(await CC.textContent('#phones'), /📍/);
        assert.strictEqual(await CB.evaluate(() => posShareOn()), false);
        // Bravo links again with the question not yet answered: asked once, says yes
        await CB.evaluate(() => localStorage.removeItem('mit_share_pos_asked'));
        await CB.evaluate(s => { window._join = cmdJoin(s.code, s.pin); }, share);
        await answerDialog(CB, true);
        assert.strictEqual(await CB.evaluate(() => window._join), true);
        assert.strictEqual(await CB.evaluate(() => posShareOn()), true);
        assert.strictEqual(await CB.evaluate(() => localStorage.getItem('mit_share_pos_asked')), '1');
        assert.ok(await CB.evaluate(() => auditLog.some(a => a.action === 'POSITION_SHARE_ON')));
        assert.strictEqual(await CB.evaluate(() => document.getElementById('set-share-pos').checked), true);
        // Linking again does not ask again
        assert.strictEqual(await CB.evaluate(s => cmdJoin(s.code, s.pin), share), true);
        assert.strictEqual(await CB.evaluate(() => getComputedStyle(document.getElementById('confirm-modal')).display), 'none');
        // The position rides the next report; the commander shows a triager marker and the age in the phones list
        await CB.waitForFunction(() => currentPosition && currentPosition.lat, null, { timeout: 8000 });
        await CB.evaluate(() => cmdPush(true));
        await CB.waitForFunction(() => !CMD.inflight && CMD.lastSentAt > 0 && !CMD.lastError, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.getElementById('phones').textContent.indexOf('📍') > -1, null, { timeout: 8000 });
        const team = await CC.evaluate(() => ({ n: teamsLayer.getLayers().filter(l => l._dev).length, dev: teamsLayer.getLayers().filter(l => l._dev).map(l => l._dev), html: document.querySelector('.tm') ? document.querySelector('.tm').textContent : '', note: document.getElementById('map-note').textContent, legend: document.getElementById('legend').textContent }));
        assert.strictEqual(team.n, 1);
        assert.deepStrictEqual(team.dev, [await CB.evaluate(() => deviceId)]);
        assert.match(team.html, /Medic Bravo/);
        assert.match(team.note, /1 triager/);
        assert.match(team.legend, /triager/);
        assert.strictEqual(await CC.evaluate(() => (data.devices.find(d => d.triager === 'Medic Bravo') || {}).position.lat), 53.4808);
        assert.strictEqual(await CC.evaluate(() => (data.devices.find(d => d.triager === 'Medic Alpha') || {}).position), undefined, 'Alpha never opted in');
        // Off again in Settings: the server forgets it and the marker goes
        await CB.evaluate(() => setPosShare(false, 'Settings'));
        assert.ok(await CB.evaluate(() => auditLog.some(a => a.action === 'POSITION_SHARE_OFF')));
        await CB.waitForFunction(() => !CMD.inflight && CMD.dirty.size === 0, null, { timeout: 10000 });
        await CB.evaluate(() => cmdPush(true));
        await CB.waitForFunction(() => !CMD.inflight, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.getElementById('phones').textContent.indexOf('📍') === -1, null, { timeout: 8000 });
        assert.strictEqual(await CC.evaluate(() => teamsLayer.getLayers().length), 0);
    });
    await test('v0.18.0: holding the 🆘 button for 2 seconds calls the commander for help; a short tap does not; the commander clears it and the phone is told', async () => {
        const btn = CB.locator('#duress-btn');
        assert.ok(await CB.evaluate(() => !!document.getElementById('duress-btn').closest('header')), 'v0.19.4: in the header, not the scrolling status strip');
        await btn.waitFor({ state: 'visible', timeout: 5000 });
        assert.match(await btn.textContent(), /Hold for help/);
        // A short press does nothing
        const box = await btn.boundingBox();
        await CB.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await CB.mouse.down(); await CB.waitForTimeout(400); await CB.mouse.up();
        await CB.waitForTimeout(300);
        assert.strictEqual(await CB.evaluate(() => duressActive()), false);
        // Held for over 2 seconds: the call goes at once with the position
        await CB.mouse.down(); await CB.waitForTimeout(2400); await CB.mouse.up();
        await CB.waitForFunction(() => duressActive(), null, { timeout: 5000 });
        assert.ok(await CB.evaluate(() => auditLog.some(a => a.action === 'DURESS_RAISED')));
        assert.match(await btn.textContent(), /HELP CALLED/);
        assert.ok(await CB.evaluate(() => document.getElementById('duress-btn').classList.contains('live')));
        await CB.waitForFunction(() => !CMD.inflight && !CMD.lastError && CMD.lastSentAt > 0, null, { timeout: 10000 });
        // Commander: red banner, red phone, red alert, red marker at the phone's position (sent with the call even though position sharing is off)
        await CC.evaluate(() => { ALERTS.sound = false; refreshNow(); });
        await CC.waitForFunction(() => !document.getElementById('sos').classList.contains('hidden'), null, { timeout: 8000 });
        const c = await CC.evaluate(() => ({ sos: document.getElementById('sos').textContent, phones: document.querySelectorAll('.phone.sos').length, alerts: Array.from(document.querySelectorAll('#alerts .alert')).map(a => a.textContent), marker: document.querySelector('.tm.tm-sos') ? document.querySelector('.tm.tm-sos').textContent : '', clearBtn: !!document.querySelector('#sos [data-act="clearDuress"]') }));
        assert.match(c.sos, /Medic Bravo/); assert.match(c.sos, /needs help/);
        assert.strictEqual(c.phones, 1);
        assert.ok(c.alerts.some(a => /Medic Bravo needs help/.test(a)), JSON.stringify(c.alerts));
        assert.match(c.marker, /Medic Bravo/);
        assert.ok(c.clearBtn, 'the full-PIN commander can clear it');
        // The same call repeated by the next heartbeat is not announced again
        await CC.evaluate(() => ALERTS.list.filter(a => a.sos).forEach(a => dismissAlert(a.id)));   // leave the earlier "New P1" alert for the next test
        await CB.evaluate(() => cmdPush(true));
        await CB.waitForFunction(() => !CMD.inflight, null, { timeout: 10000 });
        await CC.evaluate(() => { knownSeq = ''; etag = ''; refreshNow(); });
        await CC.waitForTimeout(1500);
        assert.strictEqual(await CC.evaluate(() => ALERTS.list.filter(a => a.sos).length), 0);
        // The commander clears it; the phone learns on its next report
        await CC.evaluate(() => { clearDuress(data.devices.find(d => d.triager === 'Medic Bravo').deviceId); });
        await askAnswer(CC, true);   // v0.19.4: an in-app dialog, not the browser's confirm()
        await CC.waitForFunction(() => document.getElementById('sos').classList.contains('hidden'), null, { timeout: 8000 });
        assert.strictEqual(await CC.evaluate(() => document.querySelectorAll('.phone.sos').length), 0);
        await CB.evaluate(() => cmdPush(true));
        await CB.waitForFunction(() => !duressActive(), null, { timeout: 10000 });
        assert.ok(await CB.evaluate(() => auditLog.some(a => a.action === 'DURESS_CLEARED' && /commander/.test(a.details || a.detail || ''))));
        assert.match(await btn.textContent(), /Hold for help/);
        // Raised again and cancelled on the phone: the commander banner goes
        await CB.evaluate(() => cmdRaiseDuress('test'));
        await CB.waitForFunction(() => !CMD.inflight && CMD.lastSentAt > 0, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => !document.getElementById('sos').classList.contains('hidden'), null, { timeout: 8000 });
        await CB.evaluate(() => { window._cancel = cmdCancelDuress(); });
        await answerDialog(CB, true);
        await CB.evaluate(() => window._cancel);
        assert.strictEqual(await CB.evaluate(() => duressActive()), false);
        await CB.waitForFunction(() => !CMD.inflight && !CMD.cfg.duress, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.getElementById('sos').classList.contains('hidden'), null, { timeout: 8000 });
        assert.strictEqual(await CB.evaluate(() => auditLog.filter(a => a.action === 'DURESS_CLEARED').length), 2);
        await CC.evaluate(() => { ALERTS.list.filter(a => a.sos).forEach(a => dismissAlert(a.id)); ALERTS.sound = true; });
    });
    await test('v0.19.0: P1 Hold is hidden until the commander allows it (with a name); a MITT prompt to clinicians lets a phone switch its main button to MITT', async () => {
        const holdHidden = () => CB.evaluate(() => { applyP1HoldOption(); const o = document.querySelector('#p-cat-override option[value="P1_HOLD"]'); return o.hidden && o.disabled; });
        assert.strictEqual(await holdHidden(), true, 'hidden by default');
        await CB.evaluate(() => cmdPush(true));
        await CB.waitForFunction(() => !CMD.inflight, null, { timeout: 10000 });
        await CC.evaluate(() => { knownSeq = ''; etag = ''; refreshNow(); });
        await CC.waitForFunction(() => /Clinician/.test(document.getElementById('phones').textContent), null, { timeout: 8000 });
        assert.match(await CC.evaluate(() => document.getElementById('decisions').textContent), /Not in use \(default\)/);
        // No name: refused on the commander page
        await CC.evaluate(() => { setP1Hold(true); });
        await page_visible(CC, '#ask-modal');
        assert.match(await CC.textContent('#ask-msg'), /Type who made the P1 Hold decision/);
        assert.strictEqual(await CC.isVisible('#ask-cancel'), false, 'a message has only OK');
        await askAnswer(CC, true);
        assert.match(await CC.evaluate(() => document.getElementById('decisions').textContent), /Not in use/);
        await CC.fill('#p1hold-by', 'Dr Medic, MERIT');
        await CC.click('[data-act="setP1Hold"][data-on="1"]');
        await askAnswer(CC, true);
        await CC.waitForFunction(() => /ALLOWED since/.test(document.getElementById('decisions').textContent), null, { timeout: 8000 });
        await CB.evaluate(() => cmdPush(true));
        await CB.waitForFunction(() => p1HoldAllowedHere(), null, { timeout: 10000 });
        assert.strictEqual(await holdHidden(), false, 'offered once allowed');
        assert.ok(await CB.evaluate(() => auditLog.some(a => a.action === 'P1_HOLD_ALLOWED' && /Dr Medic, MERIT/.test(a.details || a.detail || ''))));
        // MITT prompt to clinicians
        await CC.check('.mitt-grp[value="hcp"]');
        await CC.click('[data-act="sendMittPrompt"]');
        await page_visible(CC, '#ask-modal');
        assert.match(await CC.textContent('#ask-title'), /Send the MITT prompt/);
        await askAnswer(CC, true);
        await CC.waitForFunction(() => /Prompt sent/.test(document.getElementById('decisions').textContent), null, { timeout: 8000 });
        await CB.evaluate(() => { cmdPush(true); });
        await CB.waitForFunction(() => !!CMD.cfg.mittPending, null, { timeout: 10000 });
        await CB.evaluate(() => { closeModesMenu && closeModesMenu(); showScreen('home-screen'); renderHomeAlerts(); });
        await page_visible(CB, '#home-mitt-prompt');
        await CB.click('#home-mitt-prompt .btn-primary');
        const m = await CB.evaluate(() => ({ mode: toolMode, main: document.getElementById('btn-start-triage').textContent, other: document.getElementById('btn-mitt').textContent, card: !!document.getElementById('home-mitt-prompt'), stored: ls('mit_tool_mode') }));
        assert.deepStrictEqual({ mode: m.mode, card: m.card, stored: m.stored }, { mode: 'MITT', card: false, stored: 'MITT' }, JSON.stringify(m));
        assert.match(m.main, /MITT/); assert.match(m.other, /TST/);
        assert.ok(await CB.evaluate(() => auditLog.some(a => a.action === 'MITT_PROMPT_ANSWERED')));
        // The same prompt is not shown again on the next report
        await CB.evaluate(() => cmdPush(true));
        await CB.waitForFunction(() => !CMD.inflight, null, { timeout: 10000 });
        assert.strictEqual(await CB.evaluate(() => CMD.cfg.mittPending), null);
        await CB.evaluate(() => setToolMode('TST', true));
    });
    await test('phone marks a casualty at the CCS and evacuates another to a hospital; the commander splits field / CCS / evacuated', async () => {
        // CB's MITT patient: handed to the CCS from the patient screen
        await CB.evaluate(() => { toggleCcs(); });
        const b = await CB.evaluate(() => ({ atCcs: currentEntry().atCcs, sector: currentEntry().sector, btn: document.getElementById('btn-ccs').textContent, sum: document.getElementById('sum-transport').textContent }));
        assert.strictEqual(b.atCcs, true); assert.strictEqual(b.sector, 'Casualty clearing station');
        assert.match(b.btn, /At the casualty clearing station/); assert.match(b.sum, /AT CCS/);
        // CA's TST patient: evacuated; the hospital chooser opens because no destination was recorded
        await CA.evaluate(() => { currentLogIndex = 0; toggleEvac(); });
        await CA.waitForSelector('#hospital-modal', { state: 'visible', timeout: 5000 });
        assert.ok(await CA.evaluate(() => document.querySelectorAll('#hospital-btns button').length > 5), 'default hospital list offered');
        await CA.evaluate(() => pickHospital('Heartlands Hospital'));
        const a = await CA.evaluate(() => ({ ev: incidentLog[0].evacuated, dest: incidentLog[0].evacDest, field: document.getElementById('p-evac-dest').value, hidden: getComputedStyle(document.getElementById('hospital-modal')).display }));
        assert.deepStrictEqual(a, { ev: true, dest: 'Heartlands Hospital', field: 'Heartlands Hospital', hidden: 'none' });
        assert.match(await CA.evaluate(() => document.getElementById('evac-summary').textContent), /Field: 0 \| CCS: 0 \| Evacuated: 1/);
        await CA.waitForFunction(() => CMD.dirty.size === 0, null, { timeout: 10000 });
        await CB.waitForFunction(() => CMD.dirty.size === 0, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => /Heartlands Hospital/.test(document.getElementById('stages').textContent), null, { timeout: 8000 });
        const st = await CC.evaluate(() => ({ stages: document.getElementById('stages').textContent, counts: document.getElementById('counts').textContent, where: document.getElementById('sectors').textContent, rows: document.querySelectorAll('#rows tr').length }));
        assert.match(st.stages, /0\s*In the field/i); assert.match(st.stages, /1\s*At the casualty clearing station/i); assert.match(st.stages, /1\s*Evacuated/i);
        assert.match(st.counts, /0 field • 1 CCS/);
        assert.match(st.where, /Heartlands Hospital/);
        assert.strictEqual(st.rows, 1, 'on scene by default');
        await CC.evaluate(() => setStageFilter('evacuated'));
        assert.match(await CC.evaluate(() => document.getElementById('rows').textContent), /Heartlands Hospital/);
        await CC.evaluate(() => setStageFilter('scene'));
        // a phone whose sector is the CCS marks what it receives as at the CCS
        const CS = await device('Cmd S');
        await CS.evaluate(() => { document.getElementById('intro-sector').value = 'Casualty Clearing'; });
        await setup(CS, 'CCS nurse');
        assert.strictEqual(await CS.evaluate(() => currentSector), 'Casualty Clearing');
        await triage(CS, 'TST', [true]);
        assert.strictEqual(await CS.evaluate(() => currentEntry().atCcs), true, 'a CCS phone creates patients at the CCS');
        await CS._ctx.close();
        // put CA's patient back on scene so the later tests see two on-scene casualties
        await CA.evaluate(() => { currentLogIndex = 0; toggleEvac(); });
        assert.strictEqual(await CA.evaluate(() => incidentLog[0].evacuated), false);
        await CA.waitForFunction(() => CMD.dirty.size === 0, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2, null, { timeout: 8000 });
    });
    await test('v0.14.0: deterioration raises an alert; METHANE, hospital board, timeline, print summary and the view-only PIN work', async () => {
        // Medic Bravo's P1 arrived after the commander's first load, so it was announced; clear it for a clean start.
        assert.match(await CC.evaluate(() => document.getElementById('alerts').textContent), /New P1/);
        await CC.evaluate(() => { ALERTS.sound = false; dismissAlert(); });
        assert.strictEqual(await CC.evaluate(() => document.querySelectorAll('#alerts .alert').length), 0);
        // CA's TST P3 casualty gets worse (re-triaged as P1 by hand, as a re-triage would do)
        await CA.evaluate(() => { const e = incidentLog[0]; e.cardNo = '0427'; e.category = 'P1'; e.triageHistory = (e.triageHistory || []).concat([{ ts: Date.now(), category: 'P1', reason: 'Severe Bleeding', tool: 'TST', by: triagerName, kind: 'retriage' }]); e.lastDeteriorationAt = Date.now(); touch(e, ['category']); saveState(); });
        await CA.waitForFunction(() => CMD.dirty.size === 0, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.querySelectorAll('#alerts .alert').length === 1, null, { timeout: 8000 });
        assert.match(await CC.evaluate(() => document.querySelector('#alerts .alert').textContent), /got worse: P3 → P1/);
        assert.match(await CC.evaluate(() => document.getElementById('timeline').textContent), /Deteriorated/);
        assert.match(await CC.evaluate(() => document.getElementById('rows').textContent), /Card 0427/, 'triage card number shown on the commander table');
        assert.strictEqual(await CA.evaluate(() => { currentLogIndex = 0; renderResultScreen(incidentLog[0]); return document.getElementById('p-card-no').value; }), '0427');
        await CC.evaluate(() => dismissAlert());
        assert.strictEqual(await CC.evaluate(() => document.querySelectorAll('#alerts .alert').length), 0);
        // METHANE saved on a phone reaches the commander screen
        const sentBefore = await CB.evaluate(() => CMD.lastSentAt);
        await CB.evaluate(() => { document.getElementById('m-decl').value = 'DECLARED'; document.getElementById('m-loc').value = 'Platform 2, Piccadilly'; document.getElementById('m-num').value = 'About 20'; saveMethane(); });
        await CB.waitForFunction((b) => CMD.lastSentAt > b && !CMD.inflight, sentBefore, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => /Piccadilly/.test(document.getElementById('methane').textContent), null, { timeout: 8000 });
        assert.match(await CC.evaluate(() => document.getElementById('methane-note').textContent), /Medic Bravo/);
        // hospital board: a hospital can be added with an agreed capacity before anyone is sent there
        assert.match(await CC.evaluate(() => document.getElementById('hosp').textContent), /Nobody evacuated yet/);
        await CC.evaluate(() => { const sel = document.getElementById('hosp-add'); sel.value = 'Good Hope Hospital'; addHospitalRow(); setCap('Good Hope Hospital', 4); });
        assert.match(await CC.evaluate(() => document.querySelector('#hosp table').textContent), /Good Hope Hospital/);
        assert.strictEqual(await CC.evaluate(() => document.querySelector('#hosp input').value), '4');
        // timeline lists the triages, newest first, and the print summary is built from the same data
        assert.ok(await CC.evaluate(() => document.querySelectorAll('#timeline li').length) >= 3);
        await CC.evaluate(() => { window.print = () => { window._printed = true; }; printSummary(); });
        await CC.waitForFunction(() => window._printed === true, null, { timeout: 3000 });
        const pv = await CC.evaluate(() => document.getElementById('print-view').textContent);
        assert.match(pv, /commander summary/); assert.match(pv, /-TST-001/); assert.match(pv, /Piccadilly/); assert.match(pv, /Medic Bravo/);
        // the view-only PIN opens the same screen, marked view only, and cannot be used to join
        const viewPin = await CA.evaluate(() => CMD.cfg.viewPin);
        assert.match(viewPin, /^\d{6}$/);
        assert.match(await CA.evaluate(() => { cmdShowDetails(); return document.getElementById('cmd-view-pin').textContent; }), /^\d{6}$/);
        await CA.evaluate(() => closeCmdDetails());
        const CV = await browser.newPage();
        CV.on('pageerror', e => errors.push(`Cmd V: ${e.message}`));
        await CV.goto(url.replace('index.html', 'commander.html#' + share.code));
        await CV.fill('#in-pin', viewPin);
        await CV.click('#signin button');
        await CV.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2, null, { timeout: 8000 });
        assert.match(await CV.evaluate(() => document.getElementById('hdr-incident').textContent), /View only/);
        await CV.close();
        const CW = await device('Cmd W');
        await setup(CW, 'Observer');
        assert.strictEqual(await CW.evaluate((s) => cmdJoin(s.code, s.pin), { code: share.code, pin: viewPin }), false);
        await CW._ctx.close();
    });
    await test('a wrong training state cannot join, and a join QR scanned on a third phone joins after confirmation', async () => {
        const CD = await device('Cmd D');
        await setup(CD, 'Medic Delta');
        await CD.evaluate((s) => onScanSuccess(JSON.stringify({ t: 'MIT_JOIN', c: s.code, p: s.pin })), share);
        await answerDialog(CD, true);
        await CD.waitForFunction(() => cmdActive(), null, { timeout: 8000 });
        assert.strictEqual(await CD.evaluate(() => CMD.cfg.role), 'member');
        await CD.waitForFunction(() => CMD.lastSentAt > 0, null, { timeout: 10000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.querySelectorAll('.phone').length === 3, null, { timeout: 8000 });
        await CD._ctx.close();
    });
    await test('a new phone is asked at the start whether there is a commander; "type the code" links it and the home alert goes', async () => {
        const CG = await device('Cmd G');
        await CG.fill('#intro-triager', 'Medic Golf');
        await CG.evaluate(() => setUserRole('HCP'));
        await page_visible(CG, '#cmd-link-modal');
        await CG.evaluate(() => { closeCmdLink(); cmdOpenJoin(); });
        await page_visible(CG, '#cmd-join-modal');
        assert.ok(await CG.evaluate(() => document.getElementById('home-cmd-link') !== null), 'home alert while not linked');
        await CG.fill('#cmd-join-code', share.code); await CG.fill('#cmd-join-pin', share.pin);
        await CG.evaluate(() => { cmdJoin(); });
        await answerDialog(CG, false);   // v0.18.0: a first link asks once about sharing the phone's position; "Not now"
        await CG.waitForFunction(() => cmdActive(), null, { timeout: 8000 });
        assert.strictEqual(await CG.evaluate(() => posShareOn()), false);
        assert.strictEqual(await CG.evaluate(() => localStorage.getItem('mit_share_pos_asked')), '1');
        assert.strictEqual(await CG.evaluate(() => getComputedStyle(document.getElementById('cmd-join-modal')).display), 'none');
        assert.strictEqual(await CG.evaluate(() => document.getElementById('home-cmd-link')), null, 'home alert gone once linked');
        await CG._ctx.close();
    });
    await test('"No commander / not now" closes the question and keeps the home alert as a reminder', async () => {
        const CH = await device('Cmd H');
        await CH.fill('#intro-triager', 'Medic Hotel');
        await CH.evaluate(() => setUserRole('NON_HCP'));
        await page_visible(CH, '#cmd-link-modal');
        await CH.evaluate(() => cmdDismissLink());
        assert.strictEqual(await CH.evaluate(() => getComputedStyle(document.getElementById('cmd-link-modal')).display), 'none');
        assert.strictEqual(await CH.evaluate(() => document.getElementById('home-cmd-link')), null, 'dismissed for this session');
        // v0.19.4: a small "tap to link" button stays lower down, and going back to the start page asks again
        assert.ok(await CH.isVisible('#home-cmd-link-later'), 'small reminder after "No"');
        await CH.click('#home-cmd-link-later');
        await page_visible(CH, '#cmd-link-modal');
        await CH.evaluate(() => cmdDismissLink());
        await CH.evaluate(() => { showScreen('intro-screen'); setUserRole('NON_HCP'); });
        await page_visible(CH, '#cmd-link-modal');
        assert.match(await CH.textContent('#cmd-link-skip'), /carry on/);
        await CH._ctx.close();
    });
    await test('v0.19.2 walk-through: plain role buttons, one-tap "where are you" on the link sheet, then a one-time how-to card', async () => {
        const W = await device('Walk', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
        assert.match(await W.textContent('#btn-role-responder'), /Police, fire or first aider/);
        assert.match(await W.textContent('#btn-role-paramedic'), /Paramedic or ambulance medic/);
        assert.match(await W.textContent('#btn-role-clinician'), /Doctor or nurse/);
        await W.fill('#intro-triager', 'PC Whiskey');
        await W.click('#btn-role-responder');
        await page_visible(W, '#cmd-link-modal');
        await W.click('#setup-sector-chips [data-sector="Casualty clearing station"]');
        assert.strictEqual(await W.evaluate(() => currentSector), 'Casualty clearing station');
        assert.ok(await W.evaluate(() => document.querySelector('#setup-sector-chips [data-sector="Casualty clearing station"]').classList.contains('on')));
        await W.click('#cmd-link-skip');
        assert.strictEqual(await W.evaluate(() => userRole), 'NON_HCP');
        assert.ok(await W.isVisible('#home-coach'), 'how-to card on first use');
        assert.match(await W.textContent('#home-coach'), /does not replace the paper tag/);
        assert.match(await W.textContent('#header-sector'), /Casualty clearing station/);
        await W.click('#home-coach');
        assert.strictEqual(await W.evaluate(() => document.getElementById('home-coach')), null);
        await W.evaluate(() => renderHomeAlerts());
        assert.strictEqual(await W.evaluate(() => document.getElementById('home-coach')), null, 'stays hidden once dismissed');
        await W._ctx.close();
    });
    await test('v0.19.3: a paramedic button on the start screen gives the clinician role and a clinician how-to card that explains MITT', async () => {
        const PM = await device('Paramedic', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
        await PM.fill('#intro-triager', 'Para 1');
        await PM.evaluate(() => { try { sessionStorage.setItem('mit_cmd_link_dismissed', '1'); localStorage.setItem('mit_share_pos_asked', '1'); } catch (e) {} });
        await PM.click('#btn-role-paramedic');
        assert.strictEqual(await PM.evaluate(() => userRole), 'HCP');
        assert.ok(await PM.isVisible('#home-coach'));
        const txt = await PM.textContent('#home-coach');
        assert.match(txt, /Switch to MITT/);
        assert.match(txt, /Ten Second Triage/);
        await PM._ctx.close();
    });
    await test('v0.19.4 (Chrome test): Join opens above Settings; Worsened goes straight to re-triage and stays due; a patient reopened from the log leads with Reassess', async () => {
        const V = await device('Chrome fixes', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        await setup(V, 'PC Victor', 'NON_HCP');
        // Join from Settings: the Join box is on top (it used to open behind Settings, so the screen just went dark)
        await V.evaluate(() => openModesMenu());
        await V.evaluate(() => { document.querySelector('#modes-modal details:has([onclick="cmdOpenJoin()"])').open = true; });
        await V.click('#modes-modal [onclick="cmdOpenJoin()"]');
        await page_visible(V, '#cmd-join-modal');
        const top = await V.evaluate(() => { const b = document.getElementById('cmd-join-code').getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { onTop: !!(t && t.closest('#cmd-join-modal')), settings: getComputedStyle(document.getElementById('modes-modal')).display }; });
        assert.strictEqual(top.onTop, true, 'the Join box is the top layer');
        assert.strictEqual(top.settings, 'none', 'Settings closed');
        await V.evaluate(() => closeCmdJoin());
        // Settings: training mode is its own line at the top
        await V.evaluate(() => openModesMenu());
        assert.ok(await V.isVisible('#mode-training'), 'training mode visible without opening a section');
        await V.evaluate(() => closeModesMenu());
        // P2 (walking NO, bleeding NO, talking YES, penetrating NO), then Reassess -> Worsened
        await triage(V, 'TST', [false, false, true, false]);
        assert.strictEqual(await V.evaluate(() => currentEntry().category), 'P2');
        const uid = await V.evaluate(() => currentEntry().uid);
        await V.evaluate(() => { openReassessModal(); submitReassessment('worsened'); });
        const w = await V.evaluate(() => ({ screen: document.body.dataset.screen, pending: pendingReTriageUid, state: MITTLib.reassessmentStatus(incidentLog.find(r => r.uid === pendingReTriageUid), Date.now() + 1000, reassessIntervals).state }));
        assert.strictEqual(w.screen, 'question-screen', 'straight into the questions');
        assert.strictEqual(w.pending, uid, 'same casualty');
        assert.strictEqual(w.state, 'overdue', 'not "OK 15m" while waiting to be re-triaged');
        // Now not talking, breathing: P1 on the same record, timer reset by the re-triage
        await V.evaluate(() => { [false, false, false, true].forEach(x => handleAnswer(x)); });
        const r = await V.evaluate(u => { const e = incidentLog.find(x => x.uid === u); return { cat: e.category, n: incidentLog.length, state: MITTLib.reassessmentStatus(e, Date.now(), reassessIntervals).state, det: !!e.lastDeteriorationAt, head: document.getElementById('reassess-head').textContent }; }, uid);
        assert.strictEqual(r.cat, 'P1'); assert.strictEqual(r.n, 1); assert.strictEqual(r.state, 'ok'); assert.ok(r.det);
        assert.match(r.head, /^TST • \d\d:\d\d/);
        // Reopened from the log: Reassess leads
        await V.evaluate(() => { resetToHome(); showLog(); editEntry(0); });
        assert.strictEqual(await V.evaluate(() => document.getElementById('result-screen').classList.contains('reopened')), true);
        const order = await V.evaluate(() => { const a = document.getElementById('btn-reassess').getBoundingClientRect().top, b = document.querySelector('#result-screen .btn-next').getBoundingClientRect().top; return a < b; });
        assert.ok(order, 'Reassess above Next Patient');
        await V.evaluate(() => { openReassessModal(); submitReassessment('unchanged'); });
        assert.strictEqual(await V.evaluate(() => document.getElementById('result-screen').classList.contains('reopened')), false, 'back to normal once reassessed');
        // Dead is never flagged as deteriorating in the log
        await V.evaluate(() => { const e = incidentLog[0]; e.category = 'DEAD'; e.lastDeteriorationAt = Date.now(); showLog(); });
        assert.strictEqual(await V.evaluate(() => document.querySelectorAll('#log-screen .deteriorate-flag').length), 0);
        assert.strictEqual(await V.evaluate(() => document.querySelector('#dash-nb .dash-label').innerText.trim()), 'No breath', 'plain words on a 390 px phone');
        await V._ctx.close();
    });
    await test('v0.19.5 (retest): Back shows the previous question; an unfinished triage is reported after a reload and its ID is not reused; older casualties are only sent if the phone says so', async () => {
        const R = await device('Retest', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        await setup(R, 'Medic Romeo', 'HCP');
        // Back: walking NO, bleeding NO, then Back from "Talking?" shows "Bleeding?" as question 2
        await R.evaluate(() => { initiateTriage('TST'); handleAnswer(false); handleAnswer(false); });
        assert.strictEqual(await R.evaluate(() => document.getElementById('question-screen').dataset.stepId), 'talking');
        await R.click('#btn-back');
        const b = await R.evaluate(() => ({ step: document.getElementById('question-screen').dataset.stepId, prog: document.getElementById('q-progress').textContent, hist: stepHistory.slice() }));
        assert.strictEqual(b.step, 'bleeding');
        assert.match(b.prog, /^Question 2 of/);
        assert.deepStrictEqual(b.hist, ['walking']);
        // Reload part-way: a notice, an audit entry, and the next casualty gets a different ID
        const openId = await R.evaluate(() => currentPatientId);
        await R.reload();
        await R.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 10000 });
        await R.waitForSelector('#confirm-modal', { state: 'visible', timeout: 5000 });
        assert.match(await R.textContent('#confirm-modal'), new RegExp(openId + '[\\s\\S]*no record'));
        await R.click('#confirm-ok');
        assert.ok(await R.evaluate(id => auditLog.some(a => a.action === 'TRIAGE_NOT_FINISHED' && a.patientId === id), openId));
        await R.evaluate(() => sessionStorage.setItem('mit_cmd_link_dismissed', '1'));
        await triage(R, 'TST', [true]);
        const newId = await R.evaluate(() => currentEntry().id);
        assert.notStrictEqual(newId, openId, 'the unfinished ID is not reused');
        assert.strictEqual(await R.evaluate(() => localStorage.getItem('mit_triage_open')), null, 'cleared once saved');
        // v0.19.6: every casualty already on the phone is asked about when linking (v0.19.5 test: 8 were sent unasked);
        // "only new" holds them all back, and casualties triaged after linking are sent
        await R.evaluate(() => { const e = incidentLog[0]; incidentLog.push(Object.assign({}, e, { uid: MITTLib.makeUid(), id: 'OLD-001', createdAt: Date.now() - 26 * 3600e3, timestamp: Date.now() - 26 * 3600e3 })); saveState(); });
        await R.evaluate(() => { window._s = cmdStart({ quiet: true, commander: true }); });
        await R.waitForSelector('#confirm-modal', { state: 'visible', timeout: 5000 });
        assert.match(await R.textContent('#confirm-title'), /2 casualties already on this phone/);
        await answerDialog(R, false);
        await R.waitForFunction(() => cmdActive(), null, { timeout: 8000 });
        const held = await R.evaluate(() => ({ skip: CMD.cfg.skip.map(u => incidentLog.find(r => r.uid === u).id).sort(), audit: auditLog.some(a => a.action === 'COMMANDER_OLDER_RECORDS') }));
        assert.deepStrictEqual(held.skip, ['OLD-001', newId].sort());
        assert.ok(held.audit);
        await R.evaluate(() => closeCmdDetails());
        await triage(R, 'TST', [true]);
        await R.waitForFunction(() => CMD.dirty.size === 0 && CMD.lastSentAt > 0 && CMD.sentTotal > 0, null, { timeout: 10000 });
        assert.strictEqual(await R.evaluate(() => CMD.sentTotal), 1, 'only the casualty triaged after linking was sent');
        // The commander phone's header says so
        assert.strictEqual(await R.evaluate(() => document.getElementById('header-role').textContent), 'Incident commander');
        await R._ctx.close();
    });
    await test('v0.19.6: non-clinicians cannot make a casualty less urgent by hand; time of death goes when a casualty breathes; 🏠 mid-triage asks; a correction is not "deteriorating"', async () => {
        const N = await device('v0196', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        await setup(N, 'PC November', 'NON_HCP');
        // TST not breathing, then try to set P3 by hand: refused, category and instruction unchanged
        await triage(N, 'TST', [false, false, false, false]);
        assert.strictEqual(await N.evaluate(() => currentEntry().category), 'NOT_BREATHING');
        await N.evaluate(() => { document.getElementById('p-cat-override').value = 'P3'; onCategoryOverride(); });
        await N.waitForSelector('#confirm-modal', { state: 'visible', timeout: 5000 });
        assert.match(await N.textContent('#confirm-message'), /healthcare professional/);
        await N.click('#confirm-ok');
        assert.strictEqual(await N.evaluate(() => currentEntry().category), 'NOT_BREATHING');
        // 🏠 half-way through a triage asks first and logs the cancel
        await N.evaluate(() => { initiateTriage('TST'); handleAnswer(false); homeButton(); });
        await N.waitForSelector('#confirm-modal', { state: 'visible', timeout: 5000 });
        assert.match(await N.textContent('#confirm-title'), /Cancel this assessment/);
        await N.click('#confirm-ok');
        assert.ok(await N.evaluate(() => auditLog.some(a => a.action === 'TRIAGE_CANCELLED')));
        await N._ctx.close();
        // Clinician: MITT Dead with a time of death, then "Change the last answer" to breathing -> P1, no time of death,
        // and not flagged as deteriorating
        const M = await device('v0196b', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        await setup(M, 'Dr Mike', 'HCP');
        await M.evaluate(() => { initiateTriage('MITT'); });
        const steps = await M.evaluate(() => mittFlow.map(s => s.id));
        // Answer down to the breathing question, then NO (not breathing) -> Dead
        await M.evaluate(() => { while (document.getElementById('question-screen').dataset.stepId !== 'breathing') handleAnswer(false); handleAnswer(false); });
        await page_visible(M, '#tod-modal');
        await M.evaluate(() => confirmDeath('now'));
        const dead = await M.evaluate(() => ({ cat: currentEntry().category, tod: currentEntry().tod }));
        assert.strictEqual(dead.cat, 'DEAD', steps.join(','));
        assert.match(dead.tod, /^\d\d:\d\d \d\d\/\d\d\/\d{4}$/, 'time of death with the date');
        // Breathing YES leads on to more MITT questions: answer them until there is a result
        await M.evaluate(() => { changeLastAnswer(); handleAnswer(true); let n = 0; while (document.body.dataset.screen === 'question-screen' && n++ < 10) handleAnswer(false); });
        const after = await M.evaluate(() => ({ cat: currentEntry().category, tod: currentEntry().tod, det: !!currentEntry().lastDeteriorationAt }));
        assert.notStrictEqual(after.cat, 'DEAD');
        assert.strictEqual(after.tod, '', 'a living casualty has no time of death');
        assert.strictEqual(after.det, false, 'a corrected mis-tap is not deterioration');
        assert.ok(await M.evaluate(() => auditLog.some(a => a.action === 'TOD_CLEARED')));
        await M._ctx.close();
    });
    await test('v0.19.6: the triagers\' PIN opens the commander screen view only; the commander PIN can decide, with a name in the decision log', async () => {
        const A = await device('v0196c'); await setup(A, 'Medic Alfa');
        await A.evaluate(() => { cmdStart(); });
        await answerDialog(A, true);
        await A.waitForFunction(() => cmdActive(), null, { timeout: 8000 });
        const sh = await A.evaluate(() => { closeCmdDetails(); return { code: CMD.cfg.code, pin: CMD.cfg.pin, cmdPin: CMD.cfg.cmdPin }; });
        const T = await device('v0196t', { viewport: { width: 1280, height: 900 }, permissions: [] });
        await T.goto(url.replace('index.html', 'commander.html#' + sh.code));
        await T.fill('#in-pin', sh.pin);
        await T.click('#signin button');
        await T.waitForFunction(() => data && data.access === 'triager', null, { timeout: 8000 });
        assert.match(await T.textContent('#hdr-incident'), /View only \(triagers' PIN\)/);
        assert.strictEqual(await T.evaluate(() => canMark()), false);
        await T._ctx.close();
        const C = await device('v0196k', { viewport: { width: 1280, height: 900 }, permissions: [] });
        await C.goto(url.replace('index.html', 'commander.html#' + sh.code));
        await C.fill('#in-pin', sh.cmdPin);
        await C.click('#signin button');
        await C.waitForFunction(() => data && data.access === 'commander', null, { timeout: 8000 });
        // No name typed at sign-in: the first decision asks for it once
        await C.evaluate(() => { document.getElementById('p1hold-by').value = 'Dr A, MERIT'; setP1Hold(true); });
        await C.waitForSelector('#ask-modal.open', { timeout: 5000 });
        await C.click('#ask-ok');
        await C.waitForFunction(() => data.policy && data.policy.p1Hold && data.policy.p1Hold.on, null, { timeout: 5000 });
        await C.evaluate(() => { setP1Hold(false); });
        await C.waitForSelector('#ask-modal.open', { timeout: 5000 });
        await C.click('#ask-ok');                     // "Withdraw P1 Hold?"
        await C.waitForSelector('#ask-input', { state: 'visible', timeout: 5000 });
        await C.fill('#ask-input', 'Silver, Insp Kaur');
        await C.click('#ask-ok');
        await C.waitForFunction(() => data.policy && data.policy.p1Hold && data.policy.p1Hold.on === false, null, { timeout: 5000 });
        await C.evaluate(() => refreshNow());
        await C.waitForFunction(() => /P1 Hold withdrawn — Silver, Insp Kaur/.test(document.getElementById('decisions').textContent), null, { timeout: 8000 });
        assert.match(await C.textContent('#decisions'), /withdrawn \d\d:\d\d by Silver, Insp Kaur/);
        await C._ctx.close();
        await A._ctx.close();
    });
    await test('"I\'m the incident commander" on the start screen creates the incident and the commander page signs in by itself on that phone', async () => {
        const CI = await device('Cmd I');
        await CI.fill('#intro-triager', 'Cdr India');
        await CI.evaluate(() => startAsCommander());
        await CI.waitForFunction(() => cmdActive(), null, { timeout: 8000 });
        await page_visible(CI, '#cmd-modal');
        const d = await CI.evaluate(() => ({ title: document.getElementById('cmd-title').textContent, open: document.getElementById('cmd-open-btn').href, commander: CMD.cfg.commander, role: userRole, link: getComputedStyle(document.getElementById('cmd-link-modal')).display }));
        assert.strictEqual(d.title, 'Incident commander');
        assert.ok(d.commander && d.role === 'HCP');
        assert.strictEqual(d.link, 'none', 'the commander is not asked to link');
        assert.ok(d.open.endsWith('/commander.html#' + (await CI.evaluate(() => CMD.cfg.code))), d.open);
        assert.ok(await CI.evaluate(() => auditLog.some(a => a.action === 'USER_SESSION_START' && /incident commander/.test(a.detail || a.details || JSON.stringify(a)))));
        const CJ = await CI._ctx.newPage();
        await CJ.goto(d.open);
        await CJ.waitForFunction(() => !document.getElementById('dash').classList.contains('hidden'), null, { timeout: 8000 });
        assert.strictEqual(await CJ.evaluate(() => document.getElementById('hdr-incident').textContent.trim().length > 0), true);
        await CI._ctx.close();
    });
    await test('commander exports a GPX with a waypoint per located casualty', async () => {
        const [dl] = await Promise.all([CC.waitForEvent('download'), CC.evaluate(() => exportFile('gpx'))]);
        const gpx = fs.readFileSync(await dl.path(), 'utf8');
        assert.strictEqual((gpx.match(/<wpt /g) || []).length, 2);
    });
    await test('an unchanged incident costs a 304 and the page keeps its data', async () => {
        // phones joined since the last read, which (from v0.14.0) counts as a change: pick that up first
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => document.querySelectorAll('.phone').length >= 4, null, { timeout: 8000 });
        const before = await CC.evaluate(() => data.seq);
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => /no change/.test(document.getElementById('hdr-updated').textContent), null, { timeout: 8000 });
        assert.strictEqual(await CC.evaluate(() => data.seq), before);
        assert.strictEqual(await CC.evaluate(() => document.querySelectorAll('#rows tr').length), 2);
    });
    await test('"Stop sharing" on one phone leaves the others sending', async () => {
        await CB.evaluate(() => { cmdStop(); });
        await answerDialog(CB, true);
        await CB.waitForFunction(() => !cmdActive());
        assert.strictEqual(await CB.evaluate(() => document.getElementById('cmd-pill').style.display), 'none');
        assert.ok(await CB.evaluate(() => auditLog.some(a => a.action === 'COMMANDER_STOPPED')));
        assert.ok(await CA.evaluate(() => cmdActive()));
    });
    await test('the creator can end the incident for everyone; the commander page says so and a joined phone stops', async () => {
        const CE = await device('Cmd E');
        await setup(CE, 'Medic Echo');
        assert.strictEqual(await CE.evaluate((s) => cmdJoin(s.code, s.pin), share), true);
        await CE.waitForFunction(() => CMD.lastSentAt > 0, null, { timeout: 10000 });
        await CA.evaluate(() => { cmdShowDetails(); cmdEndIncident(); });
        await answerDialog(CA, true);
        await CA.waitForFunction(() => !cmdActive(), null, { timeout: 8000 });
        assert.ok(await CA.evaluate(() => auditLog.some(a => a.action === 'COMMANDER_ENDED')));
        await CE.evaluate(() => cmdPush(true));
        await CE.waitForFunction(() => !cmdActive(), null, { timeout: 8000 });
        await CC.evaluate(() => refreshNow());
        await CC.waitForFunction(() => /refused|expired|No such/i.test(document.getElementById('conn-warn').textContent + document.getElementById('status-pill').textContent), null, { timeout: 8000 });
        await CE._ctx.close();
    });
    await test('sharing survives a reload of the phone (settings are kept, records re-sent)', async () => {
        const CF = await device('Cmd F');
        await setup(CF, 'Medic Foxtrot');
        await CF.evaluate(() => { cmdStart(); });
        await answerDialog(CF, true);
        await CF.waitForFunction(() => cmdActive(), null, { timeout: 8000 });
        await CF.evaluate(() => closeCmdDetails());
        await triage(CF, 'TST', [true]);
        await CF.waitForFunction(() => CMD.dirty.size === 0 && CMD.lastSentAt > 0, null, { timeout: 10000 });
        const code = await CF.evaluate(() => CMD.cfg.code);
        await CF.reload(); await CF.waitForFunction(() => dbReady === true);
        await CF.waitForFunction(() => cmdActive() && CMD.lastSentAt > 0, null, { timeout: 10000 });
        assert.strictEqual(await CF.evaluate(() => CMD.cfg.code), code);
        await CF._ctx.close();
    });
    await CA._ctx.close(); await CB._ctx.close(); await CC._ctx.close();

    console.log('\ne2e: demo incident');
    await test('the demo opens in training mode, loads 24 made-up casualties and leaves real records alone', async () => {
        const D = await device('Demo');
        await setup(D, 'Dr Demo');
        await triage(D, 'TST', [true]);
        const realUid = await D.evaluate(() => incidentLog[0].uid);
        await D.evaluate(() => { demoChoose('all'); });
        await D.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING === true && typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 10000 });
        await D.waitForFunction(() => incidentLog.length === 24, null, { timeout: 8000 });
        await page_visible(D, '#demo-modal');
        assert.ok(await D.evaluate(() => document.body.classList.contains('training') && incidentLog.every(r => MITTLib.isDemoRecord(r))));
        assert.match(await D.textContent('#demo-summary'), /24 casualties/);
        assert.strictEqual(await D.evaluate(() => incidentCode), 'DEMO-KESTREL');
        assert.ok(await D.evaluate(() => auditLog.some(a => a.action === 'DEMO_LOADED')));
        // Things to show
        await D.evaluate(() => demoGo('patient'));
        assert.strictEqual(await D.evaluate(() => currentEntry().id), 'DEMO-HT-MITT-001');
        assert.ok(await D.evaluate(() => !!currentEntry().interventions.Tourniquet));
        await D.evaluate(() => demoGo('log'));
        assert.ok(await D.$$eval('#log-body tr', r => r.length) >= 20);
        await D.evaluate(() => demoGo('map'));
        await D.waitForFunction(() => document.querySelectorAll('#map-screen .leaflet-marker-icon').length > 0, null, { timeout: 8000 });
        await D.evaluate(() => showScreen('home-screen'));
        assert.ok(await D.$('#home-demo'), 'orange demo card on the home screen');
        // v0.19.6: a casualty triaged during the demo is practice too, so restarting the demo clears it without asking
        await triage(D, 'TST', [true]);
        assert.strictEqual(await D.evaluate(() => incidentLog.length), 25);
        assert.strictEqual(await D.evaluate(() => MITTLib.isDemoRecord(currentEntry())), true);
        await D.evaluate(() => { demoChoose('all'); });
        await D.waitForFunction(() => incidentLog.length === 24, null, { timeout: 8000 });
        // Back to real use: the real patient is still there and no demo record leaked into it
        await D.evaluate(() => { closeDemoGuide(); toggleTrainingMode(false); });
        await answerDialog(D, true);
        await D.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING === false && typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 10000 });
        assert.deepStrictEqual(await D.evaluate(() => incidentLog.map(r => r.uid)), [realUid]);
        await D._ctx.close();
    });
    await test('as one of the phones: only its casualties, its name and role; real name untouched afterwards', async () => {
        const E = await device('DemoPhone');
        await setup(E, 'Dr Real');
        // One ▶ Demo button at the top of the start screen, then pick a role: commander, one of the four phones, or everything
        await E.evaluate(() => showScreen('intro-screen'));
        await E.click('#btn-demo');
        await page_visible(E, '#demo-role-modal');
        assert.strictEqual(await E.$$eval('#demo-phone-choices button', b => b.length), 4);
        assert.strictEqual(await E.getAttribute('#demo-choose-cmd', 'href'), 'commander.html#DEMO');
        await E.click('#demo-phone-choices button:nth-child(4)');
        await E.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING && typeof dbReady !== 'undefined' && dbReady && incidentLog.length === 8, null, { timeout: 10000 });
        assert.deepStrictEqual(await E.evaluate(() => [triagerName, userRole, demoMode()]), ['Fire crew 3', 'NON_HCP', 'p3']);
        assert.ok(await E.evaluate(() => incidentLog.every(r => r.deviceId === 'DEMOFR')));
        await page_visible(E, '#demo-modal');
        assert.match(await E.textContent('#demo-title'), /Fire crew 3/);
        // Practise receiving: a casualty from another phone arrives through the normal review screen
        await E.evaluate(() => demoReceive());
        await page_visible(E, '#preview-modal');
        await E.click('#btn-accept-preview');
        await E.waitForFunction(() => incidentLog.length === 9, null, { timeout: 5000 });
        assert.ok(await E.evaluate(() => incidentLog.some(r => r.deviceId !== 'DEMOFR')));
        assert.ok(await E.evaluate(() => auditLog.some(a => a.action === 'DEMO_TRANSFER_PRACTICE')));
        await E.evaluate(() => document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; }));
        // Practise handing over: real QR, then the simulated receiver confirmation
        await E.evaluate(() => demoHandover());
        await page_visible(E, '#btn-demo-ack');
        const uid = await E.evaluate(() => document.getElementById('qr-modal').dataset.handoverUid);
        await E.click('#btn-demo-ack');
        await page_visible(E, '#ack-success-modal');
        assert.strictEqual(await E.evaluate(u => incidentLog[indexByUid(u)].handoverState, uid), 'accepted');
        assert.ok(await E.isHidden('#handover-flow-modal'));
        // "Leave demo" in the orange banner: back to real use on the start screen, with the real name and role
        await E.evaluate(() => document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; }));
        assert.ok(await E.isVisible('#btn-leave-demo'));
        assert.match(await E.textContent('#btn-leave-demo'), /Start page/);
        await E.click('#btn-leave-demo');
        await E.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING === false && typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 10000 });
        await E.waitForFunction(() => document.getElementById('intro-screen').classList.contains('active'), null, { timeout: 5000 });
        assert.ok(await E.isHidden('#btn-leave-demo'));
        assert.deepStrictEqual(await E.evaluate(() => [triagerName, userRole, devicePrefix]), ['Dr Real', 'HCP', '']);
        assert.ok(await E.isVisible('#btn-demo'), 'pick another role from the start page');
        await E._ctx.close();
    });
    await test('live exercise: the control room creates it, a demo phone and a CCZ phone link, and both appear on the commander screen', async () => {
        const K = await device('DemoCmd');
        await K.evaluate(() => { demoChoose('cmd'); });
        await K.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING && typeof cmdActive === 'function' && cmdActive() && CMD.cfg.commander, null, { timeout: 15000 });
        const share = await K.evaluate(() => ({ code: CMD.cfg.code, pin: CMD.cfg.pin }));
        assert.strictEqual(await K.evaluate(() => incidentLog.length), 0);
        assert.match(await K.textContent('#training-banner-text'), /EXERCISE — Control room/);
        // A demo phone can link to it
        const F = await device('DemoHART');
        await F.evaluate(() => { demoChoose('p0'); });
        await F.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING && typeof dbReady !== 'undefined' && dbReady && incidentLog.length === 7, null, { timeout: 10000 });
        await F.evaluate(s => { window._join = cmdJoin(s.code, s.pin); }, share);
        await answerDialog(F, true);   // share position: yes
        assert.strictEqual(await F.evaluate(() => window._join), true);
        await F.waitForFunction(() => CMD.dirty.size === 0 && CMD.lastSentAt > 0, null, { timeout: 10000 });
        // A live-exercise CCZ phone: blank, asks for a name, then offers to scan the control room's code
        const C = await device('ExerciseCCZ');
        await C.evaluate(() => startDemo());
        await C.click('#btn-exercise');
        await page_visible(C, '#exercise-modal');
        await C.evaluate(() => showExerciseGuide());
        await page_visible(C, '#exercise-guide-modal');
        await C.evaluate(() => closeExerciseGuide());
        await C.evaluate(() => { exerciseChoose('xc'); });
        await C.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING && typeof dbReady !== 'undefined' && dbReady, null, { timeout: 10000 });
        await answerDialog(C, true, 'Nurse CCZ');
        await page_visible(C, '#cmd-link-modal');
        assert.deepStrictEqual(await C.evaluate(() => [triagerName, userRole, currentSector, incidentLog.length, demoMode()]), ['Nurse CCZ', 'HCP', 'Casualty clearing station', 0, 'xc']);
        assert.match(await C.textContent('#training-banner-text'), /EXERCISE — Casualty clearing station/);
        assert.ok(await C.$('#home-exercise'));
        await C.evaluate(s => { window._join = cmdJoin(s.code, s.pin); }, share);
        await answerDialog(C, false);
        assert.strictEqual(await C.evaluate(() => window._join), true);
        await triage(C, 'MITT', [true]);
        await C.waitForFunction(() => incidentLog.length === 1 && CMD.dirty.size === 0 && CMD.lastSentAt > 0, null, { timeout: 10000 });
        assert.ok(await C.evaluate(() => incidentLog[0].atCcs), 'a CCZ phone records its patients as at the CCS');
        const P = await K._ctx.newPage();
        P.on('pageerror', e => errors.push(`DemoCmdPage: ${e.message}`));
        await P.goto(url.replace('index.html', 'commander.html#' + share.code));
        await P.waitForFunction(() => /8 casualties in total/.test(document.getElementById('counts').textContent), null, { timeout: 10000 });
        assert.match(await P.textContent('#phones'), /HART 1/);
        assert.match(await P.textContent('#phones'), /Nurse CCZ/);
        await K._ctx.close(); await F._ctx.close(); await C._ctx.close();
    });

    await test('the commander demo shows the incident with no sign-in and no network, and plays its events', async () => {
        const ctx = await browser.newContext({ serviceWorkers: 'block' });
        const P = await ctx.newPage();
        P.on('pageerror', e => errors.push(`CmdDemo: ${e.message}`));
        const api = [];
        P.on('request', r => { if (r.url().includes('/api/')) api.push(r.url()); });
        await P.addInitScript(() => { const real = Date.now; let skew = 0; window.__skip = (ms) => { skew += ms; }; Date.now = () => real() + skew; });
        await P.goto(url.replace('index.html', 'commander.html#DEMO'));
        await P.waitForFunction(() => document.querySelectorAll('#rows tr').length > 0, null, { timeout: 8000 });
        assert.match(await P.textContent('#status-pill'), /Demo/);
        assert.match(await P.textContent('#training-banner'), /DEMO/);
        assert.ok(await P.isHidden('#signin'));
        assert.strictEqual(await P.$$eval('#rows tr', r => r.length), 21, 'on-scene casualties');
        assert.match(await P.textContent('#counts'), /24 casualties in total/);
        assert.strictEqual(await P.$$eval('#phones .phone', r => r.length), 4);
        await P.evaluate(() => { __skip(5 * 60 * 1000); refreshNow(); });
        await P.waitForFunction(() => /26 casualties in total/.test(document.getElementById('counts').textContent), null, { timeout: 5000 });
        // any row opens the patient's full details; TST-only patients are marked and can be filtered
        assert.ok(await P.evaluate(() => document.querySelectorAll('#rows .tool-chip.tst').length > 0 && document.querySelectorAll('#rows .tool-chip.mitt').length > 0), 'both TST-only and MITT chips shown');
        await P.click('#rows tr:first-child');
        await P.waitForSelector('#pt-modal.open', { timeout: 3000 });
        const pt = await P.evaluate(() => ({ id: document.getElementById('pt-id').textContent, body: document.getElementById('pt-body').textContent, chips: document.getElementById('pt-chips').textContent }));
        assert.match(pt.id, /^DEMO-/);
        assert.match(pt.body, /Triage/); assert.match(pt.body, /Interventions/); assert.match(pt.body, /Grid ref/); assert.match(pt.body, /Triaged by/);
        assert.match(pt.chips, /P1|P2|P3/);
        await P.keyboard.press('Escape');
        assert.ok(!(await P.evaluate(() => document.getElementById('pt-modal').classList.contains('open'))));
        await P.evaluate(() => setStageFilter('tst'));
        const tstRows = await P.$$eval('#rows tr', r => r.length);
        assert.ok(tstRows > 0 && tstRows < 21, 'TST-only filter narrows the list: ' + tstRows);
        assert.strictEqual(await P.evaluate(() => document.querySelectorAll('#rows .tool-chip.mitt').length), 0);
        assert.match(await P.textContent('#stages'), new RegExp(tstRows + '\\s*TST only'));
        await P.evaluate(() => setStageFilter('scene'));
        await P.evaluate(() => toggleWall());
        assert.ok(await P.evaluate(() => document.body.classList.contains('wall')));
        await P.evaluate(() => { toggleWall(); signOut(); });
        assert.ok(await P.isVisible('#signin'));
        assert.deepStrictEqual(api, []);
        await ctx.close();
    });
    await test('commander demo "↩ Start page" goes back to the start screen and leaves the demo', async () => {
        const G = await device('DemoBack');
        await setup(G, 'Dr Back');
        await G.evaluate(() => { demoChoose('p1'); });
        await G.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING && typeof dbReady !== 'undefined' && dbReady && incidentLog.length > 0, null, { timeout: 10000 });
        await G.goto(url.replace('index.html', 'commander.html#DEMO'));
        await G.waitForFunction(() => document.querySelectorAll('#rows tr').length > 0, null, { timeout: 8000 });
        assert.ok(await G.isVisible('#btn-start-page'));
        assert.ok(await G.isHidden('#btn-signout'));
        await G.click('#btn-start-page');
        await G.waitForFunction(() => typeof TRAINING !== 'undefined' && TRAINING === false && typeof dbReady !== 'undefined' && dbReady === true && document.getElementById('intro-screen').classList.contains('active'), null, { timeout: 15000 });
        assert.ok(!/#start/.test(G.url()));
        assert.deepStrictEqual(await G.evaluate(() => [triagerName, userRole]), ['Dr Back', 'HCP']);
        await G._ctx.close();
    });

    console.log('\ne2e: v0.15.0 tags, printed numbers, clear and restart');
    await test('v0.15.0: a scanned tag becomes the patient ID; scanning it again opens the patient; an unknown tag offers to start one', async () => {
        const K = await device('K');
        await setup(K, 'Medic K');
        // Scan tag mode: a tag read for a new patient starts triage with that ID.
        await K.evaluate(() => { setIdMode('SCAN'); _tagTarget = 'new'; _tagDone = false; scanMode = 'TAG'; });
        await K.evaluate(() => onScanSuccess('wm-04471'));
        await K.waitForFunction(() => document.getElementById('question-screen').classList.contains('active'), null, { timeout: 5000 });
        assert.strictEqual(await K.textContent('#q-patient-id'), 'WM-04471');
        await K.evaluate(() => { handleAnswer(false); handleAnswer(true); });
        assert.strictEqual(await K.textContent('#r-patient-id'), 'WM-04471');
        assert.ok(await K.evaluate(() => auditLog.some(a => a.action === 'TAG_SCANNED' && a.patientId === 'WM-04471')));
        // The card number can be scanned into the open record.
        await K.evaluate(() => { _tagTarget = 'card'; _tagDone = false; scanMode = 'CARD'; return onScanSuccess('0427'); });
        assert.strictEqual(await K.inputValue('#p-card-no'), '0427');
        assert.strictEqual(await K.evaluate(() => currentEntry().cardNo), '0427');
        // Receive / find: a plain code the phone knows opens that patient (by ID or card number).
        await K.evaluate(() => resetToHome());
        await K.evaluate(() => { _scanLastTs = 0; scanMode = 'RECEIVE'; return onScanSuccess('0427'); });   // same code within 2 s is debounced
        await K.waitForFunction(() => document.getElementById('result-screen').classList.contains('active'), null, { timeout: 5000 });
        assert.strictEqual(await K.textContent('#r-patient-id'), 'WM-04471');
        // An unknown tag offers to start a new patient with it.
        await K.evaluate(() => resetToHome());
        await K.evaluate(() => { scanMode = 'RECEIVE'; onScanSuccess('WM-04472'); });
        await page_visible(K, '#confirm-modal');
        assert.match(await K.textContent('#confirm-title'), /WM-04472/);
        await K.click('#confirm-ok');
        await K.waitForFunction(() => document.getElementById('question-screen').classList.contains('active'), null, { timeout: 5000 });
        assert.strictEqual(await K.textContent('#q-patient-id'), 'WM-04472');
        await K.evaluate(() => handleAnswer(true));
        // The same tag read again for a new patient is caught as a duplicate (same patient → re-triage).
        await K.evaluate(() => { _scanLastTs = 0; _tagTarget = 'new'; _tagDone = false; scanMode = 'TAG'; onScanSuccess('WM-04472'); });
        await page_visible(K, '#confirm-modal');
        assert.match(await K.textContent('#confirm-title'), /already exists/);
        await K.click('#confirm-cancel');
        await K.evaluate(() => closeManualId());
        // An app QR is not a tag.
        await K.evaluate(() => { _tagTarget = 'new'; _tagDone = false; scanMode = 'TAG'; onScanSuccess('{"t":"MIT_JOIN","code":"ABC123"}'); });
        await page_visible(K, '#confirm-modal');
        assert.match(await K.textContent('#confirm-title'), /app code/);
        await K.click('#confirm-ok');
        await K.evaluate(() => closeManualId());
        await K._ctx.close();
    });
    await test('v0.15.0: the printed-number reader (OCR, on the phone) reads a printed code from a camera frame', async () => {
        const K = await device('K2');
        const r = await K.evaluate(async () => {
            const c = document.createElement('canvas'); c.width = 1200; c.height = 300;
            const ctx = c.getContext('2d'); ctx.fillStyle = '#f4f1e8'; ctx.fillRect(0, 0, c.width, c.height);
            ctx.fillStyle = '#222'; ctx.font = 'bold 110px Arial, Helvetica, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText('WM-04471', 60, 150);
            return ocrCanvas(c);
        });
        assert.ok(r.candidates.includes('WM-04471'), 'candidates: ' + JSON.stringify(r));
        await K._ctx.close();
    });
    await test('v0.15.0: "Clear everything and start again" wipes the records in one step (CLEAR typed on a real-use phone) and keeps the user', async () => {
        const K = await device('K3');
        await setup(K, 'Medic K3');
        await triage(K, 'TST', [false, true]);
        assert.strictEqual(await K.evaluate(() => incidentLog.length), 1);
        await K.evaluate(() => { clearAndRestart(); });   // reloads the page, so do not await its promise
        await page_visible(K, '#confirm-modal');
        assert.strictEqual(await K.evaluate(() => document.getElementById('confirm-ok').disabled), true, 'OK waits for CLEAR to be typed');
        await Promise.all([K.waitForNavigation({ timeout: 20000 }), answerDialog(K, true, 'CLEAR')]);
        await K.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 15000 });
        assert.deepStrictEqual(await K.evaluate(() => [incidentLog.length, triagerName, wipeHistory.length, auditLog.filter(a => a.action === 'DATA_WIPE').length]), [0, 'Medic K3', 1, 1]);
        // Reset the phone completely: nothing of the app remains in storage.
        await K.evaluate(() => { factoryReset(); });
        await Promise.all([K.waitForNavigation({ timeout: 20000 }), answerDialog(K, true, 'RESET')]);
        await K.waitForFunction(() => typeof dbReady !== 'undefined' && dbReady === true, null, { timeout: 15000 });
        assert.strictEqual(await K.evaluate(() => triagerName), '');
        // The fresh start writes its own defaults again, so check the old state is gone rather than that storage is empty.
        assert.deepStrictEqual(await K.evaluate(() => [incidentLog.length, auditLog.map(a => a.action), wipeHistory.length, userRole, localStorage.getItem('mit_user_role')]), [0, ['APP_START'], 0, null, null]);
        assert.strictEqual(await K.evaluate(() => document.getElementById('intro-screen').classList.contains('active')), true);
        await K._ctx.close();
    });

    console.log('\ne2e: v0.16.0 shared picture (tag pick-up, map markings, debrief, rough count, voice notice)');
    await test('v0.16.0: a tag recorded on one phone is picked up from the server on another; commander markings reach the phones; debrief timings show', async () => {
        const P = await device('P16'); await setup(P, 'Medic Papa');
        await P.evaluate(() => { cmdStart(); });
        await answerDialog(P, true);
        await P.waitForFunction(() => cmdActive(), null, { timeout: 8000 });
        const sh = await P.evaluate(() => { closeCmdDetails(); return { code: CMD.cfg.code, pin: CMD.cfg.pin, cmdPin: CMD.cfg.cmdPin }; });
        await triage(P, 'MITT', [true]);
        await P.evaluate(() => { const e = currentEntry(); e.cardNo = 'WM-9001'; touch(e, ['cardNo']); saveState(); });
        await P.waitForFunction(() => CMD.dirty.size === 0 && CMD.lastSentAt > 0 && !CMD.inflight, null, { timeout: 10000 });
        const pUid = await P.evaluate(() => incidentLog[0].uid);
        const Q = await device('Q16'); await setup(Q, 'Medic Quebec');
        assert.strictEqual(await Q.evaluate((s) => cmdJoin(s.code, s.pin), sh), true);
        // Q scans the card number it has never seen: the server's copy is offered through review-and-accept.
        await Q.evaluate(() => { offerTagLookup('WM-9001'); });
        await page_visible(Q, '#preview-modal');
        assert.match(await Q.textContent('#preview-warn'), /copied from the commander server/);
        await Q.evaluate(() => acceptPreview());
        await Q.waitForFunction(() => incidentLog.length === 1, null, { timeout: 5000 });
        assert.strictEqual(await Q.evaluate(() => incidentLog[0].uid), pUid, 'same uid, so the two copies merge later');
        assert.strictEqual(await Q.evaluate(() => document.getElementById('qr-modal').style.display === 'flex'), false, 'no ACK QR for a server pick-up');
        assert.ok(await Q.evaluate(() => auditLog.some(a => a.action === 'SERVER_LOOKUP') && auditLog.some(a => a.action === 'SERVER_PICKUP')));
        assert.strictEqual(await Q.evaluate(() => document.getElementById('result-screen').classList.contains('active')), true, 'the picked-up patient opens');
        // An unknown tag that no phone has still offers to start a new patient.
        await Q.evaluate(() => { resetToHome(); offerTagLookup('WM-0000'); });
        await page_visible(Q, '#confirm-modal');
        assert.match(await Q.textContent('#confirm-title'), /WM-0000/);
        await Q.click('#confirm-cancel');
        // Commander marks the map; the phones receive it with their next report and show it.
        const CM = await device('Cmd16', { viewport: { width: 1280, height: 900 }, permissions: [] });
        await CM.goto(url.replace('index.html', 'commander.html#' + sh.code));
        await CM.fill('#in-pin', sh.cmdPin);
        await CM.fill('#in-by', 'Silver');
        await CM.click('#signin button');
        await CM.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1, null, { timeout: 8000 });
        assert.notStrictEqual(await CM.evaluate(() => document.getElementById('mark-tools').style.display), 'none');
        await CM.evaluate(() => { document.getElementById('mark-type').value = 'inner'; markTypeChanged(); document.getElementById('mark-radius').value = '150'; startMarking(); onMapClickMark({ latlng: { lat: 53.481, lng: -2.243 } }); });
        await CM.waitForFunction(() => (data.marks || []).length === 1, null, { timeout: 5000 });
        await CM.evaluate(() => { document.getElementById('mark-type').value = 'rvp'; markTypeChanged(); document.getElementById('mark-label').value = 'Main gate'; startMarking(); onMapClickMark({ latlng: { lat: 53.482, lng: -2.244 } }); });
        await CM.waitForFunction(() => (data.marks || []).length === 2, null, { timeout: 5000 });
        assert.match(await CM.textContent('#mark-list'), /RVP: Main gate/);
        assert.strictEqual(await CM.evaluate(() => document.querySelectorAll('#map .mk-mark').length), 2);
        await Q.evaluate(() => cmdPush(true));
        await Q.waitForFunction(() => (CMD.cfg.marks || []).length === 2, null, { timeout: 8000 });
        assert.ok(await Q.evaluate(() => auditLog.some(a => a.action === 'COMMANDER_MARKS' && /RVP Main gate/.test(a.details))));
        await Q.evaluate(() => showMap());
        await Q.waitForFunction(() => document.querySelectorAll('#patient-map .mk-mark').length === 2, null, { timeout: 5000 });
        // Removing one on the commander screen removes it on the phones too.
        await CM.evaluate(() => removeMark(data.marks[0].id));
        await CM.waitForFunction(() => (data.marks || []).length === 1, null, { timeout: 5000 });
        await Q.evaluate(() => cmdPush(true));
        await Q.waitForFunction(() => (CMD.cfg.marks || []).length === 1, null, { timeout: 8000 });
        assert.strictEqual(await Q.evaluate(() => document.querySelectorAll('#patient-map .mk-mark').length), 1);
        // Debrief timings: the commander card and the phone.
        assert.match(await CM.textContent('#debrief'), /First casualty recorded/);
        assert.match(await CM.textContent('#debrief'), /First P1 identified/);
        await Q.evaluate(() => { resetToHome(); showDebriefTimings(); });
        await page_visible(Q, '#confirm-modal');
        assert.match(await Q.textContent('#confirm-title'), /Debrief timings/);
        assert.match(await Q.textContent('#confirm-message'), /First P1 identified: \d\d:\d\d/);
        await Q.click('#confirm-ok');
        // The view-only PIN hides the marking tools.
        const viewPin = await P.evaluate(() => CMD.cfg.viewPin);
        const CV = await browser.newPage();
        CV.on('pageerror', e => errors.push(`Cmd16 V: ${e.message}`));
        await CV.goto(url.replace('index.html', 'commander.html#' + sh.code));
        await CV.fill('#in-pin', viewPin);
        await CV.click('#signin button');
        await CV.waitForFunction(() => document.querySelectorAll('#rows tr').length >= 1, null, { timeout: 8000 });
        assert.strictEqual(await CV.evaluate(() => document.getElementById('mark-tools').style.display), 'none');
        assert.strictEqual(await CV.evaluate(() => document.querySelectorAll('#map .mk-mark').length), 1, 'view-only still sees the markings');
        await CV.close();
        await CM._ctx.close(); await P._ctx.close(); await Q._ctx.close();
    });
    await test('v0.16.0: the METHANE rough count tallies, undoes and fills N; voice notes are training-only and refuse offline', async () => {
        const R = await device('R16', { initScript: () => { window.SpeechRecognition = window.webkitSpeechRecognition = function () { this.start = () => { window._voiceStarted = (window._voiceStarted || 0) + 1; }; }; } });
        await setup(R, 'Medic Romeo');
        await R.evaluate(() => { showMethane(); toggleTally(true); });
        await R.evaluate(() => { tallyAdd('walking'); tallyAdd('walking'); tallyAdd('lying'); tallyAdd('dead'); tallyUndo(); });
        assert.deepStrictEqual(await R.evaluate(() => ['walking', 'lying', 'dead'].map(k => document.getElementById('tally-' + k).textContent)), ['2', '1', '0']);
        await R.evaluate(() => tallyToMethane());
        assert.match(await R.inputValue('#m-num'), /^Rough count, not yet triaged at \d\d:\d\d: about 3 \(walking 2, lying 1, apparently dead 0\)$/);
        assert.ok(await R.evaluate(() => auditLog.some(a => a.action === 'ROUGH_COUNT')));
        // Voice (G9): training only. Real use hides the button and refuses without starting the microphone.
        await triage(R, 'TST', [true]);
        assert.strictEqual(await R.evaluate(() => getComputedStyle(document.querySelector('.voice-btn')).display), 'none');
        await R.evaluate(() => { startVoice('p-notes'); });
        assert.strictEqual(await R.evaluate(() => window._voiceStarted || 0), 0);
        assert.strictEqual(await R.evaluate(() => getComputedStyle(document.getElementById('confirm-modal')).display), 'none', 'no question asked');
        await R._ctx.close();
        // In training it starts at once, and still refuses offline
        const RT = await device('R16T', { initScript: () => { try { localStorage.setItem('mit_training', '1'); } catch (e) {} window.SpeechRecognition = window.webkitSpeechRecognition = function () { this.start = () => { window._voiceStarted = (window._voiceStarted || 0) + 1; }; }; } });
        await setup(RT, 'Medic Romeo');
        await triage(RT, 'TST', [true]);
        assert.notStrictEqual(await RT.evaluate(() => getComputedStyle(document.querySelector('.voice-btn')).display), 'none');
        await RT.evaluate(() => startVoice('p-notes'));
        await RT.waitForFunction(() => window._voiceStarted === 1, null, { timeout: 3000 });
        await RT._ctx.setOffline(true);
        await RT.evaluate(() => startVoice('p-notes'));
        assert.strictEqual(await RT.evaluate(() => window._voiceStarted), 1, 'no voice without a connection');
        await RT._ctx.setOffline(false);
        await RT._ctx.close();
    });

    await test('no uncaught page errors', async () => { assert.deepStrictEqual(errors, []); });

    await browser.close();
    srv.close();
    console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);

    async function page_visible(page, sel) { await page.waitForSelector(sel, { state: 'visible', timeout: 5000 }); }
})().catch(e => { console.error(e); process.exit(1); });
