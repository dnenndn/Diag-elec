'use strict';
/*
 * The machine log: the server reads the PLC around the clock (read only, through plc.js) and keeps
 *  - events: every change of a logged bit (a button pressed, a selector switched, a sensor, an output),
 *  - curves: the logged words (speeds, pressures, currents...), stored when they move or once a minute.
 * One log per machine. What is logged is chosen in the Studio (document logcfg/<machine>). Files: <data>/log/<machine>/YYYY-MM-DDTHH.jsonl, one per hour (UTC),
 * each line [time ms, kind, ...]:  [t,'s',{id:v}] states of all bits · [t,'b',id,v] a bit changed · [t,'w',id,v] a word value
 * · [t,'x',text] the PLC was lost or found again · alarms the same way: [t,'S',{id:v}] and [t,'a',id,v] (1 = the alarm appeared, 0 = it cleared). Files older than LOG_DAYS (4) are deleted.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const plc = require('./plc');

const MAX_BITS = 3000, MAX_WORDS = 200, MAX_ALARMS = 1024;
const TYPES = { INT: 2, WORD: 2, DINT: 4, DWORD: 4, REAL: 4, BYTE: 1 };

function hourKey(t) { return new Date(t).toISOString().slice(0, 13); }          // "2026-10-09T14"
function decode(raw, type) {
  if (raw === undefined || raw === null) return null;
  if (type === 'INT') return raw > 32767 ? raw - 65536 : raw;
  if (type === 'DINT') return raw | 0;
  if (type === 'REAL') { const b = Buffer.alloc(4); b.writeUInt32BE(raw >>> 0); return b.readFloatBE(0); }
  return raw;
}
// the size of a word address must match its type: PEW = 2 bytes, MD = 4...
function wordSize(id) { const b = plc.parseBit(id); return b && !b.tc && b.bit < 0 ? b.size : 0; }

// a configuration as typed in the Studio -> a clean one (unknown addresses and silly numbers are dropped)
function cleanCfg(d) {
  d = d && typeof d === 'object' ? d : {};
  const num = (v, lo, hi, def) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };
  const seen = {};
  // alarms first: a bit that is an alarm is logged as an alarm only
  const alarms = (Array.isArray(d.alarms) ? d.alarms : []).filter((b) => {
    const id = b && String(b.id || ''); const p = id && plc.parseBit(id);
    if (!p || p.tc || p.bit < 0 || seen[id]) return false; seen[id] = 1; return true;
  }).slice(0, MAX_ALARMS).map((b) => ({ id: String(b.id), no: String(b.no || '').slice(0, 12), text: String(b.text || '').slice(0, 200) }));
  const bits = (Array.isArray(d.bits) ? d.bits : []).filter((b) => {
    const id = b && String(b.id || ''); const p = id && plc.parseBit(id);
    if (!p || p.tc || p.bit < 0 || seen[id]) return false; seen[id] = 1; return true;
  }).slice(0, MAX_BITS).map((b) => ({ id: String(b.id), name: String(b.name || '').slice(0, 80), text: String(b.text || '').slice(0, 160) }));
  const words = (Array.isArray(d.words) ? d.words : []).filter((w) => {
    const id = w && String(w.id || ''); const sz = id && wordSize(id), t = w && String(w.type || 'INT').toUpperCase();
    if (!sz || seen[id] || TYPES[t] !== sz) return false; seen[id] = 1; return true;
  }).slice(0, MAX_WORDS).map((w) => {
    const sc = w.scale && typeof w.scale === 'object' && [w.scale.r0, w.scale.r1, w.scale.e0, w.scale.e1].every((x) => isFinite(+x)) && +w.scale.r0 !== +w.scale.r1
      ? { r0: +w.scale.r0, r1: +w.scale.r1, e0: +w.scale.e0, e1: +w.scale.e1 } : null;
    return { id: String(w.id), type: String(w.type || 'INT').toUpperCase(), name: String(w.name || '').slice(0, 80), unit: String(w.unit || '').slice(0, 16),
      scale: sc, dead: num(w.dead, 0, 1e9, 0) };
  });
  return { on: d.on !== false, period: num(d.period, 200, 10000, 500), wperiod: num(d.wperiod, 200, 60000, 1000), bits, words, alarms };
}

class Logger {
  constructor(opts) {
    this.dir = opts.dir;                          // the folder of this machine's log
    this.cfgFile = opts.cfgFile;                  // what is logged (the document logcfg/<machine>)
    this.days = opts.days || 4;
    this.getReader = opts.getReader;              // the connection to this machine's PLC, shared with live reading
    this.timers = []; this.stopped = false;
    this.cfg = cleanCfg(null); this.cfg.on = false;
    this.state = {}; this.astate = {}; this.asince = {}; this.wlast = {}; this.buf = []; this.timer = null;
    this.ok = false; this.err = ''; this.since = 0; this.lastRead = 0; this.lastWords = 0; this.reads = 0; this.snapHour = '';
  }
  async start() {
    await fsp.mkdir(this.dir, { recursive: true });
    await this.reload();
    this.timers.push(setInterval(() => this.flush(), 2000), setInterval(() => this.prune().catch(() => {}), 10 * 60 * 1000));
    this.timers.forEach((t) => t.unref());
    this.prune().catch(() => {});
    this.loop();
  }
  async reload() {
    this.loadAt = Date.now();
    let d = null;
    try { d = JSON.parse(await fsp.readFile(this.cfgFile, 'utf8')); } catch (e) { d = null; }
    const was = JSON.stringify(this.cfg);
    this.cfg = d ? cleanCfg(d) : Object.assign(cleanCfg(null), { on: false });
    if (JSON.stringify(this.cfg) !== was) { this.state = {}; this.astate = {}; this.wlast = {}; this.snapHour = ''; }     // a new list: start again with a full picture
  }
  push(line) { this.buf.push(JSON.stringify(line)); if (this.buf.length > 5000) this.flush(); }
  flush() {
    if (!this.buf.length) return;
    // lines are grouped by the hour of their time: each goes to the file of its hour
    const lines = this.buf; this.buf = [];
    const by = {};
    lines.forEach((l) => { const t = +l.slice(1, l.indexOf(',')); const k = hourKey(t); (by[k] || (by[k] = [])).push(l); });
    Object.keys(by).forEach((k) => { fs.appendFile(path.join(this.dir, k + '.jsonl'), by[k].join('\n') + '\n', () => {}); });
  }
  async prune() {
    const keep = Date.now() - this.days * 864e5;
    for (const f of await fsp.readdir(this.dir)) {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/.exec(f); if (!m) continue;
      if (Date.parse(m[1] + ':00:00Z') + 3600e3 < keep) await fsp.unlink(path.join(this.dir, f)).catch(() => {});
    }
  }
  scaled(w, v) {
    if (v === null || !isFinite(v)) return null;
    if (w.scale) v = w.scale.e0 + (v - w.scale.r0) * (w.scale.e1 - w.scale.e0) / (w.scale.r1 - w.scale.r0);
    return Math.round(v * 1000) / 1000;
  }
  // the machine was deleted: stop reading (its files stay until they are older than the days kept)
  stop() { this.stopped = true; this.flush(); this.timers.forEach((t) => clearInterval(t)); clearTimeout(this.timer); }
  loop() {
    if (this.stopped) return;
    const c = this.cfg, wait = c.on && (c.bits.length || c.words.length || c.alarms.length) ? c.period : 2000;
    this.timer = setTimeout(() => this.tick().catch(() => {}).then(() => this.loop()), wait);
  }
  async tick() {
    if (Date.now() - (this.loadAt || 0) > 3000) await this.reload();       // a change made in the Studio is taken within a few seconds
    const c = this.cfg;
    if (!c.on || (!c.bits.length && !c.words.length && !c.alarms.length)) { if (this.ok) this.lost('Logging switched off.'); this.astate = {}; this.asince = {}; return; }
    const reader = this.getReader(); if (!reader) { this.err = 'No PLC address is set for this machine (Machine settings in the Studio).'; return; }
    const now = Date.now(), withWords = c.words.length && now - this.lastWords >= c.wperiod - 50;
    const ids = c.bits.map((b) => b.id).concat(c.alarms.map((a) => a.id), withWords ? c.words.map((w) => w.id) : []);
    let r;
    try { r = await plc.readBits(reader, ids); }
    catch (e) { this.lost((e && (e.message || e.code)) || 'The PLC could not be read.'); return; }
    const t = Date.now();
    if (!this.ok) { this.ok = true; this.err = ''; this.since = t; this.push([t, 'x', 'PLC connected: logging']); this.state = {}; this.astate = {}; this.snapHour = ''; }
    this.lastRead = t; this.reads++;
    // bits: the full picture at the start of each hour (so any time range knows the states it starts with), then each change
    const hk = hourKey(t);
    if (this.snapHour !== hk) {
      const snap = {}; c.bits.forEach((b) => { if (r.values[b.id] !== undefined) snap[b.id] = r.values[b.id]; });
      this.push([t, 's', snap]); this.snapHour = hk; Object.assign(this.state, snap);
      const asnap = {}; c.alarms.forEach((a) => { const v = r.values[a.id]; if (v === undefined) return; asnap[a.id] = v; if (v && this.astate[a.id] !== 1) this.asince[a.id] = t; if (!v) delete this.asince[a.id]; });
      this.push([t, 'S', asnap]); Object.assign(this.astate, asnap);
    } else {
      c.bits.forEach((b) => { const v = r.values[b.id]; if (v === undefined) return; if (this.state[b.id] !== v) { this.push([t, 'b', b.id, v]); this.state[b.id] = v; } });
      c.alarms.forEach((a) => {
        const v = r.values[a.id]; if (v === undefined || this.astate[a.id] === v) return;
        this.push([t, 'a', a.id, v]); this.astate[a.id] = v;
        if (v) this.asince[a.id] = t; else delete this.asince[a.id];
      });
    }
    // words: stored when they move by more than the dead band, and at least once a minute
    if (withWords) {
      this.lastWords = t;
      c.words.forEach((w) => {
        const v = this.scaled(w, decode(r.values[w.id], w.type)); if (v === null) return;
        const L = this.wlast[w.id];
        if (!L || Math.abs(v - L.v) > w.dead || t - L.t >= 60000) { this.push([t, 'w', w.id, v]); this.wlast[w.id] = { v, t }; }
      });
    }
  }
  // a line in the log written by the server itself (a reset from the app, for example)
  note(text) { this.push([Date.now(), 'x', text]); }
  lost(why) {
    if (this.ok) this.push([Date.now(), 'x', 'PLC lost: ' + why]);
    this.ok = false; this.err = why;
  }
  async status() {
    let files = [], bytes = 0;
    try { files = (await fsp.readdir(this.dir)).filter((f) => /\.jsonl$/.test(f)).sort(); } catch (e) { files = []; }
    for (const f of files) { try { bytes += (await fsp.stat(path.join(this.dir, f))).size; } catch (e) { /* gone */ } }
    return { on: this.cfg.on, logging: this.ok, error: this.ok ? '' : this.err, since: this.since || null, last: this.lastRead || null,
      bits: this.cfg.bits.length, words: this.cfg.words.length, alarms: this.cfg.alarms.length,
      // the alarms present now, with the time each appeared (only while the PLC is read)
      active: this.ok ? Object.keys(this.asince).map((id) => ({ id, since: this.asince[id] })).sort((a, b) => b.since - a.since) : [], period: this.cfg.period, wperiod: this.cfg.wperiod, days: this.days,
      oldest: files.length ? files[0].slice(0, 13) + ':00:00Z' : null, bytes };
  }
  // every line between two times, in order, from the hour files that cover them
  async *lines(from, to) {
    this.flush();
    await new Promise((r) => setTimeout(r, 30));
    for (let h = Math.floor(from / 3600e3) * 3600e3; h <= to; h += 3600e3) {
      let txt; try { txt = await fsp.readFile(path.join(this.dir, hourKey(h) + '.jsonl'), 'utf8'); } catch (e) { continue; }
      const L = txt.split('\n');
      for (let i = 0; i < L.length; i++) { if (!L[i]) continue; let x; try { x = JSON.parse(L[i]); } catch (e) { continue; } if (x[0] >= from && x[0] <= to) yield x; }
    }
  }
  // events of a time range: the states at its start, then each change; ids: the bits wanted (all when empty).
  // alarms: true for the alarms only (lines S and a), false for the other signals (s and b)
  async events(from, to, ids, limit, alarms) {
    const want = ids && ids.length ? new Set(ids) : null, start = {}, out = [], SN = alarms ? 'S' : 's', CH = alarms ? 'a' : 'b';
    let more = false;
    // the states at "from": the last full picture before it, and the changes up to it
    for await (const x of this.lines(Math.floor(from / 3600e3) * 3600e3, from - 1)) {
      if (x[1] === SN) Object.assign(start, x[2]); else if (x[1] === CH) start[x[2]] = x[3];
    }
    const prev = Object.assign({}, start);
    for await (const x of this.lines(from, to)) {
      if (x[1] === 'x') { out.push({ t: x[0], sys: x[2] }); continue; }
      // a full picture: what changed since the last one, and the first state of a signal that was not known yet (logging started inside the time chosen)
      if (x[1] === SN) { Object.keys(x[2]).forEach((id) => { if ((prev[id] === undefined || prev[id] !== x[2][id]) && (!want || want.has(id)) && out.length < limit) out.push(prev[id] === undefined ? { t: x[0], id, v: x[2][id], first: 1 } : { t: x[0], id, v: x[2][id] }); prev[id] = x[2][id]; }); continue; }
      if (x[1] !== CH || (want && !want.has(x[2]))) { continue; }
      prev[x[2]] = x[3];
      if (out.length >= limit) { more = true; continue; }
      out.push({ t: x[0], id: x[2], v: x[3] });
    }
    const st = {}; Object.keys(start).forEach((id) => { if (!want || want.has(id)) st[id] = start[id]; });
    return { start: st, events: out.slice(0, limit), more };
  }
  // curves of a time range, each cut down to at most "max" buckets: the lowest and the highest value of each bucket are kept, so no peak is lost
  async series(from, to, ids, max) {
    const want = new Set(ids), raw = {}; ids.forEach((id) => { raw[id] = []; });
    for await (const x of this.lines(from - 60000, to)) if (x[1] === 'w' && want.has(x[2])) raw[x[2]].push([x[0], x[3]]);
    const out = {};
    Object.keys(raw).forEach((id) => {
      const P = raw[id];
      if (P.length <= max * 2) { out[id] = P; return; }
      const span = (to - from) / max, B = [];
      let k = -1, lo = null, hi = null;
      const put = () => { if (!lo) return; if (lo[0] <= hi[0]) { B.push(lo); if (hi !== lo) B.push(hi); } else { B.push(hi); B.push(lo); } };
      P.forEach((p) => { const b = Math.floor((p[0] - from) / span); if (b !== k) { put(); k = b; lo = hi = p; } else { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; } });
      put(); out[id] = B;
    });
    return out;
  }
}

// the alarms of a time range as occurrences: each one from the time it appeared to the time it cleared (end null: still there at the end of the range)
function occurrences(r, from, to) {
  const open = {}, out = [];
  Object.keys(r.start).forEach((id) => { if (r.start[id]) open[id] = { id, start: from, before: true }; });
  r.events.forEach((e) => {
    if (e.sys) return;                       // while the PLC is not read an alarm stays open: its end is known when the PLC is back
    if (e.v && !open[e.id]) open[e.id] = { id: e.id, start: e.t };
    else if (!e.v && open[e.id]) { open[e.id].end = e.t; out.push(open[e.id]); delete open[e.id]; }
  });
  Object.keys(open).forEach((id) => { open[id].end = null; out.push(open[id]); });
  return out.sort((a, b) => b.start - a.start);
}

module.exports = { Logger, cleanCfg, occurrences };
