// Linked demo: several "phones" on one computer (Jake, 31 Oct 2026).
// index.html#sim=N (N = 1 to 9) makes this copy of the app a separate demo phone: its storage (localStorage,
// sessionStorage and its database) is kept apart from every other copy on this computer, it is always in training
// mode, and its location is simulated near the demo incident (a laptop has no useful GPS, and all the phones would
// otherwise sit on the same spot). Without #sim this file does nothing.
// Loaded before every other script, so the app only ever sees the separated storage.
(function () {
    'use strict';
    var params = {};
    try {
        String(location.hash || '').replace(/^#/, '').split('&').forEach(function (kv) {
            var i = kv.indexOf('=');
            if (i > 0) params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
        });
    } catch (e) { params = {}; }
    // What a demo link asks for (also read by the app when #sim is not set: a demo phone on another device).
    window.MITT_DEMO_LINK = (params.code && params.pin) ? {
        code: String(params.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
        pin: String(params.pin).replace(/\D/g, '').slice(0, 6),
        role: /^p[0-3]$/.test(params.as || '') ? params.as : 'p0',
        play: params.play === '1',
        speed: Math.max(0.25, Math.min(4, Number(params.speed) || 1)),
    } : null;
    var sim = /^[1-9]$/.test(params.sim || '') ? Number(params.sim) : 0;
    window.MITT_SIM = sim;
    if (!sim) return;

    function separate(real, prefix) {
        var mine = function () { var out = []; for (var i = 0; i < real.length; i++) { var k = real.key(i); if (k && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length)); } return out; };
        var api = {
            getItem: function (k) { return real.getItem(prefix + k); },
            setItem: function (k, v) { real.setItem(prefix + k, String(v)); },
            removeItem: function (k) { real.removeItem(prefix + k); },
            clear: function () { mine().forEach(function (k) { real.removeItem(prefix + k); }); },
            key: function (i) { var m = mine(); return i >= 0 && i < m.length ? m[i] : null; },
        };
        // A Proxy, so Object.keys(localStorage) lists this phone's keys (the app clears its own keys that way).
        return new Proxy(api, {
            get: function (t, p) { if (p === 'length') return mine().length; if (p in t) return t[p]; return typeof p === 'string' ? real.getItem(prefix + p) : undefined; },
            set: function (t, p, v) { if (typeof p === 'string' && !(p in t)) real.setItem(prefix + p, String(v)); return true; },
            ownKeys: function () { return mine(); },
            getOwnPropertyDescriptor: function (t, p) { var v = typeof p === 'string' ? real.getItem(prefix + p) : null; return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
            has: function (t, p) { return p in t || (typeof p === 'string' && real.getItem(prefix + p) !== null); },
            deleteProperty: function (t, p) { if (typeof p === 'string') real.removeItem(prefix + p); return true; },
        });
    }
    try {
        var prefix = 'sim' + sim + ':';
        var ls = separate(window.localStorage, prefix);
        var ss = separate(window.sessionStorage, prefix);
        Object.defineProperty(window, 'localStorage', { value: ls, configurable: true });
        Object.defineProperty(window, 'sessionStorage', { value: ss, configurable: true });
        ls.setItem('mit_training', '1');   // a demo phone is always a practice phone
    } catch (e) {
        window.MITT_SIM = 0;   // cannot separate storage here: behave as a normal copy rather than mix data
        return;
    }

    // Simulated location: near the demo site, a little apart for each phone; the demo player moves it to each
    // casualty it triages (window.MITT_SIM_POS), so the commander's map shows them where the scenario puts them.
    var base = { lat: 52.45365 + (sim - 2) * 0.00012, lng: -1.90023 + (sim - 2) * 0.00018 };
    window.MITT_SIM_POS = { lat: base.lat, lng: base.lng, acc: 6 };
    function fix() {
        var p = window.MITT_SIM_POS || base;
        var j = function () { return (Math.random() - 0.5) * 0.00004; };
        return { coords: { latitude: p.lat + j(), longitude: p.lng + j(), accuracy: p.acc || 6, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() };
    }
    var watches = {}, nextId = 1;
    var fake = {
        getCurrentPosition: function (ok) { setTimeout(function () { try { ok(fix()); } catch (e) {} }, 200); },
        watchPosition: function (ok) { var id = nextId++; setTimeout(function () { try { ok(fix()); } catch (e) {} }, 200); watches[id] = setInterval(function () { try { ok(fix()); } catch (e) {} }, 5000); return id; },
        clearWatch: function (id) { clearInterval(watches[id]); delete watches[id]; },
    };
    try { Object.defineProperty(navigator, 'geolocation', { value: fake, configurable: true }); } catch (e) {}
})();
