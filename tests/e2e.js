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
function serve() {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
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
        await page.evaluate(r => setUserRole(r), role || 'HCP');
    }
    // Resolve the next in-app dialog with OK (true) or Cancel (false), optionally typing text.
    async function answerDialog(page, ok, text) {
        await page.waitForSelector('#confirm-modal', { state: 'visible', timeout: 5000 });
        if (text !== undefined) await page.fill('#confirm-input', text);
        await page.click(ok ? '#confirm-ok' : '#confirm-cancel');
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
        return new Html5Qrcode('dec-host').scanFile(new File([blob], 'q.png', { type: 'image/png' }), false);
    }, sel);
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
    await test('no uncaught page errors', async () => { assert.deepStrictEqual(errors, []); });

    await browser.close();
    srv.close();
    console.log('\n' + (failed === 0 ? '✓' : '✗') + ` ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);

    async function page_visible(page, sel) { await page.waitForSelector(sel, { state: 'visible', timeout: 5000 }); }
})().catch(e => { console.error(e); process.exit(1); });
