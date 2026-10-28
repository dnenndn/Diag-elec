/*
 * Connects the Cabinet Mapper app to this server.
 *
 * The app talks to four services through window.claude.use(name):
 * "db" (documents), "assets" (images), "sample" (Claude) and "user" (role).
 * This file provides them on top of the server's /api routes, and shows the
 * sign-in form. The app code itself is unchanged.
 */
(function () {
  'use strict';
  var me = null, readyResolve, ready = new Promise(function (r) { readyResolve = r; });
  var subs = [];

  function fail(code, message, extra) { var e = { code: code, message: message || code }; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
  function request(method, url, body, opts) {
    opts = opts || {};
    var init = { method: method, credentials: 'same-origin', headers: {}, signal: opts.signal };
    if (opts.raw) { init.body = body; init.headers['Content-Type'] = opts.type; }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    return fetch(url, init).then(function (r) {
      kept = !!(r.headers && r.headers.get('X-CM-Kept'));      // answered by the copy kept in the browser, not by the server
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not JSON */ }
        if (r.ok) return j;
        var err = (j && j.error) || {};
        if (r.status === 401 && url !== '/api/login') { showLogin('Your session has ended. Sign in again.'); }
        throw fail(err.code || (r.status >= 500 ? 'unavailable' : 'invalid_argument'), err.message || ('HTTP ' + r.status), { status: r.status });
      });
    }, function (e) {
      if (e && e.name === 'AbortError') throw fail('cancelled', 'Stopped.');
      throw fail('unavailable', 'The server could not be reached.');
    });
  }

  // ---------- documents ----------
  function segs(p) { return String(p).split('/'); }
  function check(p, wantDoc) {
    var s = segs(p);
    if (!s.every(function (x) { return /^[A-Za-z0-9_-]{1,120}$/.test(x); }) || (s.length % 2 === 0) !== wantDoc) throw new TypeError('Bad ' + (wantDoc ? 'document' : 'collection') + ' path: ' + p);
  }
  function newId() { var a = new Uint8Array(10); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  var META = { fromCache: false, hasPendingWrites: false };
  function docSnap(id, data) { return { id: id, exists: data != null, data: function () { return data == null ? undefined : data; }, metadata: META }; }
  function querySnap(list) { var docs = list.map(function (d) { return docSnap(d.id, d.data); }); return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: META }; }
  function poke(colPath) { subs.forEach(function (s) { if (s.path === colPath) s.soon(); }); }
  // the link to the server, as the app sees it: each watched list is read again every 5 s; ok = the last read worked
  var link = { ok: true, at: 0, since: 0, err: '' };
  var kept = false;
  function linkSet(ok, e) {
    var was = link.ok; link.ok = ok;
    if (ok) link.at = Date.now(); else if (was) link.since = Date.now();
    link.err = ok ? '' : ((e && e.message) || 'no answer');
    if (was !== ok) { try { window.dispatchEvent(new Event('cm-link')); } catch (x) { /* old browser */ } }
  }
  function watch(path, load, next, error) {
    var last = null, stopped = false, timer = null, busy = false;
    var s = {
      path: path,
      soon: function () { clearTimeout(timer); timer = setTimeout(tick, 150); }
    };
    function tick() {
      if (stopped || busy) return;
      busy = true;
      load().then(function (r) {
        busy = false; if (kept) linkSet(false, { message: 'no answer' }); else linkSet(true); if (stopped) return;
        if (r.key !== last) { last = r.key; try { next(r.snap); } catch (e) { console.error(e); } }
        plan();
      }, function (e) {
        busy = false; linkSet(false, e); if (stopped) return;
        if (last === null && e && e.code !== 'unavailable' && error) { stopped = true; error(e); return; }
        plan();
      });
    }
    function plan() { clearTimeout(timer); timer = setTimeout(tick, document.hidden ? 30000 : 5000); }
    subs.push(s); tick();
    return function () { stopped = true; clearTimeout(timer); var i = subs.indexOf(s); if (i >= 0) subs.splice(i, 1); };
  }
  function col(path) {
    check(path, false);
    function load() { return request('GET', '/api/col?path=' + encodeURIComponent(path)).then(function (r) { return { key: JSON.stringify(r.docs), snap: querySnap(r.docs) }; }); }
    return {
      path: path,
      get: function () { return load().then(function (r) { return r.snap; }); },
      onSnapshot: function (next, error) { return watch(path, load, next, error); },
      doc: function (id) { return doc(path + '/' + (id || newId())); },
      add: function (data) { var d = doc(path + '/' + newId()); return d.set(data).then(function () { return d; }); }
    };
  }
  function doc(path) {
    check(path, true);
    var s = segs(path), id = s[s.length - 1], parent = s.slice(0, -1).join('/'), url = '/api/doc?path=' + encodeURIComponent(path);
    function load() { return request('GET', url).then(function (r) { var d = r && r.exists ? r.data : null; return { key: JSON.stringify(d), snap: docSnap(id, d) }; }); }
    var ref = {
      id: id, path: path,
      get: function () { return load().then(function (r) { return r.snap; }); },
      set: function (data) { return request('PUT', url, data).then(function () { poke(parent); }); },
      update: function (data) {
        return request('GET', url).then(function (r) {
          if (!r || !r.exists) throw fail('invalid_argument', 'The document does not exist.');
          var merge = function (a, b) { Object.keys(b).forEach(function (k) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], b[k]); else a[k] = b[k]; }); return a; };
          return ref.set(merge(r.data, data));
        });
      },
      delete: function () { return request('DELETE', url).then(function () { poke(parent); }); },
      onSnapshot: function (next, error) { return watch(path, load, next, error); },
      collection: function (p) { return col(path + '/' + p); }
    };
    return ref;
  }

  // ---------- Claude, through the server ----------
  function toBase64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { rej(fail('image_rejected', 'An image could not be read.')); };
      fr.readAsDataURL(blob);
    });
  }
  function runAI(input, opts, json) {
    opts = opts || {};
    var signal = opts.signal;
    if (signal && signal.aborted) return Promise.reject(fail('cancelled', 'Stopped.'));
    var imgs = !opts.images ? [] : (opts.images instanceof Blob ? [opts.images] : Array.prototype.slice.call(opts.images));
    return Promise.all(imgs.map(function (b) { return toBase64(b).then(function (d) { return { type: b.type || 'image/jpeg', data: d }; }); })).then(function (images) {
      if (signal && signal.aborted) throw fail('cancelled', 'Stopped.');
      return request('POST', '/api/ai', { input: input, images: images, tier: opts.modelTier || 'default', json: !!json });
    }).then(function (job) {
      return new Promise(function (resolve, reject) {
        var done = false, timer = null;
        function stop() { if (done) return; done = true; clearTimeout(timer); request('DELETE', '/api/ai/' + job.id).catch(function () {}); reject(fail('cancelled', 'Stopped.')); }
        if (signal) signal.addEventListener('abort', stop, { once: true });
        function poll() {
          request('GET', '/api/ai/' + job.id).then(function (r) {
            if (done) return;
            if (r.status === 'running') { timer = setTimeout(poll, 1500); return; }
            done = true; if (signal) signal.removeEventListener('abort', stop);
            if (r.status === 'done') resolve(r); else reject(fail(r.code || 'upstream_error', r.message));
          }, function (e) {
            if (done) return;
            if (e.code === 'unavailable') { timer = setTimeout(poll, 3000); return; }
            done = true; reject(e);
          });
        }
        timer = setTimeout(poll, 800);
      });
    }).then(function (r) {
      var out = { text: r.text, truncated: !!r.truncated, modelTierApplied: r.tier || 'default' };
      if (typeof opts.onText === 'function') { try { opts.onText({ text: out.text, delta: out.text }); } catch (e) { console.error(e); } }
      return out;
    });
  }
  function parseLoose(text) {
    var t = String(text).trim(), m;
    try { return { ok: true, value: JSON.parse(t) }; } catch (e) { /* try the next form */ }
    m = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
    if (m) { try { return { ok: true, value: JSON.parse(m[1]) }; } catch (e) { /* try the next form */ } }
    var a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) { try { return { ok: true, value: JSON.parse(t.slice(a, b + 1)) }; } catch (e) { /* give up */ } }
    return { ok: false };
  }
  var sample = function (input, opts) { return runAI(input, opts, false); };
  sample.json = function (input, opts) {
    return runAI(input, opts, true).then(function (r) {
      var p = parseLoose(r.text);
      if (r.truncated || !p.ok) throw fail('invalid_json', r.truncated ? 'The answer was cut short.' : 'The answer held no JSON.', { text: r.text });
      return p.value;
    });
  };
  sample.limits = function () {
    return Promise.resolve({ maxPromptBytes: 262144, images: me && me.role === 'editor' ? { maxCount: 8, maxInputBytes: 9 * 1024 * 1024, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } : undefined });
  };

  // ---------- images ----------
  var assets = {
    upload: function (blob, o) {
      var type = (o && o.type) || blob.type;
      return request('POST', '/api/assets', blob, { raw: true, type: type }).catch(function (e) { throw fail(e.status === 413 ? 'too_large' : e.status === 415 ? 'unsupported_type' : e.code, e.message); });
    },
    list: function () { return request('GET', '/api/assets'); },
    delete: function (ref) { var id = String(ref).replace(/^.*\//, ''); return request('DELETE', '/api/assets/' + encodeURIComponent(id)); }
  };
  var user = {
    can: function (name) { return Promise.resolve(name === 'data.write' ? me.role === 'editor' : null); },
    canEdit: function () { return Promise.resolve(me.role === 'editor'); },
    isOwner: function () { return Promise.resolve(me.role === 'editor'); },
    id: function () { return Promise.resolve(null); }
  };

  // ---------- sign-in ----------
  function showLogin(note) {
    if (document.getElementById('cm-login')) return;
    var wrap = document.createElement('div');
    wrap.id = 'cm-login';
    wrap.setAttribute('style', 'position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg,#E3E6E2);color:var(--ink,#15232A);font-family:var(--f-body,system-ui,sans-serif)');
    wrap.innerHTML = '<form style="width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px">' +
      '<h1 style="margin:0;font-family:var(--f-display,system-ui,sans-serif);font-size:30px;line-height:1.05">Cabinet Mapper</h1>' +
      '<p id="cm-login-note" style="margin:0;color:var(--ink-2,#4D5D64)"></p>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:500;color:var(--ink-2,#4D5D64)">Access code' +
      '<input id="cm-code" type="password" autocomplete="current-password" style="font-size:16px;padding:10px;border:1px solid var(--line,#C6CDC9);border-radius:8px;background:var(--surface,#F4F6F3);color:inherit;min-height:44px"></label>' +
      '<button type="submit" style="min-height:44px;border:0;border-radius:8px;background:var(--accent,#0B5C6E);color:var(--accent-ink,#fff);font:inherit;font-weight:600;cursor:pointer">Sign in</button>' +
      '<p id="cm-login-err" role="alert" style="margin:0;color:var(--danger,#B3261E);font-size:14px;min-height:1.4em"></p></form>';
    document.body.appendChild(wrap);
    wrap.querySelector('#cm-login-note').textContent = note || 'Enter the editor code to build cabinets, or the viewer code to open the field view.';
    var input = wrap.querySelector('#cm-code'), err = wrap.querySelector('#cm-login-err'), btn = wrap.querySelector('button');
    input.focus();
    input.addEventListener('input', function () { err.textContent = ''; });
    wrap.querySelector('form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var code = input.value.trim();
      if (!code) { err.textContent = 'Enter the access code.'; return; }
      btn.disabled = true;
      request('POST', '/api/login', { code: code }).then(function (m) {
        if (me) { location.reload(); return; }   // a session that ended mid-use: start clean
        me = m; publish(); wrap.remove(); readyResolve(m);
      }, function (e) {
        btn.disabled = false;
        err.textContent = e.code === 'bad_code' ? 'That access code is not right.' : e.code === 'rate_limited' ? 'Too many attempts. Wait ten minutes.' : 'The server could not be reached. Try again.';
      });
    });
  }
  function publish() {
    // signing out of the app on a phone also forgets the cabinets kept there for use without network
    function forgetKept() { try { if (window.caches) caches.delete('cm-data-v1'); if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('clear'); } catch (e) { /* nothing kept */ } }
    window.cmHost = { role: me.role, ai: !!me.ai, plc: !!me.plc, reset: !!me.reset, machines: true,
      link: function () { return link; },
      // the PLC of a machine: each call names the machine
      plcRead: function (ids, machine) { return request('POST', '/api/plc', { ids: ids, machine: machine }); },
      plcReset: function (code, drive, machine) { return request('POST', '/api/plc/reset', { code: code, drive: drive || '', machine: machine }); },
      plcStatus: function (machine) { return request('GET', '/api/plc/status?machine=' + encodeURIComponent(machine)); },
      plcTest: function (machine) { return request('POST', '/api/plc/test', { machine: machine }); },
      setResetCode: function (machine, code) { return request('POST', '/api/plc/resetcode', { machine: machine, code: code }); }, logout: function () { forgetKept(); return request('POST', '/api/logout').then(function () { location.reload(); }, function () { location.reload(); }); } };
  }
  function start() {
    request('GET', '/api/me').then(function (m) {
      if (m && m.role) { me = m; publish(); readyResolve(m); } else showLogin();
    }, function () { showLogin('The server could not be reached. Check the connection and try again.'); });
  }

  window.cmHost = { role: null, ai: false, logout: function () {} };
  window.claude = {
    use: function (name) {
      return ready.then(function () {
        if (name === 'db') return { doc: doc, collection: col };
        if (name === 'user') return user;
        if (name === 'sample') return me.ai ? sample : null;
        if (name === 'assets') return me.role === 'editor' ? assets : null;
        return null;
      });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
