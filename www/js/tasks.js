// Tasks live in the terrarium as seed pods. Starting one cracks the pod and
// a sprout grows while you focus; finishing it makes the pod bloom and a
// creature climbs out. Finished blooms stand until midnight, a small garden
// of the day's work, then compost back into the soil.
import { P, FAMILIES } from './palette.js';
import { TAU, clamp, hashStr, mulberry32, pick, uid, drawGlow, smooth, mixHex } from './util.js';

// A sprout reaches full height exactly when its focus target is met.
// Targets are whole minutes; the stepper moves in 5s, typing allows any value.
export const MIN_TARGET = 1, MAX_TARGET = 600, STEP_TARGET = 5;
const DEFAULT_TARGET = 25;
const LEGACY_TARGET = 50; // tasks saved before targets existed grew over 50 minutes
const LAST_TARGET_KEY = 'glasswild.lastTarget';

function loadLastTarget() {
  try {
    const v = parseInt(localStorage.getItem(LAST_TARGET_KEY), 10);
    if (v >= MIN_TARGET && v <= MAX_TARGET) return v;
  } catch {}
  return DEFAULT_TARGET;
}
function saveLastTarget(v) { try { localStorage.setItem(LAST_TARGET_KEY, String(v)); } catch {} }

// runtime caches live on underscored keys; never write them to the save
function stripPrivate(t) {
  const o = {};
  for (const k in t) if (k[0] !== '_') o[k] = t[k];
  return o;
}

// scratch state reused by draw/drawLabels so a repaint allocates nothing
const _pos = { x: 0, y: 0 };
const _labels = []; // pool of { t, x, y }
let _labelN = 0;
const byX = (a, b) => a.x - b.x;
let _fontPx = -1, _fontFam = '', _fontStr = '';

export const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

export class TaskGarden {
  constructor(world, data) {
    this.world = world;
    this.tasks = data?.tasks || [];
    this.history = data?.history || [];
    for (const t of this.tasks) {
      if (!(t.targetMin > 0)) {
        t.targetMin = LEGACY_TARGET;
        t.chimed = this.elapsed(t) >= this.targetMs(t);
      } else if (t.chimed == null) t.chimed = this.elapsed(t) >= this.targetMs(t);
    }
    this._fp = null; // reused world.focusPod object
    this.anim = new Map(); // id -> bloom animation start (world.t)
    this.listeners = [];
  }
  onChange(fn) { this.listeners.push(fn); }
  changed() { for (const fn of this.listeners) fn(); }

  serialize() { return { tasks: this.tasks.map(stripPrivate), history: this.history.slice(-300) }; }

  colorsFor(title) {
    const r = mulberry32(hashStr(title.toLowerCase()));
    return { c1: pick([...FAMILIES.warm, ...FAMILIES.dusk], r), c2: pick([...FAMILIES.cool, P.cream, P.bone], r), glow: pick(FAMILIES.glow, r) };
  }

  get active() {
    for (const t of this.tasks) if (t.state === 'active') return t;
    return null;
  }
  get pending() { return this.tasks.filter((t) => t.state !== 'done'); }
  get doneToday() { const k = dayKey(); return this.tasks.filter((t) => t.state === 'done' && dayKey(t.completedAt) === k); }

  elapsed(t) { return (t.focusMs || 0) + (t.state === 'active' && t.startedAt ? Date.now() - t.startedAt : 0); }
  targetMs(t) { return (t.targetMin || DEFAULT_TARGET) * 60000; }
  // 0..1 progress toward the focus target (not eased; grow() eases it)
  progress(t) { return clamp(this.elapsed(t) / this.targetMs(t), 0, 1); }
  get lastTarget() { return loadLastTarget(); }

  setTarget(id, min) {
    const t = this.tasks.find((x) => x.id === id);
    min = Math.round(min);
    if (!t || !(min > 0)) return;
    min = clamp(min, MIN_TARGET, MAX_TARGET);
    t.targetMin = min;
    // only chime for targets still ahead; lowering below elapsed is silent
    t.chimed = this.elapsed(t) >= this.targetMs(t);
    saveLastTarget(min);
    this.changed();
  }

  // step to the next multiple of five up or down (23 -> 25 or 20)
  stepTarget(id, dir) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    const cur = t.targetMin || DEFAULT_TARGET;
    const next = dir > 0 ? Math.floor(cur / STEP_TARGET) * STEP_TARGET + STEP_TARGET : Math.ceil(cur / STEP_TARGET) * STEP_TARGET - STEP_TARGET;
    this.setTarget(id, clamp(next, STEP_TARGET, MAX_TARGET));
    return t.targetMin;
  }

  // called once a second by the app: publishes the active sprout tip to the
  // world (reusing one object) so creatures can be drawn to it
  tick() {
    const w = this.world;
    const t = this.active;
    if (!t) { w.focusPod = null; return; }
    const fp = (this._fp ||= { x: 0, y: 0 });
    this.podPos(t, fp);
    fp.y -= (3 + 9 * this.grow(t)) * w.U;
    w.focusPod = fp;
  }

  freeSlot() {
    const used = new Set(this.tasks.map((t) => t.slot));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  add(title) {
    title = title.trim().slice(0, 120);
    if (!title) return null;
    const t = { id: uid(), title, created: Date.now(), state: 'seed', focusMs: 0, startedAt: null, completedAt: null, targetMin: loadLastTarget(), chimed: false, slot: this.freeSlot(), ...this.colorsFor(title) };
    this.tasks.push(t);
    const p = this.podPos(t);
    this.world.inject(p.x, 0.03);
    this.world.particles.burst(p.x, p.y, 8, { type: 'spark', color: this.world.sky.ground, speed: 8 * this.world.U, life: 0.8, g: 30 * this.world.U });
    this.world.log(`A seed was planted: “${title}”.`, 'task');
    this.changed();
    return t;
  }

  start(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.state === 'done') return;
    const cur = this.active;
    if (cur && cur !== t) this.pause(cur.id, true);
    t.state = 'active';
    t.startedAt = Date.now();
    const p = this.podPos(t);
    this.world.particles.emit({ type: 'ring', x: p.x, y: p.y, size: this.world.U, grow: 12 * this.world.U, life: 1.3, color: t.glow });
    this.tick();
    this.changed();
  }

  pause(id, silent) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.state !== 'active') return;
    t.focusMs = this.elapsed(t);
    t.startedAt = null;
    t.state = 'seed';
    if (!silent) { this.tick(); this.changed(); }
  }

  complete(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.state === 'done') return null;
    t.focusMs = this.elapsed(t);
    t.startedAt = null;
    t.state = 'done';
    t.completedAt = Date.now();
    this.anim.set(t.id, this.world.t);
    const p = this.podPos(t);
    const w = this.world, U = w.U;
    w.particles.burst(p.x, p.y - 8 * U, 36, { type: 'spark', color: t.c1, glow: t.glow, speed: 22 * U, life: 2.4, size: 2.4, g: -3 * U, drag: 1.2 });
    w.particles.emit({ type: 'ring', x: p.x, y: p.y - 8 * U, size: 2 * U, grow: 30 * U, life: 1.8, color: t.glow });
    w.particles.emit({ type: 'ring', x: p.x, y: p.y - 8 * U, size: U, grow: 18 * U, life: 1.4, color: t.c1 });
    const res = w.bloomTask(t, p.x, p.y - 8 * U);
    t.creature = res.creature ? { id: res.creature.id, name: res.creature.name, kind: res.creature.kind } : null;
    this.history.push({ title: t.title, at: t.completedAt, focusMs: t.focusMs, targetMin: t.targetMin, creature: t.creature });
    this.tick();
    this.changed();
    return { task: t, ...res };
  }

  remove(id) {
    const i = this.tasks.findIndex((x) => x.id === id);
    if (i < 0) return;
    const t = this.tasks[i];
    const p = this.podPos(t);
    this.world.inject(p.x, 0.08);
    this.world.particles.burst(p.x, p.y, 10, { type: 'spark', color: P.ochre, speed: 8 * this.world.U, life: 1, g: 30 * this.world.U });
    if (t.state !== 'done') this.world.log(`“${t.title}” was composted. The soil is a little richer for it.`, 'task');
    this.tasks.splice(i, 1);
    this.tick();
    this.changed();
  }

  rename(id, title) {
    const t = this.tasks.find((x) => x.id === id);
    if (t && title.trim()) { t.title = title.trim().slice(0, 120); this.changed(); }
  }

  // completed blooms from earlier days compost overnight
  rollover() {
    const k = dayKey();
    const old = this.tasks.filter((t) => t.state === 'done' && dayKey(t.completedAt) !== k);
    if (!old.length) return 0;
    for (const t of old) { const p = this.podPos(t, _pos); this.world.inject(p.x, 0.12); }
    this.tasks = this.tasks.filter((t) => !old.includes(t));
    this.world.log(`Yesterday's ${old.length === 1 ? 'bloom' : old.length + ' blooms'} composted into the soil overnight.`, 'milestone');
    this.changed();
    return old.length;
  }

  // ------------------------------------------------------------ geometry
  slots() {
    const w = this.world, U = w.U;
    if (this._slotKey === w.W + 'x' + w.H) return this._slots;
    const xs = [];
    const gap = 9.5 * U;
    const ranges = [[w.W * 0.06, w.pond.x0 - 5 * U], [w.pond.x1 + 5 * U, w.W * 0.97]];
    for (const [a, b] of ranges) for (let x = a; x <= b; x += gap) xs.push(x);
    // interleave so early slots spread across the glass instead of piling left
    const order = [];
    const n = xs.length;
    const used = new Set();
    for (let step = n; step >= 1; step = Math.floor(step / 2)) {
      for (let i = Math.floor(step / 2); i < n; i += step) if (!used.has(i)) { used.add(i); order.push(xs[i]); }
      if (step === 1) break;
    }
    for (let i = 0; i < n; i++) if (!used.has(i)) order.push(xs[i]);
    this._slots = order;
    this._slotKey = w.W + 'x' + w.H;
    return order;
  }

  // pass `out` to fill an existing object instead of allocating one
  podPos(t, out = { x: 0, y: 0 }) {
    const s = this.slots();
    const x = s[t.slot % s.length] + Math.floor(t.slot / s.length) * 2.5 * this.world.U;
    out.x = x; out.y = this.world.groundY(x);
    return out;
  }

  // only the seed pod itself (the egg at the soil line) opens the task;
  // sprouts and finished blooms don't, so they never block creatures
  hit(x, y) {
    const U = this.world.U, half = Math.max(14, 3.5 * U);
    for (const t of this.tasks) {
      if (t.state === 'done') continue;
      const p = this.podPos(t, _pos);
      if (Math.abs(x - p.x) < half && y > p.y - Math.max(20, 5 * U) && y < p.y + 2.5 * U) return t;
    }
    return null;
  }

  // ------------------------------------------------------------ drawing
  // pure drawing: world.focusPod is published by tick(), not here
  draw(ctx, amb, labelAlpha, font) {
    const U = this.world.U;
    for (const t of this.tasks) {
      const p = this.podPos(t, _pos);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(U * 1.25, U * 1.25);
      ctx.lineCap = 'round';
      if (t.state === 'done') this.drawBloom(ctx, amb, t);
      else this.drawPod(ctx, amb, t);
      ctx.restore();
    }
    if (labelAlpha > 0) this.drawLabels(ctx, amb, font, labelAlpha);
  }

  // labels sit on staggered rows above the soil with a thin leader down to
  // their pod, so neighbouring seeds never print over each other
  drawLabels(ctx, amb, font, alpha = 1) {
    if (alpha <= 0.02) return;
    const w = this.world, U = w.U;
    // gather pending pods into the reused pool, sorted by x
    _labelN = 0;
    for (const t of this.tasks) {
      if (t.state === 'done') continue;
      const e = _labels[_labelN] || (_labels[_labelN] = { t: null, x: 0, y: 0 });
      this.podPos(t, e);
      e.t = t;
      _labelN++;
    }
    if (!_labelN) return;
    _labels.length = _labelN; // pool shrinks only when tasks leave
    const pods = _labels;
    pods.sort(byX);
    const fs = Math.max(10, U * 2.4);
    if (fs !== _fontPx || font !== _fontFam) { _fontPx = fs; _fontFam = font; _fontStr = `500 ${fs}px ${font}`; }
    ctx.font = _fontStr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const rowEnd = this._rowEnd || (this._rowEnd = []);
    rowEnd.length = 0;
    const top = w.groundBase - 19 * U;
    for (let i = 0; i < _labelN; i++) {
      const p = pods[i], t = p.t;
      // label text and its width are cached per title and font
      if (t._lwT !== t.title || t._lwF !== _fontStr) {
        t._lwT = t.title; t._lwF = _fontStr;
        t._lbl = t.title.length > 14 ? t.title.slice(0, 13) + '…' : t.title;
        t._lw = ctx.measureText(t._lbl).width;
      }
      const label = t._lbl;
      const half = t._lw / 2 + U * 1.2;
      const x = Math.min(Math.max(p.x, half + U), w.W - half - U);
      let row = 0;
      while (rowEnd[row] != null && rowEnd[row] > x - half) row++;
      rowEnd[row] = x + half;
      const y = top - row * 4 * U;
      const podTop = p.y - (t.state === 'active' ? (4 + 9 * this.grow(t)) * U : 4 * U);
      const active = t.state === 'active';
      ctx.strokeStyle = amb.c(P.cream, 0.28 * alpha);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + 1.6 * U); ctx.lineTo(p.x, podTop); ctx.stroke();
      ctx.fillStyle = amb.c(P.ink, 0.45 * alpha);
      ctx.beginPath(); ctx.roundRect?.(x - half, y - 1.7 * U, half * 2, 3.4 * U, 1.7 * U); ctx.fill();
      ctx.fillStyle = amb.c(active ? P.glowAmber : P.cream, (active ? 1 : 0.85) * alpha);
      ctx.fillText(label, x, y + 0.5);
    }
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < _labelN; i++) pods[i].t = null; // don't pin removed tasks
  }

  grow(t) { return smooth(this.progress(t)); }

  drawPod(ctx, amb, t) {
    const w = this.world;
    const active = t.state === 'active';
    const pulse = active ? 0.5 + 0.5 * Math.sin(w.t * 2.4) : 0.5 + 0.5 * Math.sin(w.t * 0.8 + t.slot);
    const crack = active ? 1 : clamp((t.focusMs || 0) / 60000, 0, 0.6);
    // sprout
    if (active || t.focusMs > 0) {
      const g = this.grow(t);
      const h = 3 + 9 * g;
      const sw = Math.sin(w.t * 0.9 + t.slot) * 0.6;
      ctx.strokeStyle = amb.c(P.moss);
      ctx.lineWidth = 0.45;
      ctx.beginPath(); ctx.moveTo(0, -1.5); ctx.quadraticCurveTo(sw * 0.4, -h * 0.5, sw, -h); ctx.stroke();
      ctx.fillStyle = amb.c(P.sea);
      for (let k = 1; k <= Math.floor(1 + g * 3); k++) {
        const q = k / 4.5;
        const side = k % 2 ? 1 : -1;
        ctx.beginPath(); ctx.ellipse(sw * q + side * 1.1, -h * q, 1.1, 0.42, side * -0.6, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = amb.c(t.c1);
      ctx.beginPath(); ctx.ellipse(sw, -h - 0.8, 0.8 + g * 0.5, 1.1 + g * 0.6, sw * 0.2, 0, TAU); ctx.fill();
      ctx.strokeStyle = amb.c(t.c2, 0.6);
      ctx.lineWidth = 0.18;
      ctx.beginPath(); ctx.moveTo(sw, -h - 1.8 - g * 0.6); ctx.lineTo(sw, -h + 0.2); ctx.stroke();
    }
    // seed pod, half sunk into the soil
    ctx.fillStyle = amb.c(mixHex(t.c1, P.ink, 0.15));
    ctx.beginPath();
    ctx.moveTo(0, -3.4);
    ctx.bezierCurveTo(1.9, -2.6, 2.3, 0.4, 0, 1.2);
    ctx.bezierCurveTo(-2.3, 0.4, -1.9, -2.6, 0, -3.4);
    ctx.fill();
    ctx.strokeStyle = amb.c(t.c2, 0.85);
    ctx.lineWidth = 0.28;
    ctx.beginPath();
    ctx.moveTo(-0.9, -2.2); ctx.quadraticCurveTo(-1.4, -0.8, -0.8, 0.6);
    ctx.moveTo(0.9, -2.2); ctx.quadraticCurveTo(1.4, -0.8, 0.8, 0.6);
    ctx.stroke();
    if (crack > 0.05) {
      ctx.strokeStyle = amb.c(P.ink, 0.7);
      ctx.lineWidth = 0.22;
      ctx.beginPath(); ctx.moveTo(0, -3.4); ctx.lineTo(0.3, -2.6); ctx.lineTo(-0.2, -1.9 + (1 - crack)); ctx.stroke();
    }
    ctx.fillStyle = amb.c(P.cream, 0.4 + pulse * 0.4);
    ctx.beginPath(); ctx.arc(-0.6, -2.3, 0.3, 0, TAU); ctx.fill();
    // soil mound in front
    ctx.fillStyle = amb.c(w.sky.ground);
    ctx.beginPath(); ctx.ellipse(0, 0.6, 3.2, 1.0, 0, Math.PI, TAU); ctx.fill();
  }

  drawBloom(ctx, amb, t) {
    const w = this.world;
    const t0 = this.anim.get(t.id);
    const k = t0 == null ? 1 : smooth(clamp((w.t - t0) / 2.4, 0, 1));
    if (t0 != null && k >= 1) this.anim.delete(t.id);
    const h = 6 + 4 * k;
    const sw = Math.sin(w.t * 0.7 + t.slot) * 0.5;
    ctx.strokeStyle = amb.c(P.olive);
    ctx.lineWidth = 0.45;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(sw * 0.3, -h * 0.5, sw, -h); ctx.stroke();
    ctx.fillStyle = amb.c(P.moss);
    ctx.beginPath(); ctx.ellipse(1.2, -h * 0.35, 1.4, 0.45, -0.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-1.1, -h * 0.55, 1.2, 0.4, 0.6, 0, TAU); ctx.fill();
    // petals
    ctx.save();
    ctx.translate(sw, -h);
    ctx.rotate(w.t * 0.05 + t.slot);
    const n = 7;
    for (let i = 0; i < n; i++) {
      ctx.rotate(TAU / n);
      ctx.fillStyle = amb.c(i % 2 ? t.c1 : mixHex(t.c1, P.cream, 0.25));
      ctx.beginPath(); ctx.ellipse(0, -1.6 * k - 0.4, 0.75 * k + 0.2, 1.5 * k + 0.3, 0, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = amb.c(t.c2);
    ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, TAU); ctx.fill();
    ctx.fillStyle = amb.c(P.ink, 0.7);
    for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; ctx.fillRect(Math.cos(a) * 0.45 - 0.1, Math.sin(a) * 0.45 - 0.1, 0.2, 0.2); }
    ctx.restore();
  }

  drawGlow(ctx) {
    const w = this.world, U = w.U;
    for (const t of this.tasks) {
      const p = this.podPos(t, _pos);
      if (t.state === 'active') {
        const g = this.grow(t);
        drawGlow(ctx, t.glow, p.x, p.y - (3 + 9 * g) * U, (5 + g * 4) * U, 0.35 + w.night * 0.4 + Math.sin(w.t * 2.4) * 0.1);
      } else if (t.state === 'done') {
        drawGlow(ctx, t.glow, p.x, p.y - 10 * U, 5 * U, 0.1 + w.night * 0.45);
      } else if (w.night > 0.3) {
        drawGlow(ctx, t.glow, p.x, p.y - 1.5 * U, 3 * U, w.night * 0.25);
      }
    }
  }
}

