'use strict';
/* Connection to a Siemens S7 PLC (S7 communication over ISO-on-TCP, port 102). No dependency: Node.js only.
   It READS inputs, outputs, memory, data blocks, inputs taken straight from the modules, the time left of timers and the count of counters.
   It WRITES ONE thing only: a single memory or data-block bit, through writeRequestBit(), used for the reset request
   (RESET_BIT in .env). It cannot write inputs, outputs, words, timers or counters, and it has no function that starts or stops the PLC. */
const net = require('net');

const AREA = { E: 0x81, I: 0x81, A: 0x82, Q: 0x82, M: 0x83, DB: 0x84, P: 0x80, T: 0x1D, Z: 0x1C, C: 0x1C };

function tpkt(payload) { const h = Buffer.from([0x03, 0x00, 0x00, 0x00]); h.writeUInt16BE(payload.length + 4, 2); return Buffer.concat([h, payload]); }

class S7Reader {
  constructor(opt) {
    this.host = opt.host; this.port = opt.port || 102; this.rack = opt.rack || 0; this.slot = opt.slot == null ? 2 : opt.slot;
    this.timeout = opt.timeout || 4000;
    this.sock = null; this.buf = Buffer.alloc(0); this.waiter = null; this.pdu = 240; this.ref = 0; this.chain = Promise.resolve(); this.connType = 0;
  }
  close() { if (this.sock) { try { this.sock.destroy(); } catch (e) { /* closing */ } } this.sock = null; this.buf = Buffer.alloc(0); if (this.waiter) { const w = this.waiter; this.waiter = null; w.fail(new Error('closed')); } }
  // one complete TPKT frame from the stream
  _frame() {
    return new Promise((ok, fail) => {
      const t = setTimeout(() => { this.waiter = null; fail(Object.assign(new Error('The PLC did not answer in time.'), { code: 'timeout' })); this.close(); }, this.timeout);
      const tryRead = () => {
        if (this.buf.length >= 4) {
          const len = this.buf.readUInt16BE(2);
          if (this.buf[0] !== 0x03 || len < 7) { clearTimeout(t); this.waiter = null; fail(new Error('Unexpected answer: this is not an S7 device.')); this.close(); return true; }
          if (this.buf.length >= len) { const f = this.buf.subarray(0, len); this.buf = this.buf.subarray(len); clearTimeout(t); this.waiter = null; ok(Buffer.from(f)); return true; }
        }
        return false;
      };
      this.waiter = { poke: tryRead, fail: (e) => { clearTimeout(t); fail(e); } };
      tryRead();
    });
  }
  _open(connType) {
    return new Promise((ok, fail) => {
      const s = net.connect({ host: this.host, port: this.port });
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; s.destroy(); fail(Object.assign(new Error('No answer from ' + this.host + ':' + this.port + '.'), { code: 'timeout' })); } }, this.timeout);
      s.once('connect', () => { if (done) return; done = true; clearTimeout(t); s.setNoDelay(true); s.setKeepAlive(true, 10000); ok(s); });
      s.once('error', (e) => { if (done) return; done = true; clearTimeout(t); fail(e); });
    }).then(async (s) => {
      this.sock = s; this.buf = Buffer.alloc(0);
      s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); if (this.waiter) this.waiter.poke(); });
      s.on('error', () => { /* reported by the pending read */ });
      s.on('close', () => { if (this.sock === s) { this.sock = null; if (this.waiter) { const w = this.waiter; this.waiter = null; w.fail(Object.assign(new Error('The PLC closed the connection.'), { code: 'closed' })); } } });
      // ISO connection request: remote TSAP = connection type, rack and slot
      const cr = Buffer.from([0x11, 0xE0, 0x00, 0x00, 0x00, 0x01, 0x00, 0xC0, 0x01, 0x0A, 0xC1, 0x02, 0x01, 0x00, 0xC2, 0x02, connType, (this.rack << 5) | this.slot]);
      s.write(tpkt(cr));
      const cc = await this._frame();
      if (cc[5] !== 0xD0) throw Object.assign(new Error('The PLC refused the connection (check rack and slot).'), { code: 'refused' });
      // S7 "setup communication": agree on the telegram size
      const ref = ++this.ref & 0xffff;
      const setup = Buffer.from([0x02, 0xF0, 0x80, 0x32, 0x01, 0x00, 0x00, ref >> 8, ref & 255, 0x00, 0x08, 0x00, 0x00, 0xF0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0xC0]);
      s.write(tpkt(setup));
      const a = await this._frame();
      const p = a.subarray(7);
      if (p[0] !== 0x32 || p[1] !== 0x03 || p[10] !== 0 || p[11] !== 0) throw Object.assign(new Error('The PLC refused the S7 connection.'), { code: 'refused' });
      this.pdu = Math.max(112, Math.min(960, p.readUInt16BE(18)));
      this.connType = connType;
    });
  }
  async connect() {
    if (this.sock) return;
    // programming-device connection first, then operator-panel and basic connections: a PLC keeps a few of each
    const order = this.connType ? [this.connType] : [0x01, 0x02, 0x03];
    let last = null;
    for (const ct of order) {
      try { await this._open(ct); return; } catch (e) { last = e; this.close(); if (e.code !== 'refused' && e.code !== 'closed') break; }
    }
    this.connType = 0;
    throw last;
  }
  // one bit set to 0 or 1 (S7 "write variable", one item). Only reached through writeRequestBit below
  async _writeBit(b, v) {
    const run = async () => {
      await this.connect();
      const ref = ++this.ref & 0xffff, addr = b.byte * 8 + b.bit;
      const par = Buffer.from([0x05, 0x01, 0x12, 0x0A, 0x10, 0x01, 0x00, 0x01, (b.db >> 8) & 255, b.db & 255, b.area, (addr >> 16) & 255, (addr >> 8) & 255, addr & 255]);
      const dat = Buffer.from([0x00, 0x03, 0x00, 0x01, v ? 1 : 0, 0x00]);
      const head = Buffer.from([0x02, 0xF0, 0x80, 0x32, 0x01, 0x00, 0x00, ref >> 8, ref & 255, 0x00, par.length, 0x00, dat.length]);
      this.sock.write(tpkt(Buffer.concat([head, par, dat])));
      const f = await this._frame(), p = f.subarray(7);
      if (p[0] !== 0x32 || p[1] !== 0x03 || p.readUInt16BE(4) !== ref) throw new Error('Unexpected answer from the PLC.');
      if (p[10] || p[11]) throw Object.assign(new Error('The PLC refused the write (error ' + p[10].toString(16) + '/' + p[11].toString(16) + '). On an S7-1200/1500, PUT/GET access must be allowed.'), { code: 'plc_error' });
      const rc = p[12 + p.readUInt16BE(6)];
      if (rc !== 0xFF) throw Object.assign(new Error('The PLC did not accept the write to this address (code ' + rc + ').'), { code: 'plc_error' });
    };
    const pr = this.chain.then(run, run);
    this.chain = pr.catch(() => { this.close(); });
    return pr;
  }
  // items: [{area, db, start, len}] -> one Buffer per item, or null when the PLC has no such address.
  // An item with tc set is one timer or counter: start is its number, the answer is 2 bytes
  async _readChunk(items) {
    const ref = ++this.ref & 0xffff, n = items.length;
    const par = Buffer.alloc(2 + 12 * n); par[0] = 0x04; par[1] = n;
    items.forEach((it, i) => {
      const o = 2 + 12 * i, bit = it.tc ? it.start : it.start * 8;
      par[o] = 0x12; par[o + 1] = 0x0A; par[o + 2] = 0x10; par[o + 3] = it.tc ? it.area : 0x02;
      par.writeUInt16BE(it.tc ? 1 : it.len, o + 4); par.writeUInt16BE(it.area === 0x84 ? it.db : 0, o + 6); par[o + 8] = it.area;
      par[o + 9] = (bit >> 16) & 255; par[o + 10] = (bit >> 8) & 255; par[o + 11] = bit & 255;
    });
    const head = Buffer.from([0x02, 0xF0, 0x80, 0x32, 0x01, 0x00, 0x00, ref >> 8, ref & 255, par.length >> 8, par.length & 255, 0x00, 0x00]);
    this.sock.write(tpkt(Buffer.concat([head, par])));
    const f = await this._frame(), p = f.subarray(7);
    if (p[0] !== 0x32 || (p[1] !== 0x03 && p[1] !== 0x02)) throw new Error('Unexpected answer from the PLC.');
    if (p.readUInt16BE(4) !== ref) throw new Error('Answer out of order from the PLC.');
    if (p[10] || p[11]) throw Object.assign(new Error('The PLC refused the read request (error ' + p[10].toString(16) + '/' + p[11].toString(16) + ').'), { code: 'plc_error' });
    const parLen = p.readUInt16BE(6); let o = 12 + parLen; const out = [];
    if (parLen >= 2 && p[13] !== n) throw new Error('The PLC answered for ' + p[13] + ' addresses instead of ' + n + '.');
    for (let i = 0; i < n; i++) {
      if (o + 4 > p.length) { out.push(null); continue; }
      const rc = p[o], ts = p[o + 1]; let len = p.readUInt16BE(o + 2);
      if (ts === 0x03 || ts === 0x04 || ts === 0x05) len = Math.ceil(len / 8);
      if (rc !== 0xFF) { out.push(null); o += 4; continue; }
      out.push(Buffer.from(p.subarray(o + 4, o + 4 + len)));
      o += 4 + len + (len % 2);
    }
    return out;
  }
  // connected, in turn with the other requests: the telegram size the PLC agreed to is then known
  ready() { const run = () => this.connect(); const p = this.chain.then(run, run); this.chain = p.catch(() => { this.close(); }); return p; }
  // read whole bytes; requests are sent one after the other on a single connection
  readRanges(items) {
    const run = async () => {
      await this.connect();
      const out = new Array(items.length), maxReq = Math.max(1, Math.floor((this.pdu - 14) / 12));
      let i = 0;
      while (i < items.length) {
        let size = 14, j = i;
        while (j < items.length && j - i < maxReq && (j === i || size + 4 + items[j].len + 1 <= this.pdu)) { size += 4 + items[j].len + (items[j].len % 2); j++; }
        const part = await this._readChunk(items.slice(i, j));
        part.forEach((b, k) => { out[i + k] = b; });
        i = j;
      }
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => { this.close(); });
    return p;
  }
}

// "E103.5", "A102.6", "M988.7", "DB17.DBX70.1" -> a bit. "MB10", "MW36", "MD40", "DB30.DBB4", "DB30.DBW108", "DB31.DBD20" -> 1, 2 or 4 bytes.
// "T45", "Z4" -> one timer or counter. null for anything else (symbolic names)
function parseBit(id) {
  let m = /^([EAIQM])(\d{1,5})\.([0-7])$/.exec(id);
  if (m) return { area: AREA[m[1]], db: 0, byte: +m[2], bit: +m[3], size: 1 };
  m = /^DB(\d{1,5})\.DBX(\d{1,5})\.([0-7])$/.exec(id);
  if (m) return { area: AREA.DB, db: +m[1], byte: +m[2], bit: +m[3], size: 1 };
  m = /^([EAIQM])([BWD])(\d{1,5})$/.exec(id);
  if (m) return { area: AREA[m[1]], db: 0, byte: +m[3], bit: -1, size: m[2] === 'B' ? 1 : m[2] === 'W' ? 2 : 4 };
  m = /^DB(\d{1,5})\.DB([BWD])(\d{1,5})$/.exec(id);
  if (m) return { area: AREA.DB, db: +m[1], byte: +m[3], bit: -1, size: m[2] === 'B' ? 1 : m[2] === 'W' ? 2 : 4 };
  // an input taken straight from its module (outside the process image): "PE572.3", "PEW258"
  m = /^P[EI](\d{1,5})\.([0-7])$/.exec(id);
  if (m) return { area: AREA.P, db: 0, byte: +m[1], bit: +m[2], size: 1 };
  m = /^P[EI]([BWD])(\d{1,5})$/.exec(id);
  if (m) return { area: AREA.P, db: 0, byte: +m[2], bit: -1, size: m[1] === 'B' ? 1 : m[1] === 'W' ? 2 : 4 };
  // the time left of a timer, the count of a counter: one 16-bit value each, as the PLC keeps it
  m = /^([TZC])(\d{1,4})$/.exec(id);
  if (m) return { area: AREA[m[1]], tc: true, n: +m[2] };
  return null;
}
// the bytes wanted in one area, grouped into ranges: neighbours are read together, a range stays small enough for one answer
function ranges(area, db, bytes, maxLen, gap) {
  const out = [];
  let s = bytes[0], e = bytes[0];
  for (let i = 1; i <= bytes.length; i++) {
    const x = bytes[i];
    if (x !== undefined && x - e <= gap && x - s < maxLen) { e = x; continue; }
    out.push({ area, db, start: s, len: e - s + 1 }); s = e = x;
  }
  return out;
}
// read a list of addresses: { values: {id: 0|1 for a bit, unsigned number for a byte or word}, unread: [ids the PLC or this reader cannot give] }
async function readBits(reader, ids) {
  const want = [], unread = [], groups = new Map(), tcs = [];
  ids.forEach((id) => {
    const b = parseBit(id); if (!b) { unread.push(id); return; }
    if (b.tc) { tcs.push({ id, item: { area: b.area, db: 0, start: b.n, len: 2, tc: true } }); return; }
    want.push({ id, b }); const k = b.area + ':' + b.db; if (!groups.has(k)) groups.set(k, new Set());
    for (let i = 0; i < b.size; i++) groups.get(k).add(b.byte + i);
  });
  await reader.ready();
  const maxLen = Math.max(16, Math.min(200, reader.pdu - 40));
  let items = [];
  const sorted = new Map();
  for (const [k, set] of groups) {
    const [area, db] = k.split(':').map(Number), bytes = Array.from(set).sort((a, b) => a - b);
    sorted.set(k, bytes);
    // inputs taken straight from the modules: only the bytes asked for, two at a time, so that no read reaches past a module
    items = items.concat(area === AREA.P ? ranges(area, db, bytes, 2, 1) : ranges(area, db, bytes, maxLen, 12));
  }
  let data = items.length ? await reader.readRanges(items) : [];
  // a range the PLC refuses (one address past the end of a data block, for example) is read again in small pieces, so its neighbours are not lost
  const bad = items.map((it, i) => (data[i] ? -1 : i)).filter((i) => i >= 0 && items[i].len > 1);
  if (bad.length) {
    const extra = [];
    bad.slice(0, 60).forEach((i) => {
      const it = items[i], bytes = sorted.get(it.area + ':' + it.db).filter((x) => x >= it.start && x < it.start + it.len);
      ranges(it.area, it.db, bytes, it.area === AREA.P ? 1 : 4, it.area === AREA.P ? 0 : 12).forEach((r) => { if (r.len < it.len) extra.push(r); });
    });
    if (extra.length) { const more = await reader.readRanges(extra); items = items.concat(extra); data = data.concat(more); }
  }
  const index = new Map();
  items.forEach((it, i) => { if (!data[i]) return; const k = it.area + ':' + it.db; if (!index.has(k)) index.set(k, []); index.get(k).push({ it, buf: data[i] }); });
  const values = {};
  const byteAt = (b, n) => {
    const L = index.get(b.area + ':' + b.db); if (!L) return null;
    for (let i = 0; i < L.length; i++) { const o = n - L[i].it.start; if (o >= 0 && o < L[i].buf.length) return L[i].buf[o]; }
    return null;
  };
  want.forEach(({ id, b }) => {
    if (b.bit >= 0) { const v = byteAt(b, b.byte); if (v === null) unread.push(id); else values[id] = (v >> b.bit) & 1; return; }
    let n = 0;
    for (let i = 0; i < b.size; i++) { const v = byteAt(b, b.byte + i); if (v === null) { unread.push(id); return; } n = n * 256 + v; }
    values[id] = n;
  });
  if (tcs.length) {
    const got = await reader.readRanges(tcs.map((x) => x.item));
    tcs.forEach((x, i) => { const buf = got[i]; if (!buf || buf.length < 2) unread.push(x.id); else values[x.id] = buf.readUInt16BE(0); });
  }
  return { values, unread };
}

// the only write: one memory bit ("M250.0") or one data-block bit ("DB30.DBX4.0"). Anything else is refused here
function requestBit(id) {
  const b = parseBit(String(id || ''));
  if (!b || b.tc || b.bit < 0 || (b.area !== AREA.M && b.area !== AREA.DB)) return null;
  return b;
}
async function writeRequestBit(reader, id, v) {
  const b = requestBit(id);
  if (!b) throw new Error('Only a memory bit (M) or a data-block bit (DBx.DBX) can be used as the reset request: ' + id);
  return reader._writeBit(b, v);
}

module.exports = { S7Reader, readBits, parseBit, requestBit, writeRequestBit };
