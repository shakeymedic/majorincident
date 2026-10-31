// Linked demo, phone side (Jake, 31 Oct 2026). Runs only when the page was opened from a demo link
// (index.html#code=…&pin=…&as=p0…, made by demo.html). It:
//  - puts the phone in training mode and sets it up as one of the demo incident's phones (name, role, sector);
//  - links it to the practice incident with the code and PIN from the link;
//  - can "auto-play" that phone's made-up casualties through the real triage questions, one at a time, tapping
//    the same YES / NO buttons a person would, so the commander screen fills as it would in a real incident.
// Anyone can still use the phone by hand at any time: auto-play waits while someone is using it, and only starts a
// casualty from the home screen. Nothing here runs on a phone opened normally.
(function () {
    'use strict';
    var L = window.MITT_DEMO_LINK;
    if (!L) return;
    var W = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var lastHuman = 0;
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, function (e) { if (e.isTrusted && !(e.target && e.target.closest && e.target.closest('#demo-play-badge'))) lastHuman = Date.now(); }, true); });

    function phoneSpec() { return MITTLib.DEMO_INCIDENT.phones[Number(L.role.slice(1))] || MITTLib.DEMO_INCIDENT.phones[0]; }
    function demoName() { return phoneSpec().triager + ' (demo)'; }
    function visibleModal() { return Array.prototype.some.call(document.querySelectorAll('.modal-overlay'), function (m) { return getComputedStyle(m).display !== 'none'; }); }

    async function setUp() {
        var n = 0;
        while ((typeof dbReady === 'undefined' || !dbReady) && n++ < 100) await W(100);
        if (!TRAINING) {
            // On another device: a demo link always means practice. Switch to training and reload (the link is kept).
            try { localStorage.setItem('mit_training', '1'); } catch (e) {}
            location.reload();
            return false;
        }
        if (cmdActive() && CMD.cfg.code === L.code) return true;
        var ph = phoneSpec();
        try { sessionStorage.setItem('mit_cmd_link_dismissed', '1'); } catch (e) {}
        setPosShare(true, 'demo link');
        if (ph.sector) { currentSector = ph.sector; try { ls('mit_sector', ph.sector); } catch (e) {} }
        showScreen('intro-screen');
        introPath(ph.role === 'HCP' ? 'med' : 'non');
        $('intro-triager').value = demoName();
        setUserRole(ph.role, false, ph.role === 'HCP' ? (/doctor/i.test(ph.triager) ? 'doctor_nurse' : 'paramedic') : undefined);
        await W(300);
        try { closeCmdLink(); } catch (e) {}
        var ok = await cmdJoin(L.code, L.pin);
        return !!ok;
    }

    // The made-up casualties this phone records in the demo scenario, oldest first: tool, category and reason of
    // its first triage, where it is, and its notes.
    function queueFor() {
        var ph = phoneSpec();
        var d = MITTLib.buildDemoScenario({ now: Date.now() });
        return d.records.filter(function (r) { return r.deviceId === ph.deviceId; })
            .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); })
            .map(function (r) {
                var h = (r.triageHistory || [])[0] || {};
                return { tool: h.tool || r.tool, category: h.category || r.category, reason: h.reason || (h.tool && h.tool !== r.tool ? '' : r.reason), loc: r.initialLocation || r.location, landmark: r.landmark || '', notes: r.notes || '', sector: r.sector || '' };
            })
            .filter(function (c) { return c.category !== 'P1_HOLD' && (c.tool === 'TST' || phoneSpec().role === 'HCP'); });
    }
    // The YES / NO answers that lead to this result, found by trying the app's own question logic.
    function answersFor(c) {
        var flow = flowFor(c.tool);
        var start = flow[0].id;
        var todo = [{ step: start, path: [] }];
        var fallback = null;
        while (todo.length) {
            var cur = todo.shift();
            if (cur.path.length > 8) continue;
            for (var i = 0; i < 2; i++) {
                var ans = i ? 'NO' : 'YES';
                var o = outcomeFor(c.tool, cur.step, ans);
                if (!o) continue;
                var path = cur.path.concat([ans]);
                if (o.type === 'next') { if (o.step !== 'bleeding_u2') todo.push({ step: o.step, path: path }); continue; }
                if (o.category === c.category && (!c.reason || o.reason === c.reason)) return path;
                if (o.category === c.category && !fallback) fallback = path;
            }
        }
        return fallback;
    }
    async function tap(re) {
        var b = Array.prototype.filter.call(document.querySelectorAll('button'), function (x) { return x.offsetParent && re.test(x.innerText); })[0];
        if (!b) return false;
        b.click();
        await W(Math.round(750 / L.speed));
        return true;
    }
    async function playOne(c) {
        var path = answersFor(c);
        if (!path) return false;
        if (window.MITT_SIM && c.loc && c.loc.lat) window.MITT_SIM_POS = { lat: Number(c.loc.lat), lng: Number(c.loc.lng), acc: 6 };
        await W(5500);   // let the simulated position arrive before the casualty is recorded
        if (document.body.dataset.screen !== 'home-screen' || visibleModal()) return false;
        if (c.tool === 'MITT') { if (!(await tap(/MITT triage/))) return false; }
        else if (!(await tap(/START TRIAGE/))) return false;
        for (var i = 0; i < path.length; i++) {
            if (document.body.dataset.screen !== 'question-screen') break;
            await tap(path[i] === 'YES' ? /^\s*✓\s*YES/ : /^\s*✕\s*NO/);
        }
        await W(600);
        var tod = Array.prototype.filter.call(document.querySelectorAll('#tod-modal button'), function (x) { return x.offsetParent && /no time yet/.test(x.innerText); })[0];
        if (tod) { tod.click(); await W(600); }
        // Where and what, as a triager would add after the questions.
        var set = function (id, v) { var e = $(id); if (!e || !v) return; e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
        set('p-landmark', c.landmark); set('p-notes', c.notes);
        try { commitDirtyFields('Demo auto-play'); } catch (e) {}
        await W(Math.round(1500 / L.speed));
        try { resetToHome(); } catch (e) { await tap(/🏠/); }
        return true;
    }

    var play = { on: L.play, queue: [], done: 0, busy: false };
    function badge() {
        var b = $('demo-play-badge');
        if (!b) {
            b = document.createElement('button');
            b.type = 'button'; b.id = 'demo-play-badge';
            b.setAttribute('style', 'position:fixed; left:8px; bottom:8px; z-index:3000; border:2px solid #fff; border-radius:999px; padding:8px 12px; font-weight:800; font-size:0.85rem; color:#fff; background:#7C2855; box-shadow:0 2px 6px rgba(0,0,0,0.4); cursor:pointer; max-width:calc(100% - 16px);');
            b.addEventListener('click', function () { play.on = !play.on; badge(); if (play.on) loop(); });
            document.body.appendChild(b);
        }
        var left = play.queue.length;
        b.textContent = '🎬 ' + demoName() + ' · ' + (left ? (play.on ? '⏸ Auto-play on (' + left + ' left)' : '▶ Auto-play (' + left + ' left)') : 'auto-play finished');
        b.title = play.on ? 'Tap to pause auto-play. You can use the phone yourself at any time.' : 'Tap to let this phone record its made-up casualties by itself.';
    }
    async function loop() {
        if (play.busy) return;
        play.busy = true;
        try {
            while (play.on && play.queue.length) {
                var gap = Math.round((12000 + Math.random() * 10000) / L.speed);
                await W(gap);
                if (!play.on) break;
                if (Date.now() - lastHuman < 15000 || document.body.dataset.screen !== 'home-screen' || visibleModal()) continue;
                var c = play.queue[0];
                var ok = await playOne(c);
                if (ok) { play.queue.shift(); play.done++; }
                badge();
            }
        } finally { play.busy = false; badge(); }
    }
    (async function () {
        var linked = false;
        try { linked = await setUp(); } catch (e) { linked = false; }
        if (!linked) return;
        // Never replay casualties already recorded on this phone (after a reload).
        var have = (typeof incidentLog !== 'undefined' ? incidentLog : []).length;
        play.queue = queueFor().slice(have);
        badge();
        if (play.on) loop();
    })();
})();
