/* Cabinet Mapper on a phone: keeps the app and the cabinets last opened, so they still open without network.
   Everything is fetched from the server first; the copy kept here is used only when the server cannot be reached.
   Live PLC readings, sign-in and Claude requests are never kept. */
var SHELL = 'cm-shell-v1', DATA = 'cm-data-v1';
var FILES = ['./', 'adapter.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== SHELL && k !== DATA; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// sign-out: forget the cabinets kept on this phone
self.addEventListener('message', function (e) { if (e.data === 'clear') e.waitUntil(caches.delete(DATA)); });
self.addEventListener('fetch', function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin) return;
  if (/^\/api\/(plc|ai|login|logout)/.test(u.pathname) || u.pathname === '/install' || u.pathname === '/ca.crt') return;
  var store = /^\/(api|_blob|photos)\//.test(u.pathname) ? DATA : SHELL;
  e.respondWith(fetch(r).then(function (res) {
    if (res.ok && res.type === 'basic') { var c = res.clone(); caches.open(store).then(function (x) { x.put(r, c); }); }
    return res;
  }).catch(function () {
    // a kept answer says so (X-CM-Kept), so the app can show that the server does not answer
    return caches.match(r).then(function (m) {
      if (!m) return r.mode === 'navigate' ? caches.match('./') : Response.error();
      if (r.mode === 'navigate') return m;
      var h = new Headers(m.headers); h.set('X-CM-Kept', '1');
      return m.blob().then(function (b) { return new Response(b, { status: m.status, statusText: m.statusText, headers: h }); });
    });
  }));
});
