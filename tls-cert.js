'use strict';
/* HTTPS for the local network, so that phones can install the app.
   On first start this makes a small certificate authority for this server (kept in DATA_DIR/tls) and a server
   certificate signed by it for the names and IP addresses of this computer. Each phone installs the authority
   certificate once (from /install); after that the browser trusts the server and offers "Install app".
   The server certificate is renewed automatically, with the same authority, when it nears its end or when
   this computer gets a new IP address. No dependency: Node.js only. */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- minimal DER encoding, enough for an X.509 certificate ----
function len(n) { if (n < 128) return Buffer.from([n]); const b = []; while (n > 0) { b.unshift(n & 255); n = Math.floor(n / 256); } return Buffer.from([0x80 | b.length].concat(b)); }
function tlv(tag, body) { return Buffer.concat([Buffer.from([tag]), len(body.length), body]); }
const seq = (...x) => tlv(0x30, Buffer.concat(x));
const set = (...x) => tlv(0x31, Buffer.concat(x));
function int(v) { let b = Buffer.isBuffer(v) ? v : Buffer.from([v]); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); }
function oid(s) {
  const p = s.split('.').map(Number), out = [40 * p[0] + p[1]];
  p.slice(2).forEach((v) => { const st = [v & 127]; v = Math.floor(v / 128); while (v > 0) { st.unshift((v & 127) | 128); v = Math.floor(v / 128); } out.push(...st); });
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bits = (b, unused) => tlv(0x03, Buffer.concat([Buffer.from([unused || 0]), b]));
const octet = (b) => tlv(0x04, b);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
function time(d) {
  const p = (n) => String(n).padStart(2, '0'), y = d.getUTCFullYear();
  const s = p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + s)) : tlv(0x18, Buffer.from(y + s));
}
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
function name(cn) { return seq(set(seq(oid('2.5.4.3'), utf8(cn))), set(seq(oid('2.5.4.10'), utf8('Cabinet Mapper')))); }
function ext(id, critical, value) { return seq(oid(id), critical ? bool(true) : Buffer.alloc(0), octet(value)); }
function keyId(pub) { return crypto.createHash('sha1').update(pub.export({ type: 'spki', format: 'der' })).digest(); }
function pem(der) { return '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n') + '-----END CERTIFICATE-----\n'; }

// one certificate: subject key, issuer key (the same for the authority), validity in days, extensions
function makeCert({ subject, issuer, pub, signKey, days, ca, names, issuerKeyId }) {
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const from = new Date(Date.now() - 60 * 60 * 1000), to = new Date(Date.now() + days * 864e5);
  const ski = keyId(pub), exts = [];
  if (ca) {
    exts.push(ext('2.5.29.19', true, seq(bool(true), int(0))));                       // a certificate authority, one level
    exts.push(ext('2.5.29.15', true, bits(Buffer.from([0x06]), 1)));                   // signs certificates and lists
  } else {
    exts.push(ext('2.5.29.19', true, seq()));                                         // not an authority
    exts.push(ext('2.5.29.15', true, bits(Buffer.from([0x80]), 7)));                  // digital signature
    exts.push(ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))));                // web server
    exts.push(ext('2.5.29.17', false, seq(...names.map((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n) ? tlv(0x87, Buffer.from(n.split('.').map(Number))) : tlv(0x82, Buffer.from(n, 'ascii'))))));
  }
  exts.push(ext('2.5.29.14', false, octet(ski)));
  exts.push(ext('2.5.29.35', false, seq(tlv(0x80, issuerKeyId || ski))));
  const tbs = seq(tlv(0xa0, int(2)), int(serial), ECDSA_SHA256, name(issuer), seq(time(from), time(to)), name(subject), pub.export({ type: 'spki', format: 'der' }), tlv(0xa3, seq(...exts)));
  const sig = crypto.sign('sha256', tbs, signKey);
  return pem(seq(tbs, ECDSA_SHA256, bits(sig)));
}

// the names this computer answers to on the network
function localNames(extra) {
  const out = ['localhost', '127.0.0.1'], host = os.hostname();
  if (host && /^[A-Za-z0-9.-]+$/.test(host)) { out.push(host); if (!host.includes('.')) out.push(host + '.local'); }
  Object.values(os.networkInterfaces()).forEach((L) => (L || []).forEach((a) => { if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address); }));
  String(extra || '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9.-]+$/.test(s)).forEach((s) => out.push(s));
  return Array.from(new Set(out));
}

// the authority and the server certificate, made or renewed as needed: { key, cert, ca, names }
function ensureCerts(dir, extra) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  let caKey, caCert;
  try { caKey = crypto.createPrivateKey(fs.readFileSync(f('ca.key'))); caCert = fs.readFileSync(f('ca.crt'), 'utf8'); } catch (e) { caKey = null; }
  if (!caKey) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    caKey = kp.privateKey;
    caCert = makeCert({ subject: 'Cabinet Mapper local authority (' + os.hostname() + ')', issuer: 'Cabinet Mapper local authority (' + os.hostname() + ')', pub: kp.publicKey, signKey: caKey, days: 3650, ca: true });
    fs.writeFileSync(f('ca.key'), caKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(f('ca.crt'), caCert);
    try { fs.unlinkSync(f('server.crt')); } catch (e) { /* none yet */ }
  }
  const caX = new crypto.X509Certificate(caCert), names = localNames(extra);
  let key = null, cert = null, renew = true;
  try {
    key = fs.readFileSync(f('server.key'), 'utf8'); cert = fs.readFileSync(f('server.crt'), 'utf8');
    const x = new crypto.X509Certificate(cert), left = Date.parse(x.validTo) - Date.now(), has = String(x.subjectAltName || '');
    renew = left < 60 * 864e5 || !x.verify(caX.publicKey) || names.some((n) => has.indexOf(/^\d/.test(n) ? 'IP Address:' + n : 'DNS:' + n) < 0);
  } catch (e) { renew = true; }
  if (renew) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const caCn = (/CN=([^\n]+)/.exec(caX.subject) || [])[1] || 'Cabinet Mapper local authority';
    cert = makeCert({ subject: names.find((n) => !/^(localhost|127\.)/.test(n)) || 'localhost', issuer: caCn, pub: kp.publicKey, signKey: caKey, days: 397, ca: false, names, issuerKeyId: keyId(caX.publicKey) });
    key = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(f('server.key'), key, { mode: 0o600 });
    fs.writeFileSync(f('server.crt'), cert);
  }
  return { key, cert, ca: caCert, names };
}

module.exports = { ensureCerts, localNames };
