'use strict';
/*
 * Production and maintenance, one tracker per machine. The server reads the signals chosen in the Studio
 * (document moncfg/<machine>) a few times a second, day and night, and keeps:
 *  - production: the PLC's own counters (what was added each hour, shift and day, and to which material), the time
 *    the machine ran, was in automatic, had an alarm, and each stop with the alarm that caused it;
 *  - maintenance: the time each movement takes (output on -> its end switch reached), with its normal time learned
 *    from the first strokes; the running hours, starts, faults and warnings of each drive; each alarm's count and duration.
 * Files: <data>/monitor/<machine>/days/YYYY-MM-DD.json (one production day, from the first shift of the day), kept 3 years,
 * and state.json (totals and the normal times). Reading only, through plc.js.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const plc = require('./plc');

const KEEP_DAYS = 3 * 366;
const LEARN = 40;                 // strokes used to learn the normal time of a movement
const KEEP_LAST = 30;             // last times kept per movement
const str = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
const bitOk = (id) => { const b = plc.parseBit(String(id || '')); return !!(b && !b.tc && b.bit >= 0); };
const wordOk = (id) => { const b = plc.parseBit(String(id || '')); return !!(b && !b.tc && b.bit < 0); };

function cleanCfg(d) {
  d = d && typeof d === 'object' ? d : {};
  const arr = (a, n) => (Array.isArray(a) ? a : []).slice(0, n);
  const num = (v, lo, hi, def) => { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };
  const shifts = arr(d.shifts, 6).map((h) => Math.floor(num(h, 0, 23, -1))).filter((h) => h >= 0).sort((a, b) => a - b);
  return {
    on: d.on !== false,
    period: num(d.period, 100, 2000, 250),
    shifts: shifts.length ? Array.from(new Set(shifts)) : [5, 13, 21],
    counters: arr(d.counters, 20).filter((c) => c && wordOk(c.id)).map((c) => ({ id: str(c.id, 30), name: str(c.name, 80) || str(c.id, 30), type: /^(INT|DINT|WORD|DWORD|BYTE)$/.test(c.type) ? c.type : 'DINT', per: num(c.per, 0, 10000, 0), perName: str(c.perName, 30), main: !!c.main })),
    material: wordOk(d.material) ? str(d.material, 30) : '',
    run: bitOk(d.run) ? str(d.run, 30) : '',
    runName: str(d.runName, 80),
    auto: arr(d.auto, 20).filter(bitOk).map((x) => str(x, 30)),
    alarms: arr(d.alarms, 1024).filter((a) => a && bitOk(a.id)).map((a) => ({ id: str(a.id, 30), no: str(a.no, 12), text: str(a.text, 160) })),
    moves: arr(d.moves, 200).filter((m) => m && bitOk(m.out) && bitOk(m.end)).map((m) => ({ key: str(m.key || m.out + '>' + m.end, 70), out: str(m.out, 30), end: str(m.end, 30), name: str(m.name, 100) })),
    drives: arr(d.drives, 100).filter((x) => x && x.name).map((x) => ({ name: str(x.name, 80), run: bitOk(x.run) ? str(x.run, 30) : '', fault: bitOk(x.fault) ? str(x.fault, 30) : '', sw: wordOk(x.sw) ? str(x.sw, 30) : '', pcd: arr(x.pcd, 2).filter(wordOk).map((p) => str(p, 30)) })),
  };
}
function decode(raw, type) {
  if (raw === undefined || raw === null) return null;
  if (type === 'INT') return raw > 32767 ? raw - 65536 : raw;
  if (type === 'DINT') return raw | 0;
  return raw >>> 0;
}
const pad = (n) => (n < 10 ? '0' : '') + n;
function localDate(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

class Monitor {
  constructor(opts) {
    this.dir = opts.dir;                       // <data>/monitor/<machine>
    this.cfgFile = opts.cfgFile;               // the document moncfg/<machine>
    this.getReader = opts.getReader;
    this.cfg = cleanCfg(null); this.cfg.on = false; this.cfgKey = '';
    this.state = null; this.day = null; this.prev = null; this.lastT = 0;
    this.ok = false; this.err = ''; this.timers = []; this.stopped = false; this.dirty = false;
  }
  async start() {
    await fsp.mkdir(path.join(this.dir, 'days'), { recursive: true });
    try { this.state = JSON.parse(await fsp.readFile(path.join(this.dir, 'state.json'), 'utf8')); } catch (e) { this.state = null; }
    if (!this.state || typeof this.state !== 'object') this.state = {};
    const S = this.state; S.totals = S.totals || {}; S.moves = S.moves || {}; S.drives = S.drives || {}; S.last = S.last || {};
    await this.reload();
    this.timers.push(setInterval(() => this.save().catch(() => {}), 30000), setInterval(() => this.prune().catch(() => {}), 6 * 3600e3));
    this.timers.forEach((t) => t.unref());
    this.loop();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timers.forEach((t) => clearInterval(t)); this.save().catch(() => {}); }
  async reload() {
    this.loadAt = Date.now();
    let d = null; try { d = JSON.parse(await fsp.readFile(this.cfgFile, 'utf8')); } catch (e) { d = null; }
    const c = d ? cleanCfg(d) : Object.assign(cleanCfg(null), { on: false }), k = JSON.stringify(c);
    if (k !== this.cfgKey) { this.cfg = c; this.cfgKey = k; this.prev = null; }
  }
  // the production day and the shift of a time: the day starts at the first shift
  slot(t) {
    const sh = this.cfg.shifts, d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
    let i = -1; for (let k = 0; k < sh.length; k++) if (h >= sh[k]) i = k;
    const date = i < 0 ? localDate(t - 864e5) : localDate(t);
    return { date, shift: i < 0 ? sh.length - 1 : i, hour: pad(d.getHours()) };
  }
  newDay(date) {
    return { date, shifts: this.cfg.shifts.map((h) => ({ start: pad(h) + ':00', counters: {}, hours: {}, mat: {}, readS: 0, runS: 0, autoS: 0, alarmS: 0, stops: [] })), moves: {}, drives: {}, alarms: {} };
  }
  async dayFor(date) {
    if (this.day && this.day.date === date) return this.day;
    if (this.day) await this.save();
    let d = null; try { d = JSON.parse(await fsp.readFile(path.join(this.dir, 'days', date + '.json'), 'utf8')); } catch (e) { d = null; }
    if (!d || !Array.isArray(d.shifts) || d.shifts.length !== this.cfg.shifts.length) d = Object.assign(this.newDay(date), d && Array.isArray(d.shifts) && d.shifts.length === this.cfg.shifts.length ? d : {});
    this.day = d; return d;
  }
  async save() {
    if (!this.dirty) return; this.dirty = false;
    const w = async (f, o) => { const tmp = f + '.tmp'; await fsp.writeFile(tmp, JSON.stringify(o)); await fsp.rename(tmp, f); };
    if (this.day) await w(path.join(this.dir, 'days', this.day.date + '.json'), this.day);
    await w(path.join(this.dir, 'state.json'), this.state);
  }
  async prune() {
    const keep = localDate(Date.now() - KEEP_DAYS * 864e5);
    for (const f of await fsp.readdir(path.join(this.dir, 'days'))) { const m = /^(\d{4}-\d\d-\d\d)\.json$/.exec(f); if (m && m[1] < keep) await fsp.unlink(path.join(this.dir, 'days', f)).catch(() => {}); }
  }
  ids() {
    const c = this.cfg, s = new Set();
    c.counters.forEach((x) => s.add(x.id)); if (c.material) s.add(c.material); if (c.run) s.add(c.run);
    c.auto.forEach((x) => s.add(x)); c.alarms.forEach((a) => s.add(a.id)); c.moves.forEach((m) => { s.add(m.out); s.add(m.end); });
    c.drives.forEach((d) => { [d.run, d.fault, d.sw].concat(d.pcd).forEach((x) => { if (x) s.add(x); }); });
    return Array.from(s);
  }
  loop() {
    if (this.stopped) return;
    const c = this.cfg, wait = c.on && this.ids().length ? c.period : 2000;
    this.timer = setTimeout(() => this.tick().catch((e) => { this.err = e.message || String(e); }).then(() => this.loop()), wait);
  }
  async tick() {
    if (Date.now() - (this.loadAt || 0) > 3000) await this.reload();
    const c = this.cfg, ids = this.ids();
    if (!c.on || !ids.length) { this.ok = false; this.err = c.on ? 'Nothing to follow yet: set it up in the Studio (Production or Maintenance, Set up from the program).' : 'Switched off.'; this.prev = null; return; }
    const reader = this.getReader(); if (!reader) { this.ok = false; this.err = 'No PLC address is set for this machine (Machine settings in the Studio).'; return; }
    let r; try { r = await plc.readBits(reader, ids); } catch (e) { this.ok = false; this.err = (e && (e.message || e.code)) || 'The PLC could not be read.'; this.prev = null; return; }
    this.ok = true; this.err = '';
    const t = Date.now(), v = r.values, P = this.prev, dt = P && t - this.lastT < 5000 ? (t - this.lastT) / 1000 : 0;
    this.prev = v; this.lastT = t;
    const sl = this.slot(t), D = await this.dayFor(sl.date), sh = D.shifts[sl.shift], S = this.state;
    this.dirty = true; S.lastRead = t;
    // time
    const on = (id) => v[id] === 1, was = (id) => !!(P && P[id] === 1);
    sh.readS += dt;
    if (c.run && on(c.run)) sh.runS += dt;
    if (c.auto.some(on)) sh.autoS += dt;
    const act = c.alarms.filter((a) => on(a.id));
    if (act.length) sh.alarmS += dt;
    // counters: what the PLC added since the last read
    const mat = c.material ? decode(v[c.material], 'INT') : null;
    c.counters.forEach((k) => {
      const x = decode(v[k.id], k.type); if (x === null) return;
      const last = S.last[k.id]; S.last[k.id] = x;
      if (last === undefined || last === null || !P) return;
      let d = x - last;
      if (d < 0) d = x >= 0 && x < 50 ? x : 0;          // the PLC set it back to zero (a new shift, a reset): what it counted since
      if (d <= 0 || d > 500) return;                      // nothing new, or a jump that is not production
      sh.counters[k.id] = (sh.counters[k.id] || 0) + d;
      const hb = sh.hours[sl.hour] || (sh.hours[sl.hour] = {}); hb[k.id] = (hb[k.id] || 0) + d;
      if (mat !== null) { const mb = sh.mat[mat] || (sh.mat[mat] = {}); mb[k.id] = (mb[k.id] || 0) + d; }
      S.totals[k.id] = (S.totals[k.id] || 0) + d;
    });
    // alarms: each one's count and time; a stop runs from the first alarm to the last one clearing
    c.alarms.forEach((a) => {
      if (!on(a.id)) return; const A = D.alarms[a.id] || (D.alarms[a.id] = { n: 0, s: 0 });
      if (P && !was(a.id)) A.n++; A.s += dt;
    });
    if (act.length && !S.stop) S.stop = { t0: t, alarm: act[0].id, shift: sl.shift, date: sl.date };
    if (S.stop && (!act.length || S.stop.date !== sl.date || S.stop.shift !== sl.shift)) {
      const st = S.stop, home = st.date === D.date ? D.shifts[st.shift] : sh;     // a stop across the start of the day is kept in the new day
      if (home) { home.stops.push({ t0: st.t0, t1: t, alarm: st.alarm }); if (home.stops.length > 400) home.stops.shift(); }
      S.stop = act.length ? { t0: t, alarm: act[0].id, shift: sl.shift, date: sl.date } : null;
    }
    // movements: output on -> end switch reached
    c.moves.forEach((m) => {
      const M = S.moves[m.key] || (S.moves[m.key] = { n: 0, learn: [], base: null, last: [], open: null }), o = on(m.out), e = on(m.end);
      if (o && P && !was(m.out) && !e) M.open = t;
      if (M.open) {
        const DM = D.moves[m.key] || (D.moves[m.key] = { n: 0, sum: 0, sq: 0, min: null, max: null, fail: 0, slow: 0 });
        if (e) {
          const s = (t - M.open) / 1000; M.open = null; M.n++;
          DM.n++; DM.sum += s; DM.sq += s * s; DM.min = DM.min === null ? s : Math.min(DM.min, s); DM.max = DM.max === null ? s : Math.max(DM.max, s);
          M.last.push([t, Math.round(s * 1000) / 1000]); if (M.last.length > KEEP_LAST) M.last.shift();
          if (M.base === null) { M.learn.push(s); if (M.learn.length >= LEARN) { const q = M.learn.slice().sort((a, b) => a - b); M.base = q[Math.floor(q.length / 2)]; M.baseAt = t; M.learn = []; } }
          else if (s > M.base * 1.5 + 0.3) DM.slow++;
        } else if (!o || t - M.open > Math.max(60000, (M.base || 0) * 5000)) { DM.fail++; M.open = null; }   // stopped, or far too long, without reaching its switch
      }
    });
    // drives
    c.drives.forEach((d) => {
      const T = S.drives[d.name] || (S.drives[d.name] = { runS: 0, starts: 0, faults: 0 }), DD = D.drives[d.name] || (D.drives[d.name] = { runS: 0, starts: 0, faults: 0, w13: 0, w14: 0, w15: 0, pcd: [] });
      if (d.run && on(d.run)) { T.runS += dt; DD.runS += dt; if (P && !was(d.run)) { T.starts++; DD.starts++; } }
      if (d.fault && on(d.fault) && P && !was(d.fault)) { T.faults++; DD.faults++; }
      if (d.sw && v[d.sw] !== undefined && P && P[d.sw] !== undefined) [13, 14, 15].forEach((b) => { if ((v[d.sw] >> b) & 1 && !((P[d.sw] >> b) & 1)) DD['w' + b]++; });
      d.pcd.forEach((p, i) => {
        const x = v[p]; if (x === undefined) return; const st = DD.pcd[i] || (DD.pcd[i] = { n: 0, sum: 0, min: null, max: null });
        if (d.run && !on(d.run)) return;                     // load while the motor runs
        st.n++; st.sum += x; st.min = st.min === null ? x : Math.min(st.min, x); st.max = st.max === null ? x : Math.max(st.max, x);
      });
    });
  }
  // the normal time of a movement is learned again from its next strokes (after a repair, for example)
  relearn(key) { const M = this.state.moves[key]; if (!M) return false; M.base = null; M.learn = []; this.dirty = true; return true; }
  status() {
    return { on: this.cfg.on, ok: this.ok, error: this.ok ? '' : this.err, last: this.state.lastRead || null, cfg: this.cfg, slot: this.slot(Date.now()),
      today: this.day && this.day.date === this.slot(Date.now()).date ? this.day : null, totals: this.state.totals, stop: this.state.stop || null,
      moves: Object.fromEntries(Object.entries(this.state.moves).map(([k, m]) => [k, { n: m.n, base: m.base, learning: m.base === null ? m.learn.length : 0, learnOf: LEARN, last: m.last, open: m.open, baseAt: m.baseAt || null }])),
      drives: this.state.drives };
  }
  async days(from, to) {
    await this.save().catch(() => {});
    const out = [];
    for (const f of (await fsp.readdir(path.join(this.dir, 'days'))).sort()) {
      const m = /^(\d{4}-\d\d-\d\d)\.json$/.exec(f); if (!m || m[1] < from || m[1] > to) continue;
      try { out.push(JSON.parse(await fsp.readFile(path.join(this.dir, 'days', f), 'utf8'))); } catch (e) { /* skip */ }
    }
    if (this.day && this.day.date >= from && this.day.date <= to) { const i = out.findIndex((d) => d.date === this.day.date); if (i >= 0) out[i] = this.day; else out.push(this.day); }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
}
module.exports = { Monitor, cleanCfg, localDate };
