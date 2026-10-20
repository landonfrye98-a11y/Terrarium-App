// The world: terrain, soil, populations and the slow sim that runs them.
// Live, life-logic ticks once a second (motion runs per frame). When the app
// has been closed, the same logic is replayed in coarse steps so the glass
// keeps living while you're away.
import { P } from './palette.js';
import { skyAt } from './palette.js';
import { SPECIES, FAUNA_KINDS, makeName } from './species.js';
import { Plant, sproutWeights, pickKind } from './flora.js';
import { CREATURES, Egg, Gloamwhale } from './fauna.js';
import { Particles } from './particles.js';
import { clamp, lerp, rr, chance, fbm, mulberry32, hashStr, uid, bumpUid, TAU } from './util.js';

const SOIL_N = 40;
const HR = 3600;

export class World {
  constructor(seed) {
    this.seed = seed ?? (Math.random() * 1e9) >>> 0;
    this.flora = [];
    this.fauna = [];
    this.eggs = [];
    this.items = [];
    this.visitors = [];
    this.soil = new Array(SOIL_N).fill(0.55);
    this.stats = { tasksDone: 0, births: 0, deaths: 0, discovered: {}, maxGen: {}, created: Date.now(), nextWhale: 0 };
    this.logs = [];
    this.particles = new Particles(240);
    this.t = 0;
    this.simTime = Date.now();
    this.offline = false;
    this.gust = 0;
    this._gustT = 0;
    this._lifeAcc = 0;
    this.mindPulse = null;
    this.focusPod = null;
    this.lastTouch = null;
    this.skyMode = 'real';
    this.topInset = 0;
    this.listeners = {};
    this.updateSky();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, data) { for (const fn of this.listeners[ev] || []) fn(data); }

  // ------------------------------------------------------------ layout
  layout(W, H, topInset = 0) {
    const oW = this.W, oH = this.H;
    this.W = W; this.H = H;
    this.topInset = topInset;
    this.portrait = H >= W * 1.05;
    this.U = Math.min(W, H) / 100;
    this.groundBase = H * (this.portrait ? 0.735 : 0.75);
    const R = this.portrait ? Math.min(W * 0.34, H * 0.19) : Math.min(H * 0.22, W * 0.2);
    this.clock = { cx: W / 2, cy: this.portrait ? H * 0.4 : H * 0.4, R };
    const px0 = W * (this.portrait ? 0.6 : 0.64), px1 = W * (this.portrait ? 0.93 : 0.88);
    this.pond = { x0: px0, x1: px1, cx: (px0 + px1) / 2, rx: (px1 - px0) / 2, y: this.groundBase + this.U * 1.6, depth: Math.min(H * 0.1, (H - this.groundBase) * 0.55) };
    if (oW && (oW !== W || oH !== H)) {
      const sx = W / oW, sy = H / oH;
      for (const list of [this.flora, this.fauna, this.eggs, this.items]) for (const e of list) { e.x *= sx; if (e.y != null) e.y *= sy; }
    }
  }

  groundY(x) {
    const p = this.pond;
    const base = this.groundBase + fbm(x / this.W * 2.2, this.seed % 1000, 3) * this.U * 3.2;
    if (p && x > p.x0 - 6 * this.U && x < p.x1 + 6 * this.U) {
      const d = Math.min(x - (p.x0 - 6 * this.U), (p.x1 + 6 * this.U) - x) / (6 * this.U);
      return lerp(base, p.y, clamp(d, 0, 1));
    }
    return base;
  }
  inPond(x, margin = 0) { const p = this.pond; return x > p.x0 - margin && x < p.x1 + margin; }
  pondBottom(x) {
    const p = this.pond;
    const q = clamp((x - p.cx) / p.rx, -1, 1);
    return p.y + p.depth * Math.sqrt(1 - q * q);
  }

  // ------------------------------------------------------------ soil
  soilIdx(x) { return clamp(Math.floor(x / this.W * SOIL_N), 0, SOIL_N - 1); }
  fertAt(x) { return this.soil[this.soilIdx(x)]; }
  addFert(x, a) {
    const i = this.soilIdx(x);
    this.soil[i] = clamp(this.soil[i] + a, 0, 1);
    if (i > 0) this.soil[i - 1] = clamp(this.soil[i - 1] + a * 0.4, 0, 1);
    if (i < SOIL_N - 1) this.soil[i + 1] = clamp(this.soil[i + 1] + a * 0.4, 0, 1);
  }

  // ------------------------------------------------------------ time & sky
  get date() { return new Date(this.simTime); }
  hourAt(ms) {
    if (this.skyMode === 'day') return 12.5;
    if (this.skyMode === 'night') return 0.5;
    if (this.forceHour != null) return this.forceHour;
    const d = new Date(ms);
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }
  updateSky() {
    this.hour = this.hourAt(this.simTime);
    this.sky = skyAt(this.hour);
    this.night = this.sky.night;
  }

  // ------------------------------------------------------------ queries
  count(kind) { let n = 0; for (const f of this.fauna) if (f.kind === kind) n++; return n; }
  countEggs(kind) { let n = 0; for (const e of this.eggs) if (e.species === kind) n++; return n; }
  countFlora() { const c = {}; for (const p of this.flora) c[p.kind] = (c[p.kind] || 0) + 1; return c; }
  unlocked(kind) { return this.stats.tasksDone >= (SPECIES[kind]?.unlock ?? 0); }
  cap(kind) {
    const base = SPECIES[kind].cap;
    const bonus = Math.floor(Math.max(0, this.stats.tasksDone - SPECIES[kind].unlock) / 12);
    return Math.min(base + bonus, base + 3);
  }
  room(kind) { return this.unlocked(kind) && this.count(kind) + this.countEggs(kind) < this.cap(kind); }
  floraCap() { return clamp(Math.round(this.W / 13), 18, 46); }

  nearestItem(x, range, filter) {
    let best = null, bd = range;
    for (const it of this.items) {
      if (it.gone || (filter && !filter(it))) continue;
      const d = Math.abs(it.x - x);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  // ------------------------------------------------------------ log
  log(msg, kind = 'life') {
    this.logs.push({ t: this.simTime, msg, kind });
    if (this.logs.length > 120) this.logs.splice(0, this.logs.length - 120);
    this.emit('log', { msg, kind, offline: this.offline });
  }

  // ------------------------------------------------------------ life events
  spawn(kind, o = {}) {
    const C = CREATURES[kind];
    const c = new C(o);
    if (!o.x) this.placeNew(c);
    this.fauna.push(c);
    this.discover(kind);
    return c;
  }

  placeNew(c) {
    const U = this.U;
    switch (c.kind) {
      case 'ribbonfin': c.x = rr(this.pond.x0 + 4 * U, this.pond.x1 - 4 * U); c.y = this.pond.y + this.pond.depth * 0.4; break;
      case 'bellwisp': c.x = rr(0.1, 0.9) * this.W; c.y = rr(this.H * 0.15, this.groundBase - 30 * U); break;
      case 'petalmoth': c.x = rr(0.1, 0.9) * this.W; c.y = rr(this.H * 0.3, this.groundBase - 10 * U); break;
      case 'mindbloom': c.ax = rr(0.12, 0.3); c.x = c.ax * this.W; c.y = this.H * 0.15; break;
      default: {
        let x;
        do { x = rr(0.06, 0.94) * this.W; } while (this.inPond(x, 8 * U));
        c.x = x; c.y = this.groundY(x);
      }
    }
  }

  discover(kind) {
    if (!this.stats.discovered[kind]) {
      this.stats.discovered[kind] = Date.now();
      if (this._booted) this.emit('discover', kind);
    }
  }

  birth(parent, o = {}) {
    const { genome, mutation } = parent.childGenome();
    const c = this.spawn(parent.kind, { x: parent.x, y: parent.y, ...o, genome, gen: parent.gen + 1, origin: `Child of ${parent.name}`, age: 0, energy: o.energy ?? 0.55 });
    this.stats.births++;
    this.stats.maxGen[c.kind] = Math.max(this.stats.maxGen[c.kind] || 1, c.gen);
    const sp = SPECIES[c.kind].name;
    this.log(mutation ? `${c.name} the ${sp} was born to ${parent.name} — with ${mutation}.` : `${c.name}, a ${sp}, was born to ${parent.name}.`, mutation ? 'mutation' : 'birth');
    return c;
  }

  layEgg(parent, o) {
    const { genome, mutation } = parent.childGenome();
    const e = new Egg({ species: parent.kind, genome, gen: parent.gen + 1, parentName: parent.name, mutation, ...o });
    this.eggs.push(e);
    const what = { petalmoth: 'spun a cocoon', stiltstrider: 'laid an egg', bellwisp: 'released a spore', ribbonfin: 'laid roe in the pond' }[parent.kind] || 'left an egg';
    if (parent.kind !== 'bellwisp') this.log(`${parent.name} ${what}.`, 'egg');
    return e;
  }

  hatch(e) {
    e.gone = true;
    if (!this.unlocked(e.species) || this.count(e.species) >= this.cap(e.species) + 1) return;
    const c = this.spawn(e.species, { x: e.x, y: e.y, genome: e.genome, gen: e.gen, origin: e.origin || `Child of ${e.parentName}`, energy: 0.6 });
    if (c.kind === 'ribbonfin') c.y = Math.min(c.y, this.pondBottom(c.x) - 2 * this.U);
    if (c.kind === 'petalmoth') c.y = Math.min(c.y, this.groundY(c.x) - 4 * this.U);
    this.stats.births++;
    this.stats.maxGen[c.kind] = Math.max(this.stats.maxGen[c.kind] || 1, c.gen);
    const sp = SPECIES[c.kind].name;
    this.log(e.mutation ? `${c.name} the ${sp} hatched — with ${e.mutation}.` : `${c.name} the ${sp} hatched${e.parentName ? ` (parent: ${e.parentName})` : ''}.`, e.mutation ? 'mutation' : 'birth');
    if (!this.offline) this.particles.burst(e.x, e.y, 10, { type: 'spark', color: c.genome.c1, glow: c.genome.glow, speed: 10 * this.U, life: 1.2, g: 10 });
  }

  killFauna(c, cause) {
    if (c.dead) return;
    c.dead = true;
    this.stats.deaths++;
    const sp = SPECIES[c.kind].name;
    const age = c.age / HR;
    const msg = cause === 'burst'
      ? `${c.name} the ${sp} burst into spores after ${age.toFixed(1)} hours.`
      : `${c.name} the ${sp} died of age after ${age < 30 ? age.toFixed(1) + ' hours' : (age / 24).toFixed(1) + ' days'}.`;
    this.log(msg, 'death');
    if (c.kind !== 'bellwisp' && c.kind !== 'mindbloom') {
      const x = c.kind === 'ribbonfin' ? clamp(c.x, this.pond.x0, this.pond.x1) : c.x;
      this.dropItem('husk', x, Math.min(c.y, this.groundY(x)) - 2 * this.U, c.genome.c1, c.kind === 'stiltstrider' ? 2 : 1);
    }
    this.emit('death', c);
  }

  onPlantDeath(p) {
    this.addFert(p.x, 0.15);
    if (p.kind !== 'grass') this.dropItem('husk', p.x, this.groundY(p.x) - this.U, P.ochre, 0.6);
  }

  dropItem(type, x, y, color, food = 1) {
    if (this.items.length > 40) return;
    this.items.push({ id: uid(), type, x, y, vy: 0, color, food, age: 0, grounded: false, inWater: false });
  }
  consumeItem(it) { it.gone = true; }

  pollinate(moth) {
    let best = null, bd = 60 * this.U;
    for (const p of this.flora) {
      if (p.kind !== 'bulbstalk' || p.growth < 0.7) continue;
      const d = Math.abs(p.x - moth.x);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) {
      best.pollen = Math.min(2, best.pollen + 0.6);
      if (!this.offline) {
        const tp = best.tip(this);
        for (let i = 0; i < 6; i++) this.particles.emit({ type: 'mote', x: moth.x, y: moth.y, vx: (tp.x - moth.x) * rr(0.3, 0.6), vy: (tp.y - moth.y) * rr(0.3, 0.6), drag: 0.8, life: 2, size: 1.4, color: P.glowAmber, wob: 6 });
      }
    }
  }

  trySporeFromPuffcap(p) {
    if (!this.room('bellwisp')) return;
    const g = CREATURES.bellwisp.randomGenome(Math.random);
    const e = new Egg({ species: 'bellwisp', genome: g, gen: 1, origin: 'Rose from a puffcap', x: p.x, y: this.groundY(p.x) - p.height * this.U - 3 * this.U, hatch: rr(20, 40) * 60, float: true });
    this.eggs.push(e);
  }

  splash(x, y, k = 1) {
    if (this.offline) return;
    const U = this.U;
    for (let i = 0; i < 10 * k; i++) this.particles.emit({ type: 'drop', x: x + rr(-1, 1) * U, y, vx: rr(-8, 8) * U * 0.5, vy: -rr(6, 16) * U * k, g: 40 * U, drag: 0.2, life: 1.2, size: rr(1.2, 2.4), color: P.mint });
    this.particles.emit({ type: 'ring', x, y, size: U, grow: 8 * U, life: 1, color: P.cream });
    this.ripples.push({ x, t: 0 });
  }

  // ------------------------------------------------------------ genesis
  genesis() {
    const W = this.W, U = this.U;
    const r = mulberry32(this.seed);
    const plant = (kind, x, growth) => {
      if (this.inPond(x, 3 * U)) return;
      const p = new Plant({ kind, x, growth, age: rr(0, 10) * HR });
      if (kind === 'bulbstalk') p.ripe = r();
      this.flora.push(p);
    };
    const kinds = ['fanfern', 'bulbstalk', 'lanternlily', 'fanfern', 'grass', 'puffcap', 'lanternlily', 'bulbstalk', 'grass', 'fanfern', 'grass', 'grass', 'bulbstalk', 'lanternlily', 'grass', 'puffcap', 'fanfern', 'grass'];
    kinds.forEach((k, i) => plant(k, (i + 0.5 + (r() - 0.5) * 0.8) / kinds.length * W, 0.6 + r() * 0.4));
    for (let i = 0; i < 3; i++) this.spawn('scuttler', { age: rr(1, 4) * HR, origin: 'First settler' });
    for (let i = 0; i < 3; i++) this.spawn('petalmoth', { age: rr(0.6, 2) * HR, origin: 'First settler' });
    this.stats.created = Date.now();
    this.log('A new terrarium was sealed. Three scuttlers and three petalmoths were the first to stir.', 'milestone');
  }

  // ------------------------------------------------------------ the sim
  ripples = [];

  update(dt) {
    this.t += dt;
    this.simTime = Date.now();
    // breathing gusts of air inside the glass
    this._gustT -= dt;
    if (this._gustT <= 0) { this._gustT = rr(20, 70); this._gustTarget = Math.random() < 0.4 ? rr(-1, 1) : 0; }
    this.gust = lerp(this.gust, this._gustTarget || 0, dt * 0.3);
    if (this.mindPulse) { this.mindPulse.age += dt; if (this.mindPulse.age > 10) this.mindPulse = null; }

    this.weather(dt);
    this._lifeAcc += dt;
    if (this._lifeAcc >= 1) { this.tick(this._lifeAcc); this._lifeAcc = 0; }

    for (const c of this.fauna) c.move(this, dt);
    for (const e of this.eggs) e.move(this, dt);
    this.moveItems(dt);
    for (const v of this.visitors) v.update(this, dt);
    for (const r of this.ripples) r.t += dt;
    if (this.ripples.length && this.ripples[0].t > 3) this.ripples.shift();
    this.particles.update(dt, this.t);
  }

  // Every so often a slow drift of spores falls through the glass. It costs
  // a handful of particles a second and quietly feeds the soil and the pond.
  weather(dt) {
    if (this.offline) return;
    if (this._driftAt == null) this._driftAt = this.t + rr(8, 25) * 60;
    if (this.t > this._driftAt && !this.drift) {
      this.drift = { until: this.t + rr(120, 240), col: [P.glowLime, P.glowAmber, P.glowPink, P.glowCyan][Math.floor(Math.random() * 4)] };
      this.log('A spore drift is falling through the glass.', 'visitor');
    }
    const d = this.drift;
    if (!d) return;
    if (this.t > d.until) { this.drift = null; this._driftAt = this.t + rr(35, 90) * 60; for (let i = 0; i < 6; i++) this.addFert(rr(0, this.W), 0.04); return; }
    const fade = Math.min(1, (d.until - this.t) / 20);
    if (Math.random() < dt * 5 * fade) {
      this.particles.emit({ type: 'mote', x: rr(0, this.W), y: -4, vx: rr(-4, 4) * this.U * 0.3, vy: rr(5, 9) * this.U * 0.4, drag: 0, wob: 10, life: rr(14, 22), size: rr(1.4, 2.6), color: P.cream, glow: d.col });
    }
  }

  moveItems(dt) {
    const U = this.U;
    for (const it of this.items) {
      if (it.grounded) continue;
      it.vy += 30 * U * dt;
      it.y += it.vy * dt;
      if (this.inPond(it.x)) {
        if (it.y > this.pond.y) { it.inWater = true; it.vy = Math.min(it.vy, 2 * U); }
        const bot = this.pondBottom(it.x) - U;
        if (it.y >= bot) { it.y = bot; it.grounded = true; }
        if (it.inWater && !it._splashed) { it._splashed = true; this.splash(it.x, this.pond.y, 0.4); }
      } else {
        const gy = this.groundY(it.x) - U * 0.8;
        if (it.y >= gy) {
          it.y = gy; it.grounded = true;
          if (!this.offline && it.vy > 10 * U) this.particles.burst(it.x, gy, 4, { type: 'spark', color: it.color, speed: 6 * U, life: 0.6, g: 30 * U });
        }
      }
    }
  }

  tick(dt) {
    this.updateSky();
    for (const p of this.flora) p.tick(this, dt);
    for (const c of this.fauna) if (!c.dead) c.lifeTick(this, dt);
    for (const e of this.eggs) if (!e.gone) e.tick(this, dt);
    for (const it of this.items) {
      it.age += dt;
      if (this.offline && !it.grounded) { it.grounded = true; it.y = this.inPond(it.x) ? this.pondBottom(it.x) - this.U : this.groundY(it.x) - this.U * 0.8; it.inWater = this.inPond(it.x); }
      const rot = it.inWater ? 1.5 * HR : 4 * HR;
      if (it.age > rot) { it.gone = true; this.addFert(it.x, 0.18 * it.food); }
    }
    this.flora = this.flora.filter((p) => !p.dead);
    this.fauna = this.fauna.filter((c) => !c.dead);
    this.eggs = this.eggs.filter((e) => !e.gone);
    this.items = this.items.filter((i) => !i.gone);
    this.visitors = this.visitors.filter((v) => !v.done);

    // soil slowly relaxes toward a middling fertility
    for (let i = 0; i < SOIL_N; i++) this.soil[i] += (0.45 - this.soil[i]) * dt / (10 * HR);

    this.sprout(dt);
    this.immigrate(dt);
    this.scheduleVisitors(dt);
  }

  sprout(dt) {
    const cap = this.floraCap();
    const n = this.flora.length;
    if (n >= cap) return;
    let avg = 0; for (const s of this.soil) avg += s; avg /= SOIL_N;
    const rate = (0.6 + avg) * (1 - n / cap) / 900 * (n < cap * 0.5 ? 3 : 1);
    if (!chance(rate, dt)) return;
    // sample a few spots, prefer fertile and uncrowded
    let best = null, bs = -1;
    for (let k = 0; k < 6; k++) {
      const x = rr(0.03, 0.97) * this.W;
      if (this.inPond(x, 3 * this.U)) continue;
      let crowd = 0;
      for (const p of this.flora) { const d = Math.abs(p.x - x) / this.U; if (d < 6) crowd += (6 - d); }
      const s = this.fertAt(x) - crowd * 0.05;
      if (s > bs) { bs = s; best = x; }
    }
    if (best == null) return;
    const kind = pickKind(sproutWeights(this));
    this.flora.push(new Plant({ kind, x: best }));
    this.addFert(best, -0.04);
    if (kind === 'coilspire' || kind === 'tubebloom') this.discover(kind);
  }

  immigrate(dt) {
    for (const kind of FAUNA_KINDS) {
      if (!this.unlocked(kind)) continue;
      if (this.count(kind) + this.countEggs(kind) > 0) continue;
      if (!chance(1 / (kind === 'mindbloom' ? 3 * HR : 40 * 60), dt)) continue;
      const c = this.spawn(kind, { age: CREATURES[kind].mature * rr(1, 2) });
      this.log(`A lone ${SPECIES[kind].name.toLowerCase()} named ${c.name} found its way in from the flats.`, 'arrival');
    }
  }

  scheduleVisitors(dt) {
    if (this.offline || !this.unlocked('gloamwhale')) return;
    if (!this.stats.nextWhale) this.stats.nextWhale = this.simTime + rr(4, 12) * 60000;
    if (this.simTime > this.stats.nextWhale && !this.visitors.length) {
      this.stats.nextWhale = this.simTime + rr(35, 80) * 60000;
      this.visitors.push(new Gloamwhale(this));
      this.discover('gloamwhale');
      this.log('A gloamwhale drifted across the far sky.', 'visitor');
    }
  }

  // Replay the sim while the app was closed. Coarse steps, no motion.
  catchUp(seconds) {
    seconds = Math.min(seconds, 4 * 24 * HR);
    if (seconds < 5) return null;
    const before = { births: this.stats.births, deaths: this.stats.deaths, logs: this.logs.length };
    this.offline = true;
    const end = Date.now();
    let t = end - seconds * 1000;
    const step = seconds > 12 * HR ? 60 : 20;
    while (t < end) {
      const dt = Math.min(step, (end - t) / 1000);
      t += dt * 1000;
      this.simTime = t;
      this.tick(dt);
    }
    this.offline = false;
    this.simTime = Date.now();
    this.updateSky();
    // drop anything now outside its valid region
    for (const c of this.fauna) if (c.kind === 'scuttler' || c.kind === 'stiltstrider') { if (this.inPond(c.x, 4 * this.U)) c.x = this.pond.x0 - 8 * this.U; c.state = 'idle'; c.timer = 0; c.y = this.groundY(c.x); }
    return { seconds, births: this.stats.births - before.births, deaths: this.stats.deaths - before.deaths };
  }

  // ------------------------------------------------------------ hit testing
  pick(x, y) {
    for (let i = this.fauna.length - 1; i >= 0; i--) if (this.fauna[i].hit(this, x, y)) return { type: 'fauna', obj: this.fauna[i] };
    for (const e of this.eggs) if (e.hit(this, x, y)) return { type: 'egg', obj: e };
    for (let i = this.flora.length - 1; i >= 0; i--) if (this.flora[i].kind !== 'grass' && this.flora[i].hit(this, x, y)) return { type: 'flora', obj: this.flora[i] };
    return null;
  }
  find(id) { return this.fauna.find((c) => c.id === id) || this.flora.find((p) => p.id === id) || this.eggs.find((e) => e.id === id); }

  // ------------------------------------------------------------ task rewards
  // A finished task becomes a creature. The task's words seed its genome,
  // so the same words always grow the same colours.
  bloomTask(task, x, y) {
    this.stats.tasksDone++;
    const done = this.stats.tasksDone;
    const newly = Object.keys(SPECIES).filter((k) => SPECIES[k].unlock === done);
    const pool = FAUNA_KINDS.filter((k) => this.unlocked(k) && k !== 'mindbloom');
    // favour newly unlocked species, then the least populated relative to cap
    let kind = newly.find((k) => CREATURES[k] && k !== 'mindbloom');
    if (newly.includes('mindbloom')) kind = 'mindbloom';
    if (!kind) {
      let best = null, bs = -Infinity;
      for (const k of pool) {
        const room = this.cap(k) - this.count(k) - this.countEggs(k);
        const s = room / this.cap(k) + Math.random() * 0.35;
        if (room > 0 && s > bs) { bs = s; best = k; }
      }
      kind = best;
    }
    this.addFert(x, 0.35);
    let creature = null;
    if (kind) {
      const r = mulberry32(hashStr(task.title.toLowerCase().trim() + kind));
      const genome = CREATURES[kind].randomGenome(r);
      const o = { genome, origin: `Bloomed from “${task.title}”`, name: makeName(r), energy: 0.85, age: CREATURES[kind].mature * 0.25 };
      creature = this.spawn(kind, o);
      if (kind === 'scuttler' || kind === 'stiltstrider') { creature.x = x; creature.y = this.groundY(x); if (this.inPond(x, 5 * this.U)) this.placeNew(creature); }
      else if (kind === 'petalmoth' || kind === 'bellwisp') { creature.x = x; creature.y = y - 8 * this.U; }
      this.stats.births++;
      this.log(`“${task.title}” was finished and bloomed into ${creature.name}, a ${SPECIES[kind].name}.`, 'task');
    } else {
      // everything is at capacity: the soil takes the gift instead
      for (let i = 0; i < 3; i++) this.flora.push(new Plant({ kind: pickKind(sproutWeights(this)), x: clamp(x + rr(-12, 12) * this.U, 0, this.W) }));
      this.log(`“${task.title}” was finished. The terrarium is full, so it fed the soil and three sprouts appeared.`, 'task');
    }
    for (const k of newly) {
      this.discover(k);
      this.log(`Something new has arrived: the ${SPECIES[k].name}.`, 'milestone');
      this.emit('unlock', k);
    }
    return { creature, newly };
  }

  // ------------------------------------------------------------ persistence
  serialize() {
    return {
      seed: this.seed,
      W: this.W, H: this.H,
      flora: this.flora.map((p) => p.serialize(this)),
      fauna: this.fauna.map((c) => c.serialize(this)),
      eggs: this.eggs.map((e) => e.serialize(this)),
      items: this.items.map((i) => ({ ...i, x: i.x / this.W, y: i.y / this.H })),
      soil: this.soil.map((v) => Math.round(v * 1000) / 1000),
      stats: this.stats,
      logs: this.logs.slice(-120),
    };
  }

  restore(d) {
    this.seed = d.seed;
    const W = this.W, H = this.H;
    this.flora = d.flora.map((o) => { bumpUid(o.id); return new Plant({ ...o, x: o.x * W }); });
    this.fauna = d.fauna.filter((o) => CREATURES[o.kind]).map((o) => {
      bumpUid(o.id);
      const c = new CREATURES[o.kind]({ ...o, x: o.x * W, y: o.y * H, state: o.kind === 'petalmoth' ? 'fly' : 'idle', timer: 0 });
      return c;
    });
    this.eggs = (d.eggs || []).map((o) => new Egg({ ...o, x: o.x * W, y: o.y * H }));
    this.items = (d.items || []).map((i) => ({ ...i, x: i.x * W, y: i.y * H }));
    if (d.soil?.length === SOIL_N) this.soil = d.soil;
    this.stats = { ...this.stats, ...d.stats };
    this.logs = d.logs || [];
    // ground things follow the (possibly different) terrain
    for (const c of this.fauna) if (c.kind === 'scuttler' || c.kind === 'stiltstrider') c.y = this.groundY(c.x);
  }
}

