// Tasks live in the terrarium as seed pods. Starting one cracks the pod and
// a sprout grows while you focus; finishing it makes the pod bloom and a
// creature climbs out. Finished blooms stand until midnight, a small garden
// of the day's work, then compost back into the soil.
import { P, FAMILIES } from './palette.js';
import { TAU, clamp, hashStr, mulberry32, pick, uid, drawGlow, smooth, mixHex } from './util.js';
import { parseEntry, endOfDay, startOfDay, DAY } from './when.js';

// Neglect. A task past its due date grows a weed out of its pod, and the
// longer it's left the worse it gets, gently at first:
//   stage 1, the first day:   thorny shoots. Only looks bad.
//   stage 2, days 1-3:        it spreads and sours its patch: plants there
//                             wither and nothing new sprouts.
//   stage 3, days 3-7:        feral. Brambles reach the neighbouring patches
//                             and their thorns wear down passing creatures.
//   stage 4, a week or more:  blight. Its spores carry the gloomcap fungus.
// Seeds without a date get a week from when they were last touched, wilting
// for the last few days of it. Finishing the task kills the weed; snoozing
// makes it recede over a few hours; pulling it drops the task.
export const UNDATED_GRACE = 7 * DAY;
const WILT_FROM = 3 * DAY;
const RECEDE = 4; // weed-days lost per day once it's no longer overdue
const BLIGHT = [null, null, [0.35], [0.6, 0.3], [0.9, 0.6, 0.3]]; // per stage, by distance in buckets
export const STAGE_NAME = ['', 'sprouting weeds', 'spreading weeds', 'gone feral', 'spreading blight'];
const WEED = { stem: '#2f3320', dark: '#1d1722', bruise: '#3d2238', thorn: '#d0453a', pus: '#9c8f34', spore: '#c4d36a', leaf: '#3e4424', haze: '#120d16' };
export const stageOf = (L) => (L <= 0 ? 0 : L < 1 ? 1 : L < 3 ? 2 : L < 7 ? 3 : 4);

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
const _bud = { x: 0, y: 0 };
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
      t.steps ||= [];
      t.due ??= null;
      t.touched ||= Date.now(); // tasks from before neglect existed start their week now
      t.weed ||= 0;
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
  find(id) { return this.tasks.find((x) => x.id === id); }

  // ------------------------------------------------------------ due dates & neglect
  // when neglect starts counting: the due date, or a week after last touched
  deadline(t) { return t.due ?? (t.touched || t.created) + UNDATED_GRACE; }
  overdue(t, now = Date.now()) { return t.state !== 'done' && t.due != null && now > t.due; }
  // an undated seed in its last few days before turning
  wilting(t, now = Date.now()) { return t.state !== 'done' && t.due == null && now - (t.touched || t.created) > WILT_FROM && !t.weed; }
  stage(t) { return t.state === 'done' ? 0 : stageOf(t.weed); }
  get overdueCount() { let n = 0; const now = Date.now(); for (const t of this.tasks) if (this.overdue(t, now) || this.stage(t) > 0) n++; return n; }
  // the worst weed in the glass
  get worstStage() { let s = 0; for (const t of this.tasks) s = Math.max(s, this.stage(t)); return s; }

  // grow or recede every weed, publish the blight to the world, and report
  // stage changes (returns the task that got worse, if any)
  updateWeeds(now = Date.now()) {
    const w = this.world;
    let worse = null;
    for (const t of this.tasks) {
      if (t.state === 'done') continue;
      const last = t.weedAt || now;
      t.weedAt = now;
      const late = (now - this.deadline(t)) / DAY;
      const before = this.stage(t);
      if (late > 0) t.weed = Math.max(t.weed || 0, late, 0.001);
      else if (t.weed > 0) t.weed = Math.max(0, t.weed - RECEDE * (now - last) / DAY);
      const after = this.stage(t);
      if (after > before && (!worse || after > this.stage(worse))) worse = t;
      t._stage = after;
    }
    // blight per soil bucket, for the ecosystem to feel
    const B = w.blight;
    if (B) {
      B.fill(0);
      const n = B.length;
      for (const t of this.tasks) {
        const st = t._stage;
        if (!st || !BLIGHT[st]) continue;
        const b = w.bucketOf(this.podPos(t, _pos).x);
        BLIGHT[st].forEach((v, d) => {
          if (b - d >= 0) B[b - d] = Math.min(1, B[b - d] + v);
          if (d && b + d < n) B[b + d] = Math.min(1, B[b + d] + v);
        });
      }
    }
    return worse;
  }

  setDue(id, due, allDay = true) {
    const t = this.find(id);
    if (!t) return;
    t.due = due == null ? null : allDay ? endOfDay(due) : due;
    t.allDay = due == null ? false : allDay;
    t.touched = Date.now();
    this.updateWeeds();
    this.changed();
  }
  // push it to tomorrow (same time if it had one)
  snooze(id) {
    const t = this.find(id);
    if (!t) return;
    const now = Date.now();
    if (t.due != null && !t.allDay) {
      const d = new Date(t.due), n = new Date(startOfDay(now) + DAY);
      n.setHours(d.getHours(), d.getMinutes(), 0, 0);
      t.due = n.getTime();
    } else t.due = endOfDay(now + DAY);
    t.allDay = t.allDay ?? true;
    t.touched = now;
    if (t.weed) this.world.log(`“${t.title}” was put off until tomorrow. Its weeds will die back.`, 'task');
    this.updateWeeds();
    this.changed();
  }

  // ------------------------------------------------------------ steps
  addStep(id, title) {
    const t = this.find(id);
    title = (title || '').trim().slice(0, 120);
    if (!t || !title || t.state === 'done') return null;
    const st = { id: uid(), title, done: false };
    t.steps.push(st);
    t.touched = Date.now();
    this.changed();
    return st;
  }
  removeStep(id, sid) {
    const t = this.find(id);
    if (!t) return;
    t.steps = t.steps.filter((x) => x.id !== sid);
    this.changed();
  }
  // returns 'all' when that was the last open step
  toggleStep(id, sid) {
    const t = this.find(id);
    const st = t?.steps.find((x) => x.id === sid);
    if (!st || t.state === 'done') return null;
    st.done = !st.done;
    st.doneAt = st.done ? Date.now() : null;
    t.touched = Date.now();
    if (st.done) {
      const w = this.world, U = w.U;
      const p = this.budPos(t, t.steps.indexOf(st));
      w.particles.burst(p.x, p.y, 10, { type: 'spark', color: t.c1, glow: t.glow, speed: 9 * U, life: 1.1, g: -2 * U });
      w.inject(p.x, 0.01);
      // in a task-only glass, every finished step sprouts something small
      if (w.taskOnly) w.plantFromTask(this.podPos(t, _pos).x + (Math.random() - 0.5) * 16 * U, 0.15, Math.random() < 0.6 ? 'grass' : undefined);
    }
    this.changed();
    return st.done && t.steps.every((x) => x.done) ? 'all' : st.done ? 'done' : 'undone';
  }
  stepsDone(t) { let n = 0; for (const x of t.steps) if (x.done) n++; return n; }

  // where the k-th bud of a project sits, in world space
  budPos(t, k, out = { x: 0, y: 0 }) {
    const U = this.world.U * 1.25;
    this.podPos(t, out);
    const b = this.bud(t, k);
    out.x += b.x * U; out.y += b.y * U;
    return out;
  }
  // pod-local bud layout: alternating up a stalk
  bud(t, k) {
    const n = Math.min(t.steps.length, 10);
    const h = this.stalkH(t);
    const q = (k % 10 + 1) / (n + 1);
    const side = k % 2 ? 1 : -1;
    const sw = Math.sin(this.world.t * 0.8 + t.slot) * 0.5 * q;
    return (_bud.x = sw + side * (1.1 + 0.4 * (1 - q)), _bud.y = -3 - (h - 3) * q, _bud);
  }
  stalkH(t) { return 5 + Math.min(t.steps.length, 10) * 0.9; }
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
    const worse = this.updateWeeds();
    this.weedSpores();
    const t = this.active;
    if (!t) { w.focusPod = null; return worse; }
    const fp = (this._fp ||= { x: 0, y: 0 });
    this.podPos(t, fp);
    fp.y -= (3 + 9 * this.grow(t)) * w.U;
    w.focusPod = fp;
    return worse;
  }

  // blighted weeds shed drifting spores (visual; the harm is in world.blight)
  weedSpores() {
    const w = this.world;
    if (w.offline) return;
    const U = w.U;
    for (const t of this.tasks) {
      const st = t._stage;
      if (st < 3 || Math.random() > (st === 4 ? 0.9 : 0.35)) continue;
      const p = this.podPos(t, _pos);
      w.particles.emit({ type: 'mote', x: p.x + (Math.random() - 0.5) * 10 * U, y: p.y - (4 + Math.random() * 6) * U, vx: (Math.random() - 0.5) * 4 * U, vy: -(1 + Math.random() * 3) * U, g: -0.5 * U, drag: 0.6, wob: 6, life: 3 + Math.random() * 2, size: 1.2 + Math.random(), color: st === 4 ? WEED.spore : WEED.pus });
    }
  }

  freeSlot() {
    const used = new Set(this.tasks.map((t) => t.slot));
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  add(text) {
    const e = parseEntry(text || '');
    if (!e || !e.title) return null;
    const title = e.title.slice(0, 120);
    const now = Date.now();
    const t = { id: uid(), title, created: now, touched: now, state: 'seed', focusMs: 0, startedAt: null, completedAt: null, targetMin: loadLastTarget(), chimed: false, slot: this.freeSlot(),
      due: e.due, allDay: e.allDay, steps: e.steps.map((x) => ({ id: uid(), title: x, done: false })), weed: 0, ...this.colorsFor(title) };
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
    t.touched = t.startedAt;
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
    for (const x of t.steps) if (!x.done) { x.done = true; x.doneAt = t.completedAt; }
    this.anim.set(t.id, this.world.t);
    const p = this.podPos(t);
    const w = this.world, U = w.U;
    const st = stageOf(t.weed);
    if (st) {
      // the weed dies with the task
      w.particles.burst(p.x, p.y - 3 * U, 14 + st * 6, { type: 'spark', color: WEED.stem, speed: 12 * U, life: 1.4, g: 20 * U });
      w.log(st >= 3 ? `“${t.title}” is finally done. The brambles around it are dying back and the soil is clearing.` : `“${t.title}” is done, and its weeds wither.`, 'task');
      t.weedWas = st;
    }
    t.weed = 0; t._stage = 0;
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
    const st = this.stage(t);
    if (st) {
      this.world.particles.burst(p.x, p.y - 2 * this.world.U, 18, { type: 'spark', color: WEED.stem, speed: 14 * this.world.U, life: 1.2, g: 30 * this.world.U });
      this.world.log(`The weeds of “${t.title}” were pulled up, task and all.`, 'task');
    } else if (t.state !== 'done') this.world.log(`“${t.title}” was composted. The soil is a little richer for it.`, 'task');
    this.tasks.splice(i, 1);
    this.tick();
    this.changed();
  }

  rename(id, title) {
    const t = this.tasks.find((x) => x.id === id);
    if (t && title.trim()) { t.title = title.trim().slice(0, 120); t.touched = Date.now(); this.changed(); }
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
    const U = this.world.U;
    for (const t of this.tasks) {
      if (t.state === 'done') continue;
      const st = t._stage || 0;
      const half = Math.max(14, (3.5 + (st >= 2 ? 2 : 0)) * U);
      const top = Math.max(20, (t.steps.length ? this.stalkH(t) * 1.25 : 5 + st * 1.5) * U);
      const p = this.podPos(t, _pos);
      if (Math.abs(x - p.x) < half && y > p.y - top && y < p.y + 2.5 * U) return t;
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
      else {
        if (t._stage) this.drawWeed(ctx, amb, t);
        ctx.save(); this.drawPod(ctx, amb, t); ctx.restore();
        if (t.steps.length) this.drawBuds(ctx, amb, t);
      }
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
    const now = Date.now();
    let pending = 0;
    for (const t of this.tasks) if (t.state !== 'done') pending++;
    const crowded = pending > 6;
    const soon = endOfDay(now);
    for (const t of this.tasks) {
      if (t.state === 'done') continue;
      // with a long list, only label what's active, late, or due today
      if (crowded && t.state !== 'active' && !(t.due != null && t.due <= soon) && !t._stage) continue;
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
      const n = t.steps.length;
      const key = t.title + (n ? this.stepsDone(t) + '/' + n : '');
      if (t._lwT !== key || t._lwF !== _fontStr) {
        t._lwT = key; t._lwF = _fontStr;
        t._lbl = (t.title.length > 14 ? t.title.slice(0, 13) + '…' : t.title) + (n ? ` ${this.stepsDone(t)}/${n}` : '');
        t._lw = ctx.measureText(t._lbl).width;
      }
      const label = t._lbl;
      const half = t._lw / 2 + U * 1.2;
      const x = Math.min(Math.max(p.x, half + U), w.W - half - U);
      let row = 0;
      while (rowEnd[row] != null && rowEnd[row] > x - half) row++;
      rowEnd[row] = x + half;
      const y = top - row * 4 * U;
      const podTop = p.y - (t.steps.length ? this.stalkH(t) * 1.25 * U : t.state === 'active' ? (4 + 9 * this.grow(t)) * U : 4 * U);
      const active = t.state === 'active';
      const late = t._stage > 0 || (t.due != null && t.due < now);
      const today = !late && t.due != null && t.due <= soon;
      ctx.strokeStyle = amb.c(P.cream, 0.28 * alpha);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + 1.6 * U); ctx.lineTo(p.x, podTop); ctx.stroke();
      ctx.fillStyle = amb.c(P.ink, 0.45 * alpha);
      ctx.beginPath(); ctx.roundRect?.(x - half, y - 1.7 * U, half * 2, 3.4 * U, 1.7 * U); ctx.fill();
      ctx.fillStyle = amb.c(late ? '#5a1f22' : P.ink, (late ? 0.7 : 0.45) * alpha);
      if (late || today) { ctx.beginPath(); ctx.roundRect?.(x - half, y - 1.7 * U, half * 2, 3.4 * U, 1.7 * U); ctx.fill(); }
      ctx.fillStyle = amb.c(active ? P.glowAmber : late ? '#ff9a88' : today ? P.amber : P.cream, (active || late ? 1 : 0.85) * alpha);
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
    if ((active || t.focusMs > 0) && !t.steps.length) {
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
    // seed pod, half sunk into the soil; a neglected one droops and greys
    const sick = t._stage ? Math.min(0.7, 0.25 + t._stage * 0.12) : this.wilting(t) ? 0.3 : 0;
    if (sick) ctx.rotate(Math.sin(t.slot * 1.7) > 0 ? 0.25 : -0.25);
    ctx.fillStyle = amb.c(mixHex(mixHex(t.c1, '#6d6450', sick), P.ink, 0.15));
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

  // a project grows a stalk with one bud per step; finished steps open
  drawBuds(ctx, amb, t) {
    const w = this.world;
    const h = this.stalkH(t);
    const sw = Math.sin(w.t * 0.8 + t.slot) * 0.5;
    ctx.save();
    ctx.strokeStyle = amb.c(t._stage ? WEED.leaf : P.moss);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(0, -3); ctx.quadraticCurveTo(sw * 0.4, -3 - (h - 3) * 0.5, sw, -h); ctx.stroke();
    const n = Math.min(t.steps.length, 10);
    for (let k = 0; k < n; k++) {
      const st = t.steps[k];
      const b = this.bud(t, k);
      const bx = b.x, by = b.y;
      const side = k % 2 ? 1 : -1;
      ctx.strokeStyle = amb.c(P.moss);
      ctx.lineWidth = 0.22;
      ctx.beginPath(); ctx.moveTo(bx - side * 0.9, by + 0.5); ctx.lineTo(bx, by); ctx.stroke();
      if (st.done) {
        ctx.fillStyle = amb.c(t.c1);
        for (let i = 0; i < 5; i++) {
          const a = i / 5 * TAU + w.t * 0.1;
          ctx.beginPath(); ctx.ellipse(bx + Math.cos(a) * 0.6, by + Math.sin(a) * 0.6, 0.55, 0.35, a, 0, TAU); ctx.fill();
        }
        ctx.fillStyle = amb.c(t.c2);
        ctx.beginPath(); ctx.arc(bx, by, 0.35, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = amb.c(mixHex(t.c1, P.moss, 0.55));
        ctx.beginPath(); ctx.ellipse(bx, by, 0.42, 0.7, side * 0.4, 0, TAU); ctx.fill();
        ctx.fillStyle = amb.c(t.c1, 0.8);
        ctx.beginPath(); ctx.ellipse(bx + side * 0.12, by - 0.45, 0.2, 0.3, side * 0.4, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }

  // the weed of a neglected task, worse with every stage
  drawWeed(ctx, amb, t) {
    const w = this.world;
    const st = t._stage;
    const L = Math.min(t.weed, 10);
    const r = mulberry32(hashStr(t.id));
    const grow = st === 1 ? 0.4 + 0.6 * L : 1;
    const sway = Math.sin(w.t * 0.6 + t.slot) * 0.25;
    const tall = [0, 4.5, 7.5, 10, 12][st] * grow;
    ctx.save();
    // feral brambles creep along the ground to either side
    if (st >= 3) {
      const reach = (st === 3 ? 6 + (L - 3) * 1.6 : 12 + Math.min(L - 7, 6) * 0.8);
      ctx.strokeStyle = amb.c(WEED.dark);
      ctx.lineWidth = 0.55;
      for (const dir of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(0, 0.2);
        let x = 0;
        for (let i = 1; i <= 4; i++) {
          const nx = dir * reach * i / 4;
          ctx.quadraticCurveTo((x + nx) / 2, -1.6 - r() * 1.2, nx, 0.3);
          x = nx;
        }
        ctx.stroke();
        ctx.fillStyle = amb.c(WEED.thorn);
        for (let i = 1; i < 8; i++) {
          const tx = dir * reach * i / 8, ty = -0.6 - (i % 2) * 0.6;
          ctx.beginPath(); ctx.moveTo(tx - 0.2, ty); ctx.lineTo(tx + dir * 0.15, ty - 0.7); ctx.lineTo(tx + 0.2, ty); ctx.fill();
        }
      }
    }
    // a dark haze hangs around it from the second stage
    if (st >= 2) {
      const R = tall * 0.7 + 3 + st;
      const gr = ctx.createRadialGradient(0, -tall * 0.4, 0, 0, -tall * 0.4, R);
      gr.addColorStop(0, amb.c(WEED.haze, 0.12 + 0.05 * st));
      gr.addColorStop(1, amb.c(WEED.haze, 0));
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(0, -tall * 0.4, R, 0, TAU); ctx.fill();
    }
    // shoots: more, taller and darker as it worsens
    const shoots = [3, 3, 5, 7, 9][st];
    for (let i = 0; i < shoots; i++) {
      const bx = (r() - 0.5) * (2 + st * 1.6);
      const h = tall * (0.55 + r() * 0.45);
      const lean = (r() - 0.5) * 3 + sway * (1 + i % 3);
      const tx = bx + lean, ty = -h;
      ctx.strokeStyle = amb.c(i % 3 ? WEED.stem : WEED.bruise);
      ctx.lineWidth = 0.45 + st * 0.08;
      ctx.beginPath(); ctx.moveTo(bx, 0.4); ctx.quadraticCurveTo(bx + lean * 0.2, -h * 0.6, tx, ty); ctx.stroke();
      // a claw hook at the tip
      const hk = lean > 0 ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(tx + hk * 0.9, ty - 1.1, tx + hk * 1.3, ty + 0.2); ctx.stroke();
      ctx.fillStyle = amb.c(WEED.thorn);
      ctx.beginPath(); ctx.moveTo(tx + hk * 1.1, ty - 0.1); ctx.lineTo(tx + hk * 1.5, ty + 0.9); ctx.lineTo(tx + hk * 1.5, ty - 0.1); ctx.fill();
      // thorns
      ctx.fillStyle = amb.c(WEED.thorn, 0.95);
      for (let k = 1; k <= 4; k++) {
        const q = k / 5, px = bx + (tx - bx) * q, py = -h * q, side = k % 2 ? 1 : -1;
        ctx.beginPath(); ctx.moveTo(px, py - 0.3); ctx.lineTo(px + side * 0.95, py - 0.75); ctx.lineTo(px, py + 0.3); ctx.fill();
      }
      // ragged leaves from stage 2
      if (st >= 2 && i % 2 === 0) {
        ctx.fillStyle = amb.c(WEED.leaf);
        const q = 0.45 + r() * 0.2, px = bx + (tx - bx) * q, py = -h * q, side = i % 4 ? 1 : -1;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + side * 1.6, py - 0.9); ctx.lineTo(px + side * 1.0, py - 0.2); ctx.lineTo(px + side * 1.9, py + 0.3); ctx.closePath(); ctx.fill();
      }
      // weeping sores on the stems, then swollen spore sacs
      if (st >= 2 && i % 3 === 1) {
        const q = 0.55, px = bx + (tx - bx) * q, py = -h * q;
        const pulse = st === 4 ? 0.12 * Math.sin(w.t * 2 + i) : 0;
        const rr = 0.5 + st * 0.13 + pulse;
        ctx.fillStyle = amb.c(WEED.bruise);
        ctx.beginPath(); ctx.ellipse(px, py, rr + 0.25, rr * 0.8 + 0.2, 0.3, 0, TAU); ctx.fill();
        ctx.fillStyle = amb.c(st === 4 ? WEED.spore : WEED.pus);
        ctx.beginPath(); ctx.ellipse(px, py, rr, rr * 0.75, 0.3, 0, TAU); ctx.fill();
        ctx.fillStyle = amb.c(WEED.dark, 0.85);
        for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(px + (k - 1) * rr * 0.45, py + (k % 2) * 0.2 - 0.1, 0.12, 0, TAU); ctx.fill(); }
        // a drip
        ctx.strokeStyle = amb.c(st === 4 ? WEED.spore : WEED.pus, 0.7);
        ctx.lineWidth = 0.18;
        const dl = 0.6 + 0.5 * Math.sin(w.t * 0.7 + i);
        ctx.beginPath(); ctx.moveTo(px, py + rr * 0.7); ctx.lineTo(px, py + rr * 0.7 + dl); ctx.stroke();
      }
    }
    // a sour stain on the soil
    if (st >= 2) {
      ctx.fillStyle = amb.c(WEED.dark, 0.25 + 0.08 * st);
      ctx.beginPath(); ctx.ellipse(0, 0.7, 3 + st * 2.2, 0.8, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
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
      } else if (t._stage >= 3) {
        // a sickly halo, day and night
        drawGlow(ctx, t._stage === 4 ? WEED.spore : WEED.pus, p.x, p.y - 5 * U, (6 + t._stage * 2) * U, 0.12 + w.night * 0.2);
      } else if (w.night > 0.3) {
        drawGlow(ctx, t.glow, p.x, p.y - 1.5 * U, 3 * U, w.night * 0.25);
      }
    }
  }
}

