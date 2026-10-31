// Linked demo launcher (demo.html). Starts a practice incident on the server, then shows the commander screen and
// up to four demo phones side by side on this computer, each a separate copy of the app (index.html#sim=N) linked
// to that incident. QR codes let other devices join the same incident as a demo crew.
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var state = null;   // { code, pin, commanderPin, phones, play, speed }
    var KEY = 'mit_linked_demo';

    function phoneLink(i, forOtherDevice) {
        var h = 'code=' + state.code + '&pin=' + state.pin + '&as=p' + i + '&play=' + (state.play ? '1' : '0') + '&speed=' + state.speed;
        return (forOtherDevice ? location.origin + '/index.html' : 'index.html') + '#' + (forOtherDevice ? '' : 'sim=' + (i + 1) + '&') + h;
    }
    // A demo phone slot starts empty: no casualties or link left over from an earlier demo.
    function clearSlot(n) {
        var prefix = 'sim' + n + ':';
        try { Object.keys(localStorage).filter(function (k) { return k.indexOf(prefix) === 0; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
        try { Object.keys(sessionStorage).filter(function (k) { return k.indexOf(prefix) === 0; }).forEach(function (k) { sessionStorage.removeItem(k); }); } catch (e) {}
        return new Promise(function (resolve) {
            try { var r = indexedDB.deleteDatabase('MITT_SIM' + n + '_DB'); r.onsuccess = r.onerror = r.onblocked = function () { resolve(); }; } catch (e) { resolve(); }
        });
    }
    async function api(path, opts) {
        opts = opts || {};
        var headers = { 'Content-Type': 'application/json' };
        if (opts.pin) headers['x-incident-pin'] = opts.pin;
        var r = await fetch('/api/incident' + path, { method: opts.method || 'POST', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
        var j = null; try { j = await r.json(); } catch (e) {}
        return { status: r.status, body: j || {} };
    }
    function show(which) {
        $('setup').style.display = which === 'setup' ? '' : 'none';
        $('links').style.display = which === 'links' ? '' : 'none';
        $('stage').classList.toggle('on', which === 'stage');
        $('btn-links').style.display = state ? '' : 'none';
        $('btn-end').style.display = state ? '' : 'none';
        $('hdr-code').textContent = state ? 'Incident ' + state.code + ' · triagers\' PIN ' + state.pin : '';
    }
    async function openStage() {
        // The commander screen signs in by itself from this tab's session (commander.js reads it on load).
        try { sessionStorage.setItem('mit_commander', JSON.stringify({ code: state.code, pin: state.commanderPin, by: 'Demo commander' })); } catch (e) {}
        $('cmd-frame').src = 'commander.html#' + state.code;
        var box = $('phones');
        box.innerHTML = '';
        for (var i = 0; i < state.phones; i++) {
            var ph = MITTLib.DEMO_INCIDENT.phones[i];
            var wrap = document.createElement('div'); wrap.className = 'phone';
            var lbl = document.createElement('div'); lbl.className = 'lbl';
            var name = document.createElement('span'); name.textContent = '📱 ' + ph.triager + ' — ' + (ph.role === 'HCP' ? 'medical' : 'not medical');
            var pop = document.createElement('a'); pop.href = phoneLink(i, false); pop.target = '_blank'; pop.rel = 'opener'; pop.textContent = 'Open in its own window';
            pop.title = 'The same demo phone in its own window (close this panel\'s copy first, or both will record).';
            lbl.appendChild(name); lbl.appendChild(pop);
            var frame = document.createElement('div'); frame.className = 'frame';
            var f = document.createElement('iframe'); f.title = 'Demo phone ' + (i + 1) + ': ' + ph.triager; f.src = phoneLink(i, false);
            f.setAttribute('allow', 'geolocation; camera');
            frame.appendChild(f); wrap.appendChild(lbl); wrap.appendChild(frame); box.appendChild(wrap);
        }
        $('stage').classList.toggle('one', state.phones === 0);
        show('stage');
    }
    function renderLinks() {
        var list = $('link-list');
        list.innerHTML = '';
        var add = function (title, url, note) {
            var d = document.createElement('div'); d.className = 'link';
            var b = document.createElement('b'); b.textContent = title; d.appendChild(b);
            var q = document.createElement('div'); d.appendChild(q);
            try { new QRCode(q, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { q.textContent = '(QR code unavailable)'; }
            var a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = url; d.appendChild(a);
            if (note) { var p = document.createElement('p'); p.className = 'muted'; p.textContent = note; d.appendChild(p); }
            list.appendChild(d);
        };
        MITTLib.DEMO_INCIDENT.phones.forEach(function (ph, i) { add('📱 ' + ph.triager + (ph.role === 'HCP' ? ' (medical)' : ' (not medical)'), phoneLink(i, true), i < state.phones ? 'Also shown on this computer: use a different crew on each device, or close that copy, so one crew is not recorded twice.' : ''); });
        add('🖥 Commander screen', location.origin + '/commander.html#' + state.code, 'Sign in with code ' + state.code + ' and the commander PIN ' + state.commanderPin + '.');
        show('links');
    }
    async function start() {
        $('err').textContent = '';
        $('btn-start').disabled = true;
        try {
            var n = Number($('n-phones').value) || 3;
            for (var i = 1; i <= 4; i++) await clearSlot(i);
            var r = await api('', { body: { deviceId: 'DEMOLNK', keys: true, training: true, name: 'Linked demo: stand collapse at a festival (fictional)', incidentCode: 'DEMO-LINKED', triager: 'Demo commander', app: 'demo' } });
            if (r.status !== 201) { $('err').textContent = (r.body && r.body.message) || ('Could not start the practice incident (server replied ' + r.status + ').'); return; }
            state = { code: r.body.code, pin: r.body.pin, commanderPin: r.body.commanderPin, phones: n, play: $('auto').value === '1', speed: Number($('speed').value) || 1 };
            try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
            await openStage();
        } catch (e) {
            $('err').textContent = 'Could not reach the server. The linked demo needs a signal. (' + ((e && e.message) || e) + ')';
        } finally { $('btn-start').disabled = false; }
    }
    async function end() {
        if (!state) return;
        if (!confirmEnd()) return;
        try { await api('/' + state.code + '/close', { pin: state.commanderPin, body: {} }); } catch (e) {}
        $('cmd-frame').src = 'about:blank';
        $('phones').innerHTML = '';
        for (var i = 1; i <= 4; i++) await clearSlot(i);
        state = null;
        try { sessionStorage.removeItem(KEY); sessionStorage.removeItem('mit_commander'); } catch (e) {}
        show('setup');
    }
    // A plain question in the page (no browser confirm(), which freezes embedded pages).
    var endArmed = 0;
    function confirmEnd() {
        if (Date.now() - endArmed < 4000) { endArmed = 0; $('btn-end').textContent = 'End demo'; return true; }
        endArmed = Date.now();
        $('btn-end').textContent = 'Tap again to end the demo';
        setTimeout(function () { if (endArmed) { endArmed = 0; $('btn-end').textContent = 'End demo'; } }, 4000);
        return false;
    }
    $('btn-start').addEventListener('click', start);
    $('btn-end').addEventListener('click', end);
    $('btn-links').addEventListener('click', renderLinks);
    $('btn-back').addEventListener('click', function () { show('stage'); });
    // A reload of this page carries on with the same demo.
    try { var saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (saved && saved.code) { state = saved; openStage(); } else show('setup'); } catch (e) { show('setup'); }
})();
