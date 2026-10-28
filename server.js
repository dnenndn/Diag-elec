'use strict';
/*
 * Cabinet Mapper server
 *
 * One Node.js process, no npm dependencies. It provides:
 *   - the web app (Studio and Field view) from ./public
 *   - a document store on disk            (/api/doc, /api/col)
 *   - image storage on disk               (/api/assets, /_blob/<id>)
 *   - sign-in with an editor and a viewer access code
 *   - a proxy to the Claude API, so the API key never reaches the browser
 *
 * Configuration is by environment variables; see .env.example.
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
const plc = require('./plc');
const tlsCert = require('./tls-cert');
const { Logger, occurrences } = require('./logger');
const { Monitor } = require('./monitor');

// ---------- configuration ----------
loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 8080;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');
const DOCS = path.join(DATA, 'docs');
const ASSETS = path.join(DATA, 'assets');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const API_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const MODELS = {
  quick: process.env.AI_MODEL_QUICK || 'claude-haiku-4-5-20251001',
  default: process.env.AI_MODEL || 'claude-sonnet-5-5',
  complex: process.env.AI_MODEL_COMPLEX || 'claude-opus-5-5',
};
// Live reading of a Siemens S7 PLC for the Diagnose tab. Read-only: see plc.js.
const PLC_HOST = (process.env.PLC_HOST || '').trim();
const PLC_PORT = Number(process.env.PLC_PORT) || 102;
const PLC_RACK = Number(process.env.PLC_RACK) || 0;
const PLC_SLOT = process.env.PLC_SLOT === undefined || process.env.PLC_SLOT === '' ? 2 : Number(process.env.PLC_SLOT);
const AI_MAX_PER_HOUR = Number(process.env.AI_MAX_PER_HOUR) || 200;
const AI_MAX_RUNNING = 4;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// The machine log (Logs in the Studio): how many days are kept
// Reset from the app: ALLOW_RESET=1 lets this server write the one reset request bit of a machine (a memory or data-block bit
// that the PLC program takes as a reset request). Each machine gets its bit and its reset code in the Studio. See README, "Reset from the phone".
// RESET_BIT and RESET_CODE are the settings of the version before machines: they go to the first machine once, and still allow reset.
const RESET_BIT = (process.env.RESET_BIT || '').trim().toUpperCase().replace(/\s+/g, '');
const RESET_CODE = (process.env.RESET_CODE || '').trim();
const ALLOW_RESET = process.env.ALLOW_RESET === '1' || !!(RESET_BIT && RESET_CODE);
// a reset is only taken from the plant network, never through the internet (a tunnel or a proxy), unless RESET_FROM_INTERNET=1
const RESET_FROM_INTERNET = process.env.RESET_FROM_INTERNET === '1';
const LOG_DAYS = Math.max(1, Math.min(30, Number(process.env.LOG_DAYS) || 4));
// HTTPS on the local network, so that phones can install the app (see /install). Off unless HTTPS_PORT is set.
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 0;
const TLS_NAMES = process.env.TLS_NAMES || '';
let TLS = null;
// Outgoing requests to the Claude API. Set HTTPS_PROXY when the server reaches the internet through a proxy.
const OUT_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const CONNECT_TIMEOUT = 30000;
// Slow or half-working IPv6 makes connections time out on some networks: prefer IPv4 and give each attempt time.
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) { /* older Node */ }
try { if (net.setDefaultAutoSelectFamilyAttemptTimeout) net.setDefaultAutoSelectFamilyAttemptTimeout(5000); } catch (e) { /* older Node */ }

const MAX_DOC = 1.5 * 1024 * 1024;
const MAX_ASSET = 25 * 1024 * 1024;
const MAX_AI = 40 * 1024 * 1024;
const SESSION_DAYS = 30;
const IMAGE_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(DOCS, { recursive: true });
removeExamples();
// Earlier versions started with three example cabinets (Cabinet 1, 2 and 3). They are no longer part of the
// program: an installation that still has them loses them once, at the first start of this version.
function removeExamples() {
  const mark = path.join(DATA, 'examples-removed');
  if (fs.existsSync(mark)) return;
  let n = 0;
  for (const id of ['cabinet-1', 'cabinet-2', 'cabinet-3']) {
    const files = [path.join(PUBLIC, 'photos', id + '.jpg')];
    for (const col of ['cabinets', 'published']) files.push(path.join(DOCS, col, id + '.json'), path.join(DOCS, col, id));
    for (const f of files) {
      try { if (fs.existsSync(f)) { fs.rmSync(f, { recursive: true, force: true }); if (f.startsWith(DOCS)) n++; } } catch (e) { /* keep going */ }
    }
  }
  try { fs.writeFileSync(mark, new Date().toISOString() + '\n'); } catch (e) { /* tried again at the next start */ }
  if (n) console.log('The example cabinets (Cabinet 1, 2 and 3) were removed.');
}
const SECRET = process.env.SESSION_SECRET || persisted('session-secret', () => crypto.randomBytes(32).toString('hex'));
const EDITOR_CODE = process.env.EDITOR_CODE || persisted('editor-code.txt', () => crypto.randomBytes(9).toString('base64url'));
const VIEWER_CODE = process.env.VIEWER_CODE || '';

function persisted(name, make) {
  const f = path.join(DATA, name);
  try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch (e) { /* first start */ }
  const v = make();
  fs.writeFileSync(f, v + '\n', { mode: 0o600 });
  return v;
}
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// ---------- small helpers ----------
class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
function send(res, status, body, headers) {
  const h = Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  }, headers || {});
  if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string') {
    body = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
  }
  // text and JSON are sent compressed when the browser accepts it (the cabinets with their PLC program are large, and the phones read them often)
  const ae = String((res.req && res.req.headers['accept-encoding']) || '');
  if (body && body.length > 2048 && /\bgzip\b/.test(ae) && /^(application\/json|text\/|application\/manifest)/.test(String(h['Content-Type'] || ''))) {
    body = zlib.gzipSync(body, { level: 5 });
    h['Content-Encoding'] = 'gzip';
    h['Vary'] = 'Accept-Encoding';
  }
  res.writeHead(status, h);
  res.end(body === undefined || body === null ? '' : body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(new HttpError(413, 'too_large', 'The request is too large.')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || 'null'); }
  catch (e) { throw new HttpError(400, 'invalid_argument', 'The request body is not valid JSON.'); }
}
// A tunnel (Cloudflare's cloudflared) runs on this PC and passes on the requests of the internet: they come from this PC itself
// and carry Cf-Connecting-IP. Those headers are only believed from this PC, or from anywhere with TRUST_PROXY=1.
function isLoopback(a) { a = String(a || ''); return a === '::1' || /^(::ffff:)?127\./.test(a); }
function viaTunnel(req) { return isLoopback(req.socket.remoteAddress) && !!req.headers['cf-connecting-ip']; }
function proxied(req) { return TRUST_PROXY || viaTunnel(req); }
function clientIp(req) {
  if (viaTunnel(req)) return String(req.headers['cf-connecting-ip']).trim();
  if (TRUST_PROXY) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || '';
}
function isHttps(req) {
  return !!req.socket.encrypted || (proxied(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}
// a request from the plant network (or this PC), not from the internet through a tunnel or a proxy
function fromLan(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['forwarded']) return false;
  const a = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return isLoopback(a) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(a) || /^f[cd]|^fe80/i.test(a);
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---------- sessions ----------
function sign(value) { return crypto.createHmac('sha256', SECRET).update(value).digest('base64url'); }
function makeSession(role) {
  const payload = role + '.' + (Date.now() + SESSION_DAYS * 864e5);
  return payload + '.' + sign(payload);
}
function sessionRole(req) {
  const m = /(?:^|;\s*)cm_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 3) return null;
  const payload = parts[0] + '.' + parts[1];
  if (!safeEqual(sign(payload), parts[2])) return null;
  if (!(Number(parts[1]) > Date.now())) return null;
  return parts[0] === 'editor' || parts[0] === 'viewer' ? parts[0] : null;
}
function sessionCookie(req, value, maxAge) {
  return 'cm_session=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (isHttps(req) ? '; Secure' : '');
}
const loginTries = new Map();
function loginAllowed(ip) {
  const now = Date.now(); const e = loginTries.get(ip);
  if (!e || now - e.t > 10 * 60 * 1000) { loginTries.set(ip, { n: 1, t: now }); return true; }
  e.n += 1;
  return e.n <= 10;
}

// ---------- document store ----------
const SEG = /^[A-Za-z0-9_-]{1,120}$/;
function parsePath(p, wantDoc) {
  const segs = String(p || '').split('/');
  if (!segs.length || segs.length > 8 || !segs.every((s) => SEG.test(s))) throw new HttpError(400, 'invalid_argument', 'Bad path.');
  if ((segs.length % 2 === 0) !== wantDoc) throw new HttpError(400, 'invalid_argument', wantDoc ? 'A document path needs an even number of segments.' : 'A collection path needs an odd number of segments.');
  return segs;
}
// Viewers see validated cabinets and the images they reference, never the drafts.
// viewers (the phone app, signed in with the viewer code) read everything the studio saves; they change nothing
function viewerMayRead(segs) {
  return segs[0] === 'moncfg' || segs[0] === 'machines' || segs[0] === 'cabinets' || segs[0] === 'photos' || segs[0] === 'published' || segs[0] === 'logcfg';
}
async function readDoc(segs) {
  try { return JSON.parse(await fsp.readFile(path.join(DOCS, ...segs) + '.json', 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeDoc(segs, data) {
  const file = path.join(DOCS, ...segs) + '.json';
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}
async function deleteDoc(segs) {
  try { await fsp.unlink(path.join(DOCS, ...segs) + '.json'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
async function listCol(segs) {
  let names;
  try { names = await fsp.readdir(path.join(DOCS, ...segs), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const ids = names.filter((d) => d.isFile() && d.name.endsWith('.json')).map((d) => d.name.slice(0, -5)).filter((id) => SEG.test(id)).sort();
  const docs = await Promise.all(ids.map(async (id) => ({ id, data: await readDoc(segs.concat(id)) })));
  return docs.filter((d) => d.data && typeof d.data === 'object');
}

// ---------- Claude API ----------
const jobs = new Map();
let aiStamps = [];
function bypassProxy(host) {
  host = host.toLowerCase();
  return NO_PROXY.some((n) => n === '*' || host === n || host.endsWith('.' + n.replace(/^\./, '')));
}
// POST a JSON body to the Claude API and resolve { status, text }. Uses Node's http/https modules so that
// the connection timeout, IPv4 preference and an optional HTTP proxy (CONNECT tunnel) are under our control.
function apiPost(payload, signal, totalMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(API_BASE + '/v1/messages');
    const secure = target.protocol === 'https:';
    const data = Buffer.from(JSON.stringify(payload));
    const headers = { 'content-type': 'application/json', 'content-length': data.length, 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' };
    let finished = false; let req = null; let proxyReq = null; const timers = [];
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const done = (err, val) => {
      if (finished) return; finished = true;
      timers.forEach(clearTimeout);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) { if (req) req.destroy(); if (proxyReq) proxyReq.destroy(); reject(err); } else resolve(val);
    };
    function onAbort() { done(fail('ABORTED', 'stopped')); }
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    timers.push(setTimeout(() => done(fail('NO_ANSWER', 'no answer within ' + Math.round(totalMs / 1000) + ' seconds')), totalMs));
    const send = (extra) => {
      req = (secure ? https : http).request(Object.assign({ method: 'POST', host: target.hostname, port: target.port || (secure ? 443 : 80), path: target.pathname, headers, servername: target.hostname }, extra));
      const ct = setTimeout(() => done(fail('CONNECT_TIMEOUT', 'no connection within ' + CONNECT_TIMEOUT / 1000 + ' seconds')), CONNECT_TIMEOUT);
      timers.push(ct);
      req.on('socket', (sock) => { sock.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(ct)); if (!sock.connecting && !secure) clearTimeout(ct); });
      req.on('response', (res) => {
        clearTimeout(ct);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done(null, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => done(e));
      });
      req.on('error', (e) => done(e));
      req.end(data);
    };
    if (!OUT_PROXY || !secure || bypassProxy(target.hostname)) { send({}); return; }
    let pu;
    try { pu = new URL(OUT_PROXY); } catch (e) { done(fail('BAD_PROXY', 'HTTPS_PROXY is not a valid address')); return; }
    if (pu.protocol !== 'http:') { done(fail('BAD_PROXY', 'HTTPS_PROXY must start with http://')); return; }
    const ph = { Host: target.hostname + ':' + (target.port || 443) };
    if (pu.username) ph['Proxy-Authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(pu.username) + ':' + decodeURIComponent(pu.password)).toString('base64');
    proxyReq = http.request({ host: pu.hostname, port: pu.port || 80, method: 'CONNECT', path: target.hostname + ':' + (target.port || 443), headers: ph });
    const pt = setTimeout(() => done(fail('PROXY_TIMEOUT', 'the proxy did not answer within ' + CONNECT_TIMEOUT / 1000 + ' seconds')), CONNECT_TIMEOUT);
    timers.push(pt);
    proxyReq.on('connect', (res, socket) => {
      clearTimeout(pt);
      if (res.statusCode !== 200) { socket.destroy(); done(fail('PROXY_' + res.statusCode, 'the proxy answered ' + res.statusCode + (res.statusCode === 407 ? ', it needs a user name and password' : ''))); return; }
      send({ agent: false, createConnection: () => tls.connect({ socket, servername: target.hostname }) });
    });
    proxyReq.on('error', (e) => done(e));
    proxyReq.end();
  });
}
function aiError(status, text) {
  let msg = '';
  try { const j = JSON.parse(text); msg = (j && j.error && j.error.message) || ''; } catch (e) { msg = String(text).slice(0, 200); }
  if (status === 401 || status === 403) return { code: 'sampling_disabled', message: 'The Claude API key was refused. ' + msg };
  if (status === 429) return { code: 'rate_limited', message: 'The Claude API rate limit was reached. ' + msg };
  if (status === 413) return { code: 'image_rejected', message: 'The request was too large for the Claude API. ' + msg };
  if (status === 400) return { code: /image/i.test(msg) ? 'image_rejected' : 'invalid_request', message: msg };
  return { code: 'upstream_error', message: 'The Claude API answered ' + status + '. ' + msg };
}
async function runJob(job, body) {
  try {
    const content = [];
    for (const im of body.images) content.push({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } });
    let messages;
    const jsonNote = body.json ? '\n\nYour reply is parsed by a program. Reply with only the JSON value, no other text.' : '';
    if (typeof body.input === 'string') {
      content.push({ type: 'text', text: body.input + jsonNote });
      messages = [{ role: 'user', content }];
    } else {
      messages = body.input.map((t) => ({ role: t.role, content: [{ type: 'text', text: t.content }] }));
      const last = messages[messages.length - 1];
      last.content = content.concat([{ type: 'text', text: last.content[0].text + jsonNote }]);
    }
    const tier = MODELS[body.tier] ? body.tier : 'default';
    const r = await apiPost({ model: MODELS[tier], max_tokens: body.json ? 16000 : 2000, messages }, job.ctrl.signal, 9 * 60 * 1000);
    const text = r.text;
    if (r.status < 200 || r.status >= 300) { Object.assign(job, { status: 'error' }, aiError(r.status, text)); return; }
    const out = JSON.parse(text);
    if (out.stop_reason === 'refusal') { Object.assign(job, { status: 'error', code: 'refused', message: 'Claude declined this request.' }); return; }
    const answer = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!answer.trim()) { Object.assign(job, { status: 'error', code: 'empty_completion', message: 'Claude returned no text.' }); return; }
    Object.assign(job, { status: 'done', text: answer, truncated: out.stop_reason === 'max_tokens', tier });
  } catch (e) {
    if (job.ctrl.signal.aborted) Object.assign(job, { status: 'error', code: 'cancelled', message: 'Stopped.' });
    else Object.assign(job, { status: 'error', code: 'upstream_error', message: 'The server could not reach the Claude API at ' + API_BASE + ' (' + netCause(e) + '). ' + (OUT_PROXY ? 'Check the HTTPS_PROXY setting.' : 'If this server reaches the internet through a proxy, set HTTPS_PROXY in .env.') });
  } finally {
    job.t = Date.now();
    job.ctrl = null;
    if (job.status === 'error' && job.code !== 'cancelled') console.error(new Date().toISOString(), 'Claude request failed:', job.code, '-', job.message);
  }
}
function netCause(e) {
  if (!e) return 'unknown error';
  const c = e.cause;
  const code = e.code || (c && c.code) || '';
  const msg = e.message || (c && c.message) || '';
  return code && msg && msg.indexOf(code) < 0 ? code + ': ' + msg : (code || msg || 'unknown error');
}
// "node server.js --test-claude" sends one tiny request per model and prints what the Claude API answers.
// ---------- machines ----------
// A machine holds its cabinets (the cabinet documents say which machine they are in), its PLC (address set in the Studio),
// its drives (worked out by the app from the program of its cabinets) and its log (<data>/log/<machine>/).
// PLC_HOST and the other PLC settings of .env are used once, to fill in the first machine when the server is updated.
const machines = new Map();      // id -> { id, name, order, plc: {host, port, rack, slot}, resetBit }
const plcConns = new Map();      // "host:port:rack:slot" -> { reader, busy, last }; two machines on the same PLC share one connection
const loggers = new Map();       // id -> Logger
const monitors = new Map();      // id -> Monitor (production and maintenance)
const LOG_ROOT = path.join(DATA, 'log');
const SECRETS_FILE = path.join(DATA, 'machine-secrets.json');     // the reset codes, hashed. Not in the document store: no one can read them back
let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) || {}; } catch (e) { secrets = {}; }
function saveSecrets() { const tmp = SECRETS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 }); fs.renameSync(tmp, SECRETS_FILE); }
function codeHash(code, salt) { return crypto.scryptSync(String(code), salt, 32).toString('hex'); }
function setResetCode(id, code) {
  if (!code) delete secrets[id];
  else { const salt = crypto.randomBytes(16).toString('hex'); secrets[id] = { salt, hash: codeHash(code, salt), at: new Date().toISOString() }; }
  saveSecrets();
}
function resetCodeOk(id, code) { const e = secrets[id]; return !!(e && code && safeEqual(codeHash(code, e.salt), e.hash)); }
function bitName(v) { return String(v || '').trim().toUpperCase().replace(/\s+/g, ''); }
function cleanMachine(id, d) {
  d = d && typeof d === 'object' ? d : {};
  const p = d.plc && typeof d.plc === 'object' ? d.plc : {}, host = String(p.host || '').trim().slice(0, 100);
  const n = (v, lo, hi, def) => { v = Math.floor(Number(v)); return isFinite(v) && v >= lo && v <= hi ? v : def; };
  const rb = bitName(d.resetBit);
  return { id, name: String(d.name || 'Machine').slice(0, 80), order: Number(d.order) || 0,
    plc: { host: /^[A-Za-z0-9.\-]*$/.test(host) ? host : '', port: n(p.port, 1, 65535, 102), rack: n(p.rack, 0, 7, 0), slot: n(p.slot, 0, 31, 2) },
    resetBit: plc.requestBit(rb) ? rb : '' };
}
function plcKey(M) { return M && M.plc.host ? [M.plc.host, M.plc.port, M.plc.rack, M.plc.slot].join(':') : ''; }
function plcConn(id) {
  const M = machines.get(id), key = plcKey(M); if (!key) return null;
  let c = plcConns.get(key);
  if (!c) { c = { reader: new plc.S7Reader({ host: M.plc.host, port: M.plc.port, rack: M.plc.rack, slot: M.plc.slot }), busy: null, last: { key: '', at: 0, out: null } }; plcConns.set(key, c); }
  return c;
}
function machineReader(id) { const c = plcConn(id); return c ? c.reader : null; }
function needMachine(id) {
  const M = machines.get(String(id || ''));
  if (!M) throw new HttpError(404, 'no_machine', 'This machine does not exist (any more). Go back to the list of machines.');
  return M;
}
// the machine documents changed: follow them (a new machine starts its log, a deleted one stops, a new PLC address gets a new connection)
let refreshing = Promise.resolve();
function refreshMachines() {
  refreshing = refreshing.then(async () => {
    const docs = await listCol(['machines']), seen = new Set();
    machines.clear();
    docs.forEach((d) => { machines.set(d.id, cleanMachine(d.id, d.data)); seen.add(d.id); });
    const keys = new Set(Array.from(machines.values()).map(plcKey));
    for (const [k, c] of plcConns) if (!keys.has(k)) { c.reader.close(); plcConns.delete(k); }
    for (const [id, L] of loggers) if (!seen.has(id)) { L.stop(); loggers.delete(id); }
    for (const [id, W] of monitors) if (!seen.has(id)) { W.stop(); monitors.delete(id); }
    for (const id of seen) if (!monitors.has(id)) {
      const W = new Monitor({ dir: path.join(DATA, 'monitor', id), cfgFile: path.join(DOCS, 'moncfg', id + '.json'), getReader: () => machineReader(id) });
      monitors.set(id, W); await W.start().catch((e) => console.log('Production and maintenance of machine ' + id + ' could not start: ' + e.message));
    }
    for (const id of seen) if (!loggers.has(id)) {
      const L = new Logger({ dir: path.join(LOG_ROOT, id), cfgFile: path.join(DOCS, 'logcfg', id + '.json'), days: LOG_DAYS, getReader: () => machineReader(id) });
      loggers.set(id, L); await L.start().catch((e) => console.log('The log of machine ' + id + ' could not start: ' + e.message));
    }
  }).catch((e) => console.error('Machines could not be read:', e.message));
  return refreshing;
}
function anyPlc() { for (const M of machines.values()) if (M.plc.host) return true; return false; }
function needLogger(url) { needMachine(url.searchParams.get('machine')); return loggers.get(url.searchParams.get('machine')); }
function newMachineId() { return 'm' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
async function copyDir(a, b) {
  await fsp.mkdir(b, { recursive: true });
  for (const e of await fsp.readdir(a, { withFileTypes: true })) {
    if (e.isDirectory()) await copyDir(path.join(a, e.name), path.join(b, e.name));
    else if (e.isFile()) await fsp.copyFile(path.join(a, e.name), path.join(b, e.name));
  }
}
// once, when the server is updated to machines: the cabinets of each group become a machine; the PLC of .env, the reset settings
// and the log go to the first one. A copy of the documents is kept in <data>/backup-before-machines first.
async function migrateMachines() {
  const mark = path.join(DATA, 'machines-ready');
  if (fs.existsSync(mark)) return;
  if (!(await listCol(['machines'])).length) {
    const cabs = (await listCol(['cabinets'])).sort((a, b) => (Number(a.data.order) || 0) - (Number(b.data.order) || 0));
    if (cabs.length) { const bk = path.join(DATA, 'backup-before-machines'); if (!fs.existsSync(bk)) await copyDir(DOCS, path.join(bk, 'docs')); }
    const made = [], byGroup = new Map();
    const make = (name) => { const m = { id: newMachineId() + made.length, name: name.slice(0, 80) }; made.push(m); return m; };
    cabs.forEach((c) => { const g = String(c.data.group || '').trim(); if (g && !byGroup.has(g)) byGroup.set(g, make(g)); });
    const loose = cabs.filter((c) => !String(c.data.group || '').trim());
    const home = byGroup.size === 1 ? Array.from(byGroup.values())[0] : (loose.length || !made.length ? make('Machine ' + (made.length + 1)) : null);
    const first = made[0];
    for (let i = 0; i < made.length; i++) {
      const m = made[i], d = { name: m.name, order: i, updated: new Date().toISOString() };
      if (m === first) {
        d.plc = { host: PLC_HOST, port: PLC_PORT, rack: PLC_RACK, slot: PLC_SLOT };
        if (plc.requestBit(RESET_BIT)) d.resetBit = RESET_BIT;
      }
      await writeDoc(['machines', m.id], d);
    }
    for (const c of cabs) {
      const g = String(c.data.group || '').trim(), m = g ? byGroup.get(g) : home;
      for (const col of ['cabinets', 'published']) {
        const d = col === 'cabinets' ? c.data : await readDoc([col, c.id]);
        if (d) { d.machine = m.id; await writeDoc([col, c.id], d); }
      }
    }
    if (RESET_CODE.length >= 4) setResetCode(first.id, RESET_CODE);
    // the log so far belongs to the first machine
    try {
      const dst = path.join(LOG_ROOT, first.id); await fsp.mkdir(dst, { recursive: true });
      for (const f of await fsp.readdir(LOG_ROOT)) if (/\.jsonl$/.test(f)) await fsp.rename(path.join(LOG_ROOT, f), path.join(dst, f));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const cfg = await readDoc(['logcfg', 'main']);
    if (cfg) { await writeDoc(['logcfg', first.id], cfg); await deleteDoc(['logcfg', 'main']); }
    console.log(cabs.length ? 'Machines: ' + made.map((m) => '"' + m.name + '"').join(', ') + ' made from the cabinets (a copy of the documents from before is in ' + path.join(DATA, 'backup-before-machines') + ').' : 'First start: "Machine 1" made. Rename it and give its PLC address in the Studio.');
  }
  fs.writeFileSync(mark, new Date().toISOString() + '\n');
}
function plcCause(e, M) {
  const c = (e && e.code) || '', at = M ? M.plc.host + ':' + M.plc.port : 'the PLC';
  if (c === 'ECONNREFUSED') return 'The device at ' + at + ' refused the connection. Check the address, and that the PLC has an Ethernet interface with S7 communication.';
  if (c === 'timeout' || c === 'ETIMEDOUT' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'No answer from ' + at + '. Check the network cable, the IP address and that this server is on the same network as the PLC.';
  if (c === 'ENOTFOUND') return 'The name ' + (M ? M.plc.host : '') + ' is not known. Use the IP address of the PLC.';
  if (c === 'refused') return 'The PLC answered but refused the connection. Check the rack and the slot in the machine settings (S7-300: rack 0, slot 2. S7-1200/1500: rack 0, slot 1 or 0), and on S7-1200/1500 allow PUT/GET access in the CPU protection settings.';
  return (e && e.message) || 'The PLC could not be read.';
}
// "2026-10-09T08:00" or a number of ms -> ms
function logTime(v, def) { if (v === null || v === undefined || v === '') return def; const n = /^\d+$/.test(v) ? +v : Date.parse(v); return isFinite(n) ? n : def; }
function logRange(url) {
  const to = logTime(url.searchParams.get('to'), Date.now()), from = logTime(url.searchParams.get('from'), to - 3600e3);
  if (!(from < to)) throw new HttpError(400, 'invalid_argument', 'The start must be before the end.');
  if (to - from > (LOG_DAYS + 1) * 864e5) throw new HttpError(400, 'invalid_argument', 'At most ' + LOG_DAYS + ' days at a time.');
  const ids = String(url.searchParams.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 3000);
  return { from, to, ids };
}
// a time as the person reading the file sees it (their offset from UTC, in minutes, comes with the request)
function csvTime(t, tz) { const d = new Date(t - tz * 60000); return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23); }
function csvCell(v) { v = String(v === undefined || v === null ? '' : v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
// ---------- reset from the app: one request bit per machine, behind that machine's reset code ----------
// Writing is allowed on this server only with ALLOW_RESET=1 in .env (or the older RESET_BIT and RESET_CODE); each machine then needs its bit and its code, set in the Studio.
function resetOn(id) { const M = machines.get(id); return !!(ALLOW_RESET && M && M.plc.host && M.resetBit && secrets[id]); }
const resetTries = new Map(), resetBusy = new Set();
function resetAllowed(ip) {
  const now = Date.now(), e = resetTries.get(ip);
  if (!e || now - e.t > 10 * 60 * 1000) return true;
  return e.n < 5;
}
function resetFailed(ip) { const now = Date.now(), e = resetTries.get(ip); if (!e || now - e.t > 10 * 60 * 1000) resetTries.set(ip, { n: 1, t: now }); else e.n += 1; }
// the request bit is set; the PLC program takes it and clears it. If it is still set after 3 s, nothing in the PLC uses it: it is cleared again here
async function plcReset(M, who) {
  const r = machineReader(M.id), t0 = Date.now(), bit = M.resetBit;
  await plc.writeRequestBit(r, bit, 1);
  let taken = false;
  for (let i = 0; i < 15 && !taken; i++) {
    await new Promise((ok) => setTimeout(ok, 200));
    const v = (await plc.readBits(r, [bit])).values[bit];
    if (v === 0) taken = true;
  }
  if (!taken) await plc.writeRequestBit(r, bit, 0);
  const text = (taken ? 'Reset requested from the app and taken by the PLC' : 'Reset requested from the app but NOT taken by the PLC (request bit cleared again)') + ' · ' + who;
  const L = loggers.get(M.id); if (L) L.note(text);
  console.log(new Date().toISOString(), M.name + ':', text, '(' + bit + ', ' + (Date.now() - t0) + ' ms)');
  return { taken, bit };
}
async function plcRead(id, ids) {
  const c = plcConn(id), key = ids.join(',');
  // several screens asking for the same thing within a moment share one read
  if (c.last.key === key && Date.now() - c.last.at < 250 && c.last.out) return c.last.out;
  if (c.busy && c.busy.key === key) return c.busy.p;
  const p = plc.readBits(c.reader, ids).then((r) => { const out = { at: new Date().toISOString(), values: r.values, unread: r.unread }; c.last = { key, at: Date.now(), out }; return out; });
  c.busy = { key, p };
  try { return await p; } finally { if (c.busy && c.busy.p === p) c.busy = null; }
}
// "node server.js --test-plc": the PLC of .env, or else of each machine
async function plcTest() {
  let list = [];
  if (PLC_HOST) list.push({ name: '.env', plc: { host: PLC_HOST, port: PLC_PORT, rack: PLC_RACK, slot: PLC_SLOT } });
  else { await refreshMachines(); list = Array.from(machines.values()).filter((M) => M.plc.host); for (const L of loggers.values()) L.stop(); for (const W of monitors.values()) W.stop(); }
  if (!list.length) { console.log('No PLC address is set. Set it in the Studio (a machine, Machine settings), or PLC_HOST in .env.'); return 1; }
  let bad = 0;
  for (const M of list) {
    console.log('Connecting to the PLC of ' + M.name + ' at ' + M.plc.host + ':' + M.plc.port + ', rack ' + M.plc.rack + ', slot ' + M.plc.slot + '. Read-only.');
    const r = new plc.S7Reader(M.plc);
    try {
      const ids = []; for (let i = 0; i < 8; i++) ids.push('E0.' + i, 'A0.' + i, 'M0.' + i);
      const out = await plc.readBits(r, ids);
      const byte = (a) => { let s = ''; for (let i = 7; i >= 0; i--) { const v = out.values[a + '0.' + i]; s += v === undefined ? '-' : v; } return s; };
      console.log('Connected. Telegram size ' + r.pdu + ' bytes.');
      console.log('Input byte 0: ' + byte('E') + '   output byte 0: ' + byte('A') + '   memory byte 0: ' + byte('M') + '   (bit 7 on the left, "-" means the PLC has no such address)');
    } catch (e) { bad++; console.log('Not connected. ' + plcCause(e, M)); }
    r.close();
  }
  return bad ? 1 : 0;
}

async function selfTest() {
  if (!API_KEY) { console.log('No ANTHROPIC_API_KEY is set. Add it to .env first.'); return 1; }
  let bad = 0;
  const host = new URL(API_BASE).hostname;
  const viaProxy = OUT_PROXY && API_BASE.startsWith('https:') && !bypassProxy(host);
  console.log('Node.js ' + process.version + '. ' + (viaProxy ? 'Connecting through the proxy ' + OUT_PROXY.replace(/\/\/[^@/]*@/, '//') + '.' : 'Connecting directly, no proxy set.'));
  try { const addrs = await dns.promises.lookup(host, { all: true }); console.log(host + ' resolves to ' + addrs.map((a) => a.address).join(', ')); }
  catch (e) { console.log(host + ' could not be resolved by DNS (' + (e.code || e.message) + ').' + (viaProxy ? ' That is normal behind some proxies.' : '')); }
  for (const tier of ['default', 'complex']) {
    const model = MODELS[tier];
    try {
      const r = await apiPost({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }, null, 90000);
      if (r.status >= 200 && r.status < 300) console.log(model + ': works.');
      else { bad++; console.log(model + ': HTTP ' + r.status + '. ' + aiError(r.status, r.text).message); }
    } catch (e) {
      bad++; console.log(model + ': could not connect to ' + API_BASE + ' (' + netCause(e) + ').');
    }
  }
  return bad ? 1 : 0;
}
function validateAiBody(b, role) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'invalid_request', 'Bad request.');
  const okString = typeof b.input === 'string' && b.input.trim().length > 0;
  const okTurns = Array.isArray(b.input) && b.input.length > 0 && b.input.length <= 40 &&
    b.input.every((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.length > 0) &&
    b.input[0].role === 'user' && b.input[b.input.length - 1].role === 'user';
  if (!okString && !okTurns) throw new HttpError(400, 'invalid_request', 'The input must be a prompt or a list of turns.');
  const chars = okString ? b.input.length : b.input.reduce((n, t) => n + t.content.length, 0);
  if (chars > 262144) throw new HttpError(400, 'prompt_too_large', 'The prompt is too long.');
  const images = Array.isArray(b.images) ? b.images : [];
  if (images.length > 8) throw new HttpError(400, 'image_rejected', 'At most 8 images per request.');
  for (const im of images) {
    if (!im || !IMAGE_TYPES[im.type] || typeof im.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(im.data.slice(0, 200))) throw new HttpError(400, 'image_rejected', 'An image could not be read.');
    if (im.data.length > 9 * 1024 * 1024) throw new HttpError(400, 'image_rejected', 'An image is too large.');
  }
  // Reading photos and drawings is studio work; viewers may only ask text questions.
  if (images.length && role !== 'editor') throw new HttpError(403, 'not_granted', 'Viewers cannot send images.');
  return { input: b.input, images, tier: String(b.tier || 'default'), json: !!b.json };
}
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.status !== 'running' && now - j.t > 15 * 60 * 1000) jobs.delete(id);
  for (const [ip, e] of loginTries) if (now - e.t > 10 * 60 * 1000) loginTries.delete(ip);
}, 60 * 1000).unref();

// ---------- static files ----------
const MIME = { '.webmanifest': 'application/manifest+json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.apk': 'application/vnd.android.package-archive' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
async function serveStatic(req, res, pathname, role) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'not_found', 'Not found.');
  // The cabinet photos shipped with the app are private; everything else in ./public is the app itself.
  // the phone app carries a copy of the cabinets: signed-in users only, like the photos
  if ((rel.startsWith('/photos/') || rel === '/CabinetMapper.apk') && !role) throw new HttpError(401, 'signed_out', 'Sign in first.');
  let buf;
  try { buf = await fsp.readFile(file); } catch (e) { throw new HttpError(404, 'not_found', 'Not found.'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': rel.startsWith('/photos/') ? 'private, max-age=3600' : 'no-cache' };
  if (type.startsWith('text/html')) { headers['Content-Security-Policy'] = CSP; headers['X-Frame-Options'] = 'DENY'; }
  send(res, 200, req.method === 'HEAD' ? '' : buf, headers);
}

// ---------- installing the app on a phone ----------
function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
function installPage(req) {
  const host = String(req.headers.host || 'localhost'), addr = host.replace(/^\[|\]$/g, '');
  const apk = fs.existsSync(path.join(PUBLIC, 'CabinetMapper.apk'));
  const body = '<p>The phone app shows the field view of the cabinets made in the studio. Every change saved in the studio shows on the phones a few seconds later, and the app keeps a copy for use without network.</p>'
    + (apk ? '<h2>1. Download the app (Android)</h2><p>Sign in on this site in the phone browser first (open the address below), then:</p><p><a class="btn" href="/CabinetMapper.apk" download>Download CabinetMapper.apk</a></p>'
      + '<p>Open the downloaded file. If the phone asks, allow installing apps from this browser (Settings → Apps → Special access → Install unknown apps).</p>'
      : '<h2>1. Download the app (Android)</h2><p>The app file is not on this server yet: copy <code>CabinetMapper.apk</code> into the folder <code>public</code> of the server.</p>')
    + '<h2>2. Connect it to this server</h2><p>Open Cabinet Mapper on the phone and enter this address:</p><p><code>' + esc(addr) + '</code></p>'
    + '<p>Then sign in with the access code (the viewer code is enough to look; the phone app changes nothing).</p>'
    + '<p class="n">The phone must be on the same network as this computer. iPhone: there is no iPhone app; the studio opens in Safari.</p>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install the app</title>'
    + '<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#E3E6E2;color:#15232A}main{max-width:620px;margin:0 auto;padding:20px 16px 40px}h1{font-size:24px;margin:8px 0 12px}h2{font-size:18px;margin:24px 0 8px}'
    + '.btn{display:inline-block;background:#0B5C6E;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;word-break:break-all}code{background:#fff;padding:1px 5px;border-radius:4px}.n{color:#4D5D64;font-size:14px}'
    + '@media (prefers-color-scheme:dark){body{background:#11171A;color:#E6ECEA}code{background:#222C31}.n{color:#9FB0B4}}</style></head><body><main><h1>Install Cabinet Mapper on a phone</h1>' + body + '</main></body></html>';
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const role = sessionRole(req);
  let logger = null, plcOn = false;
  const need = (r) => {
    if (!role) throw new HttpError(401, 'signed_out', 'Sign in first.');
    if (r === 'editor' && role !== 'editor') throw new HttpError(403, 'forbidden', 'Only editors can change this.');
  };
  // Browsers send Origin on cross-site writes; refuse those so another site cannot act with this session.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let host = ''; try { host = new URL(origin).host; } catch (e) { /* malformed */ }
      // the address the browser used: the Host header, or the one a tunnel or proxy says it was called by
      const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      if (host !== req.headers.host && !(fwd && host === fwd)) throw new HttpError(403, 'forbidden', 'Cross-site request refused.');
    }
  }

  // installing the app on a phone: the certificate of this server's local authority, and a page that explains the steps
  if (p === '/ca.crt' && req.method === 'GET') {
    if (!TLS) throw new HttpError(404, 'not_found', 'HTTPS is not switched on: set HTTPS_PORT in .env.');
    return send(res, 200, TLS.ca, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="cabinet-mapper-ca.crt"', 'Cache-Control': 'no-cache' });
  }
  if (p === '/install' && req.method === 'GET') return send(res, 200, installPage(req), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });

  if (p === '/api/me' && req.method === 'GET') {
    return send(res, 200, { role, ai: !!API_KEY, plc: anyPlc(), viewerCode: !!VIEWER_CODE, reset: ALLOW_RESET, machines: true });
  }
  if (p === '/api/login' && req.method === 'POST') {
    if (!loginAllowed(clientIp(req))) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait ten minutes.');
    const b = await readJson(req, 4096);
    const code = String((b && b.code) || '').trim();
    let r = null;
    if (code && safeEqual(code, EDITOR_CODE)) r = 'editor';
    else if (code && VIEWER_CODE && safeEqual(code, VIEWER_CODE)) r = 'viewer';
    if (!r) { await new Promise((ok) => setTimeout(ok, 600)); throw new HttpError(401, 'bad_code', 'That access code is not right.'); }
    loginTries.delete(clientIp(req));
    return send(res, 200, { role: r, ai: !!API_KEY, plc: anyPlc(), reset: ALLOW_RESET, machines: true }, { 'Set-Cookie': sessionCookie(req, makeSession(r), SESSION_DAYS * 86400) });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (p === '/api/col' && req.method === 'GET') {
    need();
    const segs = parsePath(url.searchParams.get('path'), false);
    if (role !== 'editor' && !viewerMayRead(segs)) return send(res, 200, { docs: [] });
    return send(res, 200, { docs: await listCol(segs) });
  }
  if (p === '/api/doc') {
    const segs = parsePath(url.searchParams.get('path'), true);
    if (req.method === 'GET') {
      need();
      if (role !== 'editor' && !viewerMayRead(segs)) return send(res, 200, { exists: false });
      const data = await readDoc(segs);
      return send(res, 200, data ? { exists: true, data } : { exists: false });
    }
    if (req.method === 'PUT') {
      need('editor');
      const data = await readJson(req, MAX_DOC);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'invalid_argument', 'A document must be a JSON object.');
      await writeDoc(segs, data);
      if (segs[0] === 'logcfg' && loggers.has(segs[1])) loggers.get(segs[1]).reload().catch(() => {});
      if (segs[0] === 'machines') await refreshMachines();
      if (segs[0] === 'moncfg' && monitors.has(segs[1])) monitors.get(segs[1]).reload().catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      need('editor');
      await deleteDoc(segs);
      if (segs[0] === 'machines' && segs.length === 2) { await refreshMachines(); if (secrets[segs[1]]) setResetCode(segs[1], ''); }
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/assets' && req.method === 'POST') {
    need('editor');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) throw new HttpError(415, 'unsupported_type', 'Only JPEG, PNG, WebP and GIF images can be stored.');
    const buf = await readBody(req, MAX_ASSET);
    if (!buf.length) throw new HttpError(400, 'invalid_request', 'The file is empty.');
    const id = crypto.randomBytes(16).toString('hex');
    await fsp.writeFile(path.join(ASSETS, id), buf);
    await fsp.writeFile(path.join(ASSETS, id + '.json'), JSON.stringify({ contentType: type, sizeBytes: buf.length, createdAt: new Date().toISOString() }));
    return send(res, 200, { id, url: '/_blob/' + id, sizeBytes: buf.length, contentType: type });
  }
  if (p === '/api/assets' && req.method === 'GET') {
    need('editor');
    const names = (await fsp.readdir(ASSETS)).filter((n) => /^[0-9a-f]{32}\.json$/.test(n));
    const assets = []; let bytes = 0;
    for (const n of names) {
      try { const m = JSON.parse(await fsp.readFile(path.join(ASSETS, n), 'utf8')); const id = n.slice(0, 32); bytes += m.sizeBytes || 0; assets.push({ id, url: '/_blob/' + id, contentType: m.contentType, sizeBytes: m.sizeBytes, createdAt: m.createdAt }); } catch (e) { /* skip a damaged entry */ }
    }
    assets.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return send(res, 200, { assets, usage: { files: assets.length, bytes, maxFiles: 100000, maxBytes: 0 } });
  }
  let m = /^\/api\/assets\/([0-9a-f]{32})$/.exec(p);
  if (m && req.method === 'DELETE') {
    need('editor');
    let deleted = false;
    try { await fsp.unlink(path.join(ASSETS, m[1])); deleted = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { await fsp.unlink(path.join(ASSETS, m[1] + '.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return send(res, 200, { deleted });
  }
  m = /^\/_blob\/([0-9a-f]{32})$/.exec(p);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    need();
    let meta, buf;
    try { meta = JSON.parse(await fsp.readFile(path.join(ASSETS, m[1] + '.json'), 'utf8')); buf = await fsp.readFile(path.join(ASSETS, m[1])); }
    catch (e) { throw new HttpError(404, 'not_found', 'Not found.'); }
    return send(res, 200, req.method === 'HEAD' ? '' : buf, { 'Content-Type': IMAGE_TYPES[meta.contentType] ? meta.contentType : 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Disposition': 'inline' });
  }

  // live states from the PLC, for editors and viewers alike. Reading only.
  // ---------- the machine log, one per machine (?machine=<id>): read by everyone signed in; what is logged is set by editors (document logcfg/<machine>) ----------
  if (p.startsWith('/api/log/') && req.method === 'GET') { need(); logger = needLogger(url); plcOn = !!machines.get(url.searchParams.get('machine')).plc.host; }
  if (p === '/api/log/status' && req.method === 'GET') { return send(res, 200, Object.assign(await logger.status(), { plc: plcOn })); }
  if (p === '/api/log/events' && req.method === 'GET') {
    const q = logRange(url), lim = Math.max(10, Math.min(20000, Number(url.searchParams.get('limit')) || 5000));
    return send(res, 200, await logger.events(q.from, q.to, q.ids, lim, url.searchParams.get('alarms') === '1'));
  }
  if (p === '/api/log/series' && req.method === 'GET') {
    const q = logRange(url), mx = Math.max(50, Math.min(4000, Number(url.searchParams.get('max')) || 1200));
    if (!q.ids.length) return send(res, 200, { series: {} });
    return send(res, 200, { series: await logger.series(q.from, q.to, q.ids.slice(0, 40), mx) });
  }
  if (p === '/api/log/export' && req.method === 'GET') {
    const q = logRange(url), what = ['curves', 'alarms'].indexOf(url.searchParams.get('what')) >= 0 ? url.searchParams.get('what') : 'events', tz = Math.max(-900, Math.min(900, Number(url.searchParams.get('tz')) || 0));
    const cfg = logger.cfg, nb = {}, nw = {}, na = {}; cfg.bits.forEach((b) => { nb[b.id] = b; }); cfg.words.forEach((w) => { nw[w.id] = w; }); cfg.alarms.forEach((a) => { na[a.id] = a; });
    const dec = (v) => String(v).replace('.', ',');
    let rows = [];
    if (what === 'alarms') {
      rows.push(['Appeared', 'Cleared', 'Duration (s)', 'Alarm', 'Address', 'Text']);
      const r = await logger.events(q.from, q.to, q.ids, 200000, true);
      occurrences(r, q.from, q.to).forEach((o) => rows.push([(o.before ? 'before ' : '') + csvTime(o.start, tz), o.end ? csvTime(o.end, tz) : 'still there', o.end ? dec(Math.round((o.end - o.start) / 100) / 10) : '', (na[o.id] || {}).no, o.id, (na[o.id] || {}).text]));
    } else if (what === 'events') {
      rows.push(['Time', 'Address', 'Name', 'Comment', 'State']);
      const r = await logger.events(q.from, q.to, q.ids, 200000);
      Object.keys(r.start).sort().forEach((id) => rows.push([csvTime(q.from, tz), id, (nb[id] || {}).name, (nb[id] || {}).text, r.start[id] ? 'ON (at start)' : 'OFF (at start)']));
      r.events.forEach((e) => rows.push(e.sys ? [csvTime(e.t, tz), '', '', e.sys, ''] : [csvTime(e.t, tz), e.id, (nb[e.id] || {}).name, (nb[e.id] || {}).text, e.v ? 'ON' : 'OFF']));
    } else {
      rows.push(['Time', 'Address', 'Name', 'Value', 'Unit']);
      const ids = q.ids.length ? q.ids : cfg.words.map((w) => w.id), out = await logger.series(q.from, q.to, ids.slice(0, 200), 1e9), all = [];
      Object.keys(out).forEach((id) => out[id].forEach((pt) => { if (pt[0] >= q.from) all.push([pt[0], id, pt[1]]); }));
      all.sort((a, b) => a[0] - b[0]).forEach((x) => rows.push([csvTime(x[0], tz), x[1], (nw[x[1]] || {}).name, dec(x[2]), (nw[x[1]] || {}).unit]));
    }
    const name = String(machines.get(url.searchParams.get('machine')).name).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + what + '-' + csvTime(q.from, tz).slice(0, 16).replace(/[: ]/g, '-') + '.csv';
    const body = '\ufeff' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
    return send(res, 200, body, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + name + '"' });
  }
  // ---------- production and maintenance, per machine (?machine=<id>): read by everyone signed in; what is followed is set by editors (document moncfg/<machine>) ----------
  if (p.startsWith('/api/mon/')) {
    need(); const M = needMachine(url.searchParams.get('machine')), W = monitors.get(M.id);
    if (!W) throw new HttpError(503, 'unavailable', 'Production and maintenance are starting. Try again in a moment.');
    const day = (v, def) => (/^\d{4}-\d\d-\d\d$/.test(v || '') ? v : def);
    if (p === '/api/mon/status' && req.method === 'GET') return send(res, 200, Object.assign(W.status(), { plc: !!M.plc.host }));
    if (p === '/api/mon/days' && req.method === 'GET') {
      const to = day(url.searchParams.get('to'), '9999-12-31'), from = day(url.searchParams.get('from'), '0000-01-01');
      const L = await W.days(from, to); return send(res, 200, { days: L.slice(-400) });
    }
    if (p === '/api/mon/relearn' && req.method === 'POST') {
      need('editor'); const b = await readJson(req, 4096); return send(res, 200, { ok: W.relearn(String((b && b.key) || '')) });
    }
    if (p === '/api/mon/export' && req.method === 'GET') {
      const to = day(url.searchParams.get('to'), '9999-12-31'), from = day(url.searchParams.get('from'), '0000-01-01'), what = url.searchParams.get('what') || 'shifts';
      const L = await W.days(from, to), cfg = W.cfg, dec = (x) => String(Math.round(x * 100) / 100).replace('.', ',');
      let rows = [];
      if (what === 'moves') {
        rows.push(['Day', 'Movement', 'Output', 'End switch', 'Strokes', 'Average (s)', 'Shortest (s)', 'Longest (s)', 'Slow', 'Not finished']);
        L.forEach((d) => cfg.moves.forEach((m) => { const x = d.moves[m.key]; if (x) rows.push([d.date, m.name, m.out, m.end, x.n, x.n ? dec(x.sum / x.n) : '', x.min === null ? '' : dec(x.min), x.max === null ? '' : dec(x.max), x.slow, x.fail]); }));
      } else if (what === 'drives') {
        rows.push(['Day', 'Drive', 'Running (h)', 'Starts', 'Faults', 'Warnings voltage', 'Warnings current', 'Warnings thermal']);
        L.forEach((d) => Object.keys(d.drives).forEach((n) => { const x = d.drives[n]; rows.push([d.date, n, dec(x.runS / 3600), x.starts, x.faults, x.w13, x.w14, x.w15]); }));
      } else if (what === 'alarms') {
        const at = {}; cfg.alarms.forEach((a) => { at[a.id] = a; });
        rows.push(['Day', 'Alarm', 'Address', 'Text', 'Times', 'Total (min)']);
        L.forEach((d) => Object.keys(d.alarms).forEach((id) => { const x = d.alarms[id]; rows.push([d.date, (at[id] || {}).no, id, (at[id] || {}).text, x.n, dec(x.s / 60)]); }));
      } else {
        rows.push(['Day', 'Shift'].concat(cfg.counters.map((c) => c.name), ['Running (h)', 'Automatic (h)', 'Alarm (h)', 'Read (h)', 'Stops']));
        L.forEach((d) => d.shifts.forEach((s) => rows.push([d.date, s.start].concat(cfg.counters.map((c) => s.counters[c.id] || 0), [dec(s.runS / 3600), dec(s.autoS / 3600), dec(s.alarmS / 3600), dec(s.readS / 3600), s.stops.length]))));
      }
      const name = String(M.name).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + what + '-' + from.replace('0000-01-01', 'start') + '.csv';
      const body = '\ufeff' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
      return send(res, 200, body, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + name + '"' });
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }
  // ---------- the PLC of a machine ----------
  // what the app needs to know about a machine's PLC: is it set, can it reset
  if (p === '/api/plc/status' && req.method === 'GET') {
    need(); const M = needMachine(url.searchParams.get('machine'));
    return send(res, 200, { plc: !!M.plc.host, reset: resetOn(M.id), resetHere: RESET_FROM_INTERNET || fromLan(req), resetAllowed: ALLOW_RESET, resetBit: M.resetBit, resetCode: !!secrets[M.id] });
  }
  // the Studio: try the PLC address of a machine
  if (p === '/api/plc/test' && req.method === 'POST') {
    need('editor'); const b = await readJson(req, 4096), M = needMachine(b && b.machine);
    if (!M.plc.host) throw new HttpError(400, 'plc_off', 'Give the IP address of the PLC first, then save.');
    try { const out = await plcRead(M.id, ['E0.0', 'A0.0', 'M0.0']); return send(res, 200, { ok: true, unread: out.unread }); }
    catch (e) { throw new HttpError(502, 'plc_unreachable', plcCause(e, M)); }
  }
  // the Studio: the reset code of a machine (kept hashed; empty switches reset off for that machine)
  if (p === '/api/plc/resetcode' && req.method === 'POST') {
    need('editor'); const b = await readJson(req, 4096), M = needMachine(b && b.machine), code = String((b && b.code) || '').trim();
    if (code && (code.length < 4 || code.length > 40)) throw new HttpError(400, 'invalid_argument', 'The reset code needs 4 to 40 characters.');
    setResetCode(M.id, code);
    console.log(new Date().toISOString(), M.name + ': reset code ' + (code ? 'set' : 'removed') + ' by the editor from ' + clientIp(req));
    return send(res, 200, { ok: true, reset: resetOn(M.id) });
  }
  if (p === '/api/plc/reset' && req.method === 'POST') {
    need();
    const b = await readJson(req, 4096), M = needMachine(b && b.machine), code = String((b && b.code) || '').trim();
    if (!resetOn(M.id)) throw new HttpError(403, 'reset_off', ALLOW_RESET ? 'Reset from the app is not set up for this machine (Machine settings in the Studio: reset bit and reset code).' : 'Reset from the app is not allowed on this server (ALLOW_RESET=1 in .env).');
    if (!RESET_FROM_INTERNET && !fromLan(req)) throw new HttpError(403, 'reset_lan_only', 'Reset works only on the network of the plant (its Wi-Fi), not through the internet. Connect the phone to the plant network, or use the reset button of the machine.');
    const ip = clientIp(req);
    if (!resetAllowed(ip)) throw new HttpError(429, 'rate_limited', 'Too many wrong reset codes. Wait ten minutes.');
    if (!resetCodeOk(M.id, code)) { resetFailed(ip); await new Promise((ok) => setTimeout(ok, 800)); throw new HttpError(403, 'bad_code', 'That reset code is not right.'); }
    resetTries.delete(ip);
    if (resetBusy.has(M.id)) throw new HttpError(409, 'busy', 'A reset is already being sent.');
    resetBusy.add(M.id);
    try { return send(res, 200, await plcReset(M, role + ' from ' + ip + (b && b.drive ? ', at the card of ' + String(b.drive).slice(0, 80) : ''))); }
    catch (e) { throw new HttpError(502, 'plc_unreachable', plcCause(e, M)); }
    finally { resetBusy.delete(M.id); }
  }
  if (p === '/api/plc' && req.method === 'POST') {
    need();
    const b = await readJson(req, 256 * 1024), M = needMachine(b && b.machine);
    if (!M.plc.host) throw new HttpError(503, 'plc_off', 'No PLC address is set for ' + M.name + '. An editor sets it in the Studio: open the machine, Machine settings.');
    const ids = Array.isArray(b && b.ids) ? b.ids.filter((x) => typeof x === 'string' && x.length <= 60).slice(0, 4000) : null;
    if (!ids || !ids.length) throw new HttpError(400, 'invalid_argument', 'Give the list of addresses to read.');
    try { return send(res, 200, await plcRead(M.id, ids)); }
    catch (e) { throw new HttpError(502, 'plc_unreachable', plcCause(e, M)); }
  }

  if (p === '/api/ai' && req.method === 'POST') {
    need();
    if (!API_KEY) throw new HttpError(503, 'sampling_disabled', 'No Claude API key is set on the server.');
    const body = validateAiBody(await readJson(req, MAX_AI), role);
    const now = Date.now();
    aiStamps = aiStamps.filter((t) => now - t < 3600 * 1000);
    let running = 0; for (const j of jobs.values()) if (j.status === 'running') running++;
    if (aiStamps.length >= AI_MAX_PER_HOUR || running >= AI_MAX_RUNNING) throw new HttpError(429, 'rate_limited', 'Too many requests to Claude. Try again shortly.');
    aiStamps.push(now);
    const id = crypto.randomBytes(12).toString('hex');
    const job = { status: 'running', ctrl: new AbortController(), t: now };
    jobs.set(id, job);
    runJob(job, body);
    return send(res, 202, { id });
  }
  m = /^\/api\/ai\/([0-9a-f]{24})$/.exec(p);
  if (m) {
    need();
    const job = jobs.get(m[1]);
    if (!job) throw new HttpError(404, 'not_found', 'That request is no longer available.');
    if (req.method === 'DELETE') { if (job.ctrl) job.ctrl.abort(); return send(res, 200, { ok: true }); }
    if (req.method === 'GET') {
      if (job.status === 'running') return send(res, 200, { status: 'running' });
      const out = job.status === 'done' ? { status: 'done', text: job.text, truncated: job.truncated, tier: job.tier } : { status: 'error', code: job.code, message: job.message };
      return send(res, 200, out);
    }
  }
  if (p.startsWith('/api/') || p.startsWith('/_blob/')) throw new HttpError(404, 'not_found', 'Not found.');
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
  return serveStatic(req, res, p, role);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) { res.end(); return; }
    if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    if (e instanceof URIError) return send(res, 400, { error: { code: 'invalid_argument', message: 'Bad address.' } });
    console.error(new Date().toISOString(), req.method, req.url, e);
    send(res, 500, { error: { code: 'unavailable', message: 'The server hit an error.' } });
  });
});
server.requestTimeout = 5 * 60 * 1000;
if (process.argv.includes('--test-claude')) selfTest().then((code) => process.exit(code));
else if (process.argv.includes('--test-plc')) plcTest().then((code) => process.exit(code));
else migrateMachines().catch((e) => console.error('The cabinets could not be put into machines:', e)).then(refreshMachines).then(() => server.listen(PORT, () => {
  console.log('Cabinet Mapper is running on port ' + PORT);
  if (HTTPS_PORT) {
    try {
      TLS = tlsCert.ensureCerts(path.join(DATA, 'tls'), TLS_NAMES);
      const secure = https.createServer({ key: TLS.key, cert: TLS.cert }, (req, res) => server.emit('request', req, res));
      secure.requestTimeout = server.requestTimeout;
      secure.listen(HTTPS_PORT, () => {
        const ips = TLS.names.filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n) && !/^127\./.test(n));
        console.log('HTTPS on port ' + HTTPS_PORT + '. To install the app on a phone, open http://' + (ips[0] || 'this-computer') + ':' + PORT + '/install on the phone.');
      });
      secure.on('error', (e) => console.log('HTTPS could not start on port ' + HTTPS_PORT + ': ' + e.message));
    } catch (e) { console.log('HTTPS could not start: ' + e.message); }
  }
  console.log('Data folder: ' + DATA);
  if (!process.env.EDITOR_CODE) console.log('Editor access code (set EDITOR_CODE to choose your own): ' + EDITOR_CODE);
  console.log(VIEWER_CODE ? 'Viewer access code is set.' : 'No VIEWER_CODE set: only editors can sign in.');
  if (OUT_PROXY) console.log('Requests to the Claude API go through the proxy ' + OUT_PROXY.replace(/\/\/[^@/]*@/, '//'));
  if (!machines.size) console.log('No machine yet: make one in the Studio.');
  for (const M of Array.from(machines.values()).sort((a, b) => a.order - b.order)) {
    console.log('Machine "' + M.name + '": ' + (M.plc.host ? 'PLC ' + M.plc.host + ':' + M.plc.port + ', rack ' + M.plc.rack + ', slot ' + M.plc.slot + (resetOn(M.id) ? ', reads; writes only its reset request bit ' + M.resetBit + '.' : ', read-only.') : 'no PLC address (Machine settings in the Studio).'));
  }
  console.log('Machine log: kept ' + LOG_DAYS + ' days in ' + LOG_ROOT + ', one folder per machine. Choose what is logged in the Studio (a machine, Machine log).');
  console.log(ALLOW_RESET ? 'Reset from the app is allowed on this server (each machine needs its reset bit and its reset code, set in the Studio).' : 'Reset from the app is off (ALLOW_RESET=1 in .env to allow it).');
  console.log(API_KEY ? 'Claude API key is set. Models: ' + MODELS.default + ' / ' + MODELS.complex : 'No ANTHROPIC_API_KEY set: automatic detection and reading are off.');
}));
