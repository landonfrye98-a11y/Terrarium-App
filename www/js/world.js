// The world: terrain, soil, populations and the slow sim that runs them.
//
// Every ecological outcome (births, hunts, infection, rot) is decided in
// tick(), once a second live and in coarse steps while the app was closed,
// with the same rules both ways. Per-frame code only animates outcomes that
// were already decided.
//
// Nutrient is conserved: it moves between soil, plants, animals, eggs,
// carcasses and seed banks but is never created, except through inject()
// (finished tasks, arrivals), which the ledger records in stats.nIn.
import { P, skyAt, nightAt } from './palette.js';
import { SPECIES, FAUNA_KINDS, PREDATORS, ECO, TRAITS, makeName } from './species.js';
import { Plant, sproutWeights, pickKind, FLORA_KINDS } from './flora.js';
import { CREATURES, Egg, Gloamwhale } from './fauna.js';
import { Particles } from './particles.js';
import { clamp, lerp, rr, chance, fbm, mulberry32, hashStr, uid, bumpUid, hexToRgb } from './util.js';

const SOIL_N = 40;
const NB = 16; // spatial buckets across the glass
const HR = 3600;
const SAVE_V = 2;
const MAX_FAUNA = 36; // drawing budget for the whole glass
const ORDER_COOLDOWN = 20 * 60 * 1000; // between hunts you command
const LINEAGE_MAX = 320; // family records kept
const LINEAGE_DEPTH = 8; // generations of ancestry kept behind the living
const LINEAGE_FADE = 36 * HR * 1000; // how long a dead branch lingers
const RESIST = { stiltstrider: 0.2, hookjaw: 0.2, mireeel: 0.3, lancewing: 0.3 };
const LAYER = { scuttler: 0, stiltstrider: 0, hookjaw: 0, petalmoth: 1, bellwisp: 1, lancewing: 1, mindbloom: 1, ribbonfin: 2, mireeel: 2 };

export class World {
  constructor(seed) {
    this.seed = seed ?? (Math.random() * 1e9) >>> 0;
    this.flora = [];
    this.fauna = [];
    this.eggs = [];
    this.items = [];
    this.visitors = [];
    this.ripples = [];
    this.soil = new Float64Array(SOIL_N).fill(0.55);
    this.bank = {};
    this.lineage = {};
    this.stats = { tasksDone: 0, births: 0, deaths: 0, discovered: {}, maxGen: {}, created: Date.now(), nextWhale: 0, n0: 0, nIn: 0, goneAt: {}, pendingArrivals: [], nextArrival: 0 };
    this.logs = [];
    this.particles = new Particles(240);
    this.t = 0;
    this.simTime = Date.now();
    this.clockFn = null; // harness hook: replaces Date.now()
    this.offline = false;
    this.gust = 0;
    this._gustT = 0;
    this._lifeAcc = 0;
    this._tickN = 0;
    this.mindPulse = null;
    this.focusPod = null;
    this.lastTouch = null;
    this.skyMode = 'real';
    this.topInset = 0;
    this.listeners = {};
    this.pop = {};
    this.eggPop = {};
    this.bk = Array.from({ length: NB }, () => []);
    this.mush = new Float32Array(NB);
    this.blight = new Float32Array(NB); // weeds of neglected tasks, set by the task garden
    this.act = { births: 0, deaths: 0, pollinations: 0, hunts: 0, kills: 0, pulses: 0, splashes: 0, hatches: 0 };
    this.hunting = 0;
    this.traps = [];
    this.fx = []; // short-lived kill animations (live only)
    this.updateSky();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, data) { for (const fn of this.listeners[ev] || []) fn(data); }
  now() { return this.clockFn ? this.clockFn() : Date.now(); }

  // ------------------------------------------------------------ layout
  layout(W, H, topInset = 0) {
    const oW = this.W, oH = this.H;
    this.W = W; this.H = H;
    this.topInset = topInset;
    this.portrait = H >= W * 1.05;
    this.U = Math.min(W, H) / 100;
    this.groundBase = H * (this.portrait ? 0.735 : 0.75);
    const R = this.portrait ? Math.min(W * 0.34, H * 0.19) : Math.min(H * 0.22, W * 0.2);
    this.clock = { cx: W / 2, cy: H * 0.4, R };
    const px0 = W * (this.portrait ? 0.6 : 0.64), px1 = W * (this.portrait ? 0.93 : 0.88);
    this.pond = { x0: px0, x1: px1, cx: (px0 + px1) / 2, rx: (px1 - px0) / 2, y: this.groundBase + this.U * 1.6, depth: Math.min(H * 0.1, (H - this.groundBase) * 0.55) };
    // ground height, sampled once per pixel: groundY is read dozens of times a frame
    const n = Math.ceil(W) + 2;
    this.hm = new Float32Array(n);
    for (let x = 0; x < n; x++) this.hm[x] = this.groundAt(x);
    if (oW && (oW !== W || oH !== H)) {
      const sx = W / oW, sy = H / oH;
      for (const list of [this.flora, this.fauna, this.eggs, this.items]) for (const e of list) { e.x *= sx; if (e.y != null) e.y *= sy; }
    }
  }

  groundAt(x) {
    const p = this.pond;
    const base = this.groundBase + fbm(x / this.W * 2.2, this.seed % 1000, 3) * this.U * 3.2;
    if (p && x > p.x0 - 6 * this.U && x < p.x1 + 6 * this.U) {
      const d = Math.min(x - (p.x0 - 6 * this.U), (p.x1 + 6 * this.U) - x) / (6 * this.U);
      return lerp(base, p.y, clamp(d, 0, 1));
    }
    return base;
  }
  groundY(x) {
    const hm = this.hm;
    if (!(x > 0)) return hm[0];
    const i = x | 0;
    if (i >= hm.length - 1) return hm[hm.length - 1];
    return hm[i] + (hm[i + 1] - hm[i]) * (x - i);
  }
  inPond(x, margin = 0) { const p = this.pond; return x > p.x0 - margin && x < p.x1 + margin; }
  pondBottom(x) {
    const p = this.pond;
    const q = clamp((x - p.cx) / p.rx, -1, 1);
    return p.y + p.depth * Math.sqrt(1 - q * q);
  }
  bucketOf(x) { return clamp((x * NB / this.W) | 0, 0, NB - 1); }

  // ------------------------------------------------------------ nutrient
  soilIdx(x) { return clamp(Math.floor(x / this.W * SOIL_N), 0, SOIL_N - 1); }
  fertAt(x) { return Math.min(1.5, this.soil[this.soilIdx(x)]); }
  depositN(x, a) {
    if (!(a > 0)) return;
    const i = this.soilIdx(x), s = this.soil;
    const l = i > 0, r = i < SOIL_N - 1;
    s[i] += a * (0.6 + (l ? 0 : 0.2) + (r ? 0 : 0.2));
    if (l) s[i - 1] += a * 0.2;
    if (r) s[i + 1] += a * 0.2;
  }
  takeN(x, want) {
    if (!(want > 0)) return 0;
    const i = this.soilIdx(x), s = this.soil;
    let got = Math.min(want, s[i]);
    s[i] -= got;
    for (const j of [i - 1, i + 1]) {
      if (got >= want || j < 0 || j >= SOIL_N) continue;
      const g = Math.min(want - got, s[j] * 0.5);
      s[j] -= g; got += g;
    }
    return got;
  }
  // the pond's water draws on the soil cells under it
  takePondN(want) {
    const p = this.pond;
    return this.takeN(p.x0 + Math.random() * (p.x1 - p.x0), want);
  }
  // external input (finished tasks, arrivals): the only way new nutrient enters
  inject(x, a) {
    if (!(a > 0)) return;
    this.depositN(x, a);
    this.stats.nIn += a;
  }
  addFert(x, a) { if (a > 0) this.inject(x, a); else this.takeN(x, -a); }
  nStruct(kind, g) { return ECO.nBody[kind] * (g?.size || 1); }
  totalN() {
    let n = 0;
    for (const v of this.soil) n += v;
    for (const p of this.flora) n += (p.n || 0) + (p.store || 0);
    for (const c of this.fauna) n += c.n || 0;
    for (const e of this.eggs) n += e.n || 0;
    for (const i of this.items) n += i.n || 0;
    for (const k in this.bank) n += this.bank[k].n;
    return n;
  }

  // ------------------------------------------------------------ time & sky
  hourAt(ms) {
    // fixed skies, each at the peak of its colours
    if (this.skyMode === 'dawn') return 5.95;
    if (this.skyMode === 'day') return 12.5;
    if (this.skyMode === 'dusk') return 18.65;
    if (this.skyMode === 'night') return 0.5;
    if (this.forceHour != null) return this.forceHour;
    const d = new Date(ms);
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }
  updateSky() {
    this.hour = this.hourAt(this.simTime);
    if (this.offline) { this.night = nightAt(this.hour); return; }
    this.sky = skyAt(this.hour);
    this.night = this.sky.night;
  }

  // ------------------------------------------------------------ census
  // Rebuilt once per tick; spawn/kill/lay/hatch keep it exact in between.
  rebuildIndex() {
    const pop = this.pop, ep = this.eggPop;
    for (const k of FAUNA_KINDS) { pop[k] = 0; ep[k] = 0; }
    for (const b of this.bk) b.length = 0;
    for (const c of this.fauna) { pop[c.kind]++; this.bk[this.bucketOf(c.x)].push(c); }
    for (const e of this.eggs) ep[e.species]++;
    this.mush.fill(0);
    this.traps.length = 0;
    for (const p of this.flora) {
      if (p.kind === 'gloomcap') this.mush[this.bucketOf(p.x)] += 1 - p.wither;
      else if (p.kind === 'snaplure' || p.kind === 'dewveil') this.traps.push(p);
    }
    this._sortDirty = true;
  }
  count(kind) { return this.pop[kind] || 0; }
  countEggs(kind) { return this.eggPop[kind] || 0; }
  countFlora() { const c = {}; for (const p of this.flora) c[p.kind] = (c[p.kind] || 0) + 1; return c; }
  unlocked(kind) { return this.stats.tasksDone >= (SPECIES[kind]?.unlock ?? 0); }
  ceil(kind) { return SPECIES[kind].cap; }
  cap(kind) { return this.ceil(kind); }
  room(kind) { return this.unlocked(kind) && this.count(kind) + this.countEggs(kind) < this.ceil(kind); }
  floraCap() { return clamp(Math.round(this.W / 13), 18, 46); }

  // Breeding is limited by food (nutrient for a child's body) and gets
  // steeply harder only as a species nears the performance ceiling.
  canBreed(c) {
    if (!c.adult || c.inf || c.energy < 0.7 || !this.unlocked(c.kind)) return false;
    if (c.n < 2 * this.nStruct(c.kind, c.genome)) return false;
    if (this.fauna.length + this.eggs.length >= MAX_FAUNA) return false;
    const crowd = (this.count(c.kind) + this.countEggs(c.kind)) / this.ceil(c.kind);
    if (crowd >= 1) return false;
    return Math.random() < (1 - crowd ** 4 + (c.genome.gl || 0) * 0.1) * (0.55 + 0.9 * (c.genome.fec ?? 0.5));
  }

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
    if (this.logs.length > 140) this.logs.splice(0, this.logs.length - 140);
    this.emit('log', { msg, kind, offline: this.offline });
  }

  // ------------------------------------------------------------ life events
  spawn(kind, o = {}) {
    const C = CREATURES[kind];
    const c = new C(o);
    if (!o.x) this.placeNew(c);
    if (c.n == null) c.n = this.nStruct(kind, c.genome);
    this.fauna.push(c);
    this.pop[kind] = (this.pop[kind] || 0) + 1;
    this._sortDirty = true;
    this.discover(kind);
    this.record(c);
    return c;
  }

  placeNew(c) {
    const U = this.U;
    switch (c.kind) {
      case 'ribbonfin': case 'mireeel': c.x = rr(this.pond.x0 + 4 * U, this.pond.x1 - 4 * U); c.y = this.pond.y + this.pond.depth * 0.5; break;
      case 'bellwisp': c.x = rr(0.1, 0.9) * this.W; c.y = rr(this.H * 0.15, this.groundBase - 30 * U); break;
      case 'petalmoth': c.x = rr(0.1, 0.9) * this.W; c.y = rr(this.H * 0.3, this.groundBase - 10 * U); break;
      case 'lancewing': c.x = rr(0.1, 0.9) * this.W; c.y = rr(this.H * 0.12, this.H * 0.3); break;
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

  // live birth (scuttlers split, predators bear young): the parent pays for the body
  birth(parent, o = {}) {
    const { genome, mutation } = parent.childGenome();
    const nb = Math.min(parent.n * 0.5, this.nStruct(parent.kind, genome));
    parent.n -= nb;
    const c = this.spawn(parent.kind, { x: parent.x, y: parent.y, ...o, genome, n: nb, gen: parent.gen + 1, pid: parent.id, origin: `Child of ${parent.name}`, age: 0, energy: o.energy ?? 0.55 });
    this.stats.births++;
    this.act.births++;
    this.stats.maxGen[c.kind] = Math.max(this.stats.maxGen[c.kind] || 1, c.gen);
    const sp = SPECIES[c.kind].name;
    this.log(mutation ? `${c.name} the ${sp} was born to ${parent.name}, with ${mutation}.` : `${c.name}, a ${sp}, was born to ${parent.name}.`, mutation ? 'mutation' : 'birth');
    return c;
  }

  layEgg(parent, o) {
    const { genome, mutation } = parent.childGenome();
    const nb = Math.min(parent.n * 0.5, this.nStruct(parent.kind, genome));
    parent.n -= nb;
    const e = new Egg({ species: parent.kind, genome, gen: parent.gen + 1, parentName: parent.name, pid: parent.id, mutation, n: nb, ...o });
    // a share of every clutch goes dormant in the soil: the seed bank
    if (Math.random() < 0.12) { this.bankAdd(parent.kind, genome, nb); return null; }
    this.eggs.push(e);
    this.eggPop[parent.kind] = (this.eggPop[parent.kind] || 0) + 1;
    const what = { petalmoth: 'spun a cocoon', stiltstrider: 'laid an egg', bellwisp: 'released a spore', ribbonfin: 'laid roe in the pond' }[parent.kind] || 'left an egg';
    if (parent.kind !== 'bellwisp') this.log(`${parent.name} ${what}.`, 'egg');
    return e;
  }

  hatch(e) {
    if (e.gone) return;
    e.gone = true;
    this._dirty = true;
    this.eggPop[e.species] = Math.max(0, (this.eggPop[e.species] || 1) - 1);
    if (!this.unlocked(e.species) || this.count(e.species) >= this.ceil(e.species) || this.fauna.length >= MAX_FAUNA) {
      this.bankAdd(e.species, e.genome, e.n || 0);
      return;
    }
    const c = this.spawn(e.species, { x: e.x, y: e.y, genome: e.genome, n: e.n || 0, gen: e.gen, pid: e.pid ?? null, origin: e.origin || `Child of ${e.parentName}`, energy: 0.6 });
    if (c.kind === 'ribbonfin') c.y = Math.min(c.y, this.pondBottom(c.x) - 2 * this.U);
    if (c.kind === 'petalmoth') c.y = Math.min(c.y, this.groundY(c.x) - 4 * this.U);
    this.stats.births++;
    this.act.hatches++;
    this.stats.maxGen[c.kind] = Math.max(this.stats.maxGen[c.kind] || 1, c.gen);
    const sp = SPECIES[c.kind].name;
    this.log(e.mutation ? `${c.name} the ${sp} hatched, with ${e.mutation}.` : `${c.name} the ${sp} hatched${e.parentName ? ` (parent: ${e.parentName})` : ''}.`, e.mutation ? 'mutation' : 'birth');
    if (!this.offline) this.particles.burst(e.x, e.y, 10, { type: 'spark', color: c.genome.c1, glow: c.genome.glow, speed: 10 * this.U, life: 1.2, g: 10 });
  }

  // eggs eaten by predators
  eatEgg(e, eater) {
    if (e.gone) return;
    e.gone = true;
    this._dirty = true;
    this.eggPop[e.species] = Math.max(0, (this.eggPop[e.species] || 1) - 1);
    this.feed(eater, e.n || 0, e.x);
    eater.energy = Math.min(1, eater.energy + 0.35);
  }

  // eater keeps the assimilated share of nutrient, the rest goes to the soil
  feed(eater, n, x) {
    const keep = n * ECO.assim;
    eater.n = (eater.n || 0) + keep;
    this.depositN(x, n - keep);
  }

  killFauna(c, cause) {
    if (c.dead) return;
    c.dead = true;
    c.cause = cause;
    this._dirty = true;
    const rec = this.lineage[c.id];
    if (rec) { rec.d = this.simTime; rec.cause = cause; }
    this.pop[c.kind] = Math.max(0, (this.pop[c.kind] || 1) - 1);
    if (this.pop[c.kind] === 0 && this.countEggs(c.kind) === 0) this.stats.goneAt[c.kind] = this.simTime;
    if (c.hunt) this.endHunt(c);
    this.stats.deaths++;
    this.act.deaths++;
    const sp = SPECIES[c.kind].name;
    const age = c.age / HR;
    const ageStr = age < 30 ? age.toFixed(1) + ' hours' : (age / 24).toFixed(1) + ' days';
    let n = c.n || 0;
    c.n = 0;
    if (cause === 'eaten') { this.emit('death', c); return; } // predate() moved the nutrient
    // a dormant spore of every adult goes into the seed bank
    if (c.adult && cause !== 'fungus' && Math.random() < (PREDATORS.includes(c.kind) ? 0.8 : 0.3) && n > 0) {
      const share = n * 0.3;
      this.bankAdd(c.kind, c.genome, share);
      n -= share;
    }
    const gx = clamp(c.x, 2 * this.U, this.W - 2 * this.U);
    if (cause === 'burst') {
      this.log(`${c.name} the ${sp} burst into spores after ${age.toFixed(1)} hours.`, 'death');
      this.depositN(gx, n);
    } else if (cause === 'fungus') {
      this.log(`${c.name} the ${sp} was taken by the gloomcap fungus. Pale stalks are rising from the body.`, 'death');
      const x = this.inPond(gx, 2 * this.U) ? this.pond.x0 - 4 * this.U : gx;
      const p = new Plant({ kind: 'gloomcap', x, growth: 0.1, n: Math.max(0, n - 0.01) });
      this.depositN(x, Math.min(n, 0.01));
      this.flora.push(p);
      this.discover('gloomcap');
    } else if (cause === 'starved') {
      this.log(`${c.name} the ${sp} starved.`, 'death');
      this.dropCarcass(c, gx, n);
    } else {
      this.log(`${c.name} the ${sp} died of age after ${ageStr}.`, 'death');
      this.dropCarcass(c, gx, n);
    }
    this.emit('death', c);
  }

  dropCarcass(c, x, n) {
    if (c.kind === 'mindbloom' || c.kind === 'bellwisp') { this.depositN(x, n); return; }
    const wx = c.kind === 'ribbonfin' || c.kind === 'mireeel' ? clamp(c.x, this.pond.x0, this.pond.x1) : x;
    const y = Math.min(c.y, this.groundY(wx)) - 2 * this.U;
    this.dropItem('husk', wx, y, c.genome.c1, n);
  }

  onPlantDeath(p) {
    const n = (p.n || 0) + (p.store || 0);
    p.n = 0; p.store = 0;
    if (p.kind === 'grass' || p.kind === 'gloomcap' || p.kind === 'dewveil') { this.depositN(p.x, n); return; }
    this.depositN(p.x, n * 0.4);
    this.dropItem('husk', p.x, this.groundY(p.x) - this.U, P.ochre, n * 0.6);
  }

  // food items carry their nutrient; over the item limit it goes straight to soil
  dropItem(type, x, y, color, n) {
    if (this.items.length >= 40) { this.depositN(x, n); return; }
    this.items.push({ id: uid(), type, x, y, vy: 0, color, n, food: type === 'fruit' ? 1 : 0.8, age: 0, grounded: false, inWater: false });
  }
  consumeItem(it, eater) {
    if (it.gone) return;
    it.gone = true;
    this._dirty = true;
    if (eater) this.feed(eater, it.n || 0, it.x);
    else this.depositN(it.x, it.n || 0);
    it.n = 0;
  }

  pollinate(moth) {
    let best = null, bd = 60 * this.U;
    for (const p of this.flora) {
      if (p.kind !== 'bulbstalk' || p.growth < 0.7) continue;
      const d = Math.abs(p.x - moth.x);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    best.pollen = Math.min(2, best.pollen + 0.6);
    this.act.pollinations++;
    if (!this.offline) {
      const tp = best.tip(this);
      for (let i = 0; i < 6; i++) this.particles.emit({ type: 'mote', x: moth.x, y: moth.y, vx: (tp.x - moth.x) * rr(0.3, 0.6), vy: (tp.y - moth.y) * rr(0.3, 0.6), drag: 0.8, life: 2, size: 1.4, color: P.glowAmber, wob: 6 });
    }
  }

  // puffcaps release bellwisp spores, but only from the bellwisp seed bank
  trySporeFromPuffcap(p) {
    const b = this.bank.bellwisp;
    if (!b || b.count < 1 || !this.room('bellwisp')) return;
    const { genome, n } = this.bankTake('bellwisp');
    const e = new Egg({ species: 'bellwisp', genome, n, gen: 1, origin: 'Rose from a puffcap', x: p.x, y: this.groundY(p.x) - p.height * this.U - 3 * this.U, hatch: rr(20, 40) * 60, float: true });
    this.eggs.push(e);
    this.eggPop.bellwisp = (this.eggPop.bellwisp || 0) + 1;
  }

  splash(x, y, k = 1) {
    if (this.offline) return;
    this.act.splashes++;
    const U = this.U;
    for (let i = 0; i < 10 * k; i++) this.particles.emit({ type: 'drop', x: x + rr(-1, 1) * U, y, vx: rr(-8, 8) * U * 0.5, vy: -rr(6, 16) * U * k, g: 40 * U, drag: 0.2, life: 1.2, size: rr(1.2, 2.4), color: P.mint });
    this.particles.emit({ type: 'ring', x, y, size: U, grow: 8 * U, life: 1, color: P.cream });
    this.ripples.push({ x, t: 0 });
  }

  // ------------------------------------------------------------ seed bank
  bankAdd(kind, genome, n) {
    const b = (this.bank[kind] ||= { count: 0, n: 0, g: [] });
    b.count++;
    b.n += n;
    if (b.g.length < 6) b.g.push(genome);
    else b.g[(Math.random() * 6) | 0] = genome;
  }
  bankTake(kind) {
    const b = this.bank[kind];
    const n = b.n / b.count;
    b.n -= n;
    b.count--;
    const genome = { ...b.g[(Math.random() * b.g.length) | 0] };
    if (b.count <= 0) { this.depositN(rr(0, this.W), b.n); delete this.bank[kind]; }
    return { genome, n };
  }

  // a species that has dwindled is reseeded from its dormant bank
  bankTick(dt) {
    for (const kind of FAUNA_KINDS) {
      const b = this.bank[kind];
      if (!b) continue;
      // dormant spores slowly die back into the soil
      const decay = b.n * (1 - Math.pow(0.5, dt / ECO.bankHalfLife));
      if (decay > 0) { b.n -= decay; this.depositN(rr(0, this.W), decay); }
      if (b.count > 0 && b.n < 1e-6) { delete this.bank[kind]; continue; }
      if (!this.unlocked(kind) || kind === 'mindbloom') continue;
      if (this.count(kind) + this.countEggs(kind) > ECO.bankFloor) continue;
      if (!chance(1 / (1.5 * HR), dt)) continue;
      const { genome, n } = this.bankTake(kind);
      const c = this.spawn(kind, { genome, n, age: 0, energy: 0.6, origin: 'Woke from the seed bank' });
      this.stats.births++;
      this.act.hatches++;
      this.log(`${c.name}, a ${SPECIES[kind].name.toLowerCase()}, woke from a dormant spore in the soil.`, 'birth');
    }
  }

  // ------------------------------------------------------------ hunting
  // Decided here at 1 Hz. Live, the predator then has a few seconds to reach
  // its prey (its move() chases); offline the kill commits immediately.
  huntTick(dt) {
    this.hunting = 0;
    for (const c of this.fauna) {
      if (c.dead || !PREDATORS.includes(c.kind)) continue;
      if (c.digest > 0 && !c.hunt) { c.digest -= dt; continue; }
      if (c.hunt) {
        this.hunting++;
        const prey = c.hunt.prey;
        if (prey.dead || prey.gone) { this.endHunt(c); continue; }
        if (this.t > c.hunt.until) this.predate(c, prey);
        continue;
      }
      if (c.energy > 0.6 || !c.adult) continue;
      const prey = c.findPrey(this);
      if (!prey) continue;
      const h = ECO.hunt[c.kind];
      let rate = h.a * this.huntMult(c, prey) * (c.genome.spd || 1) * (0.75 + 0.5 * c.genome.bold);
      // predators get in each other's way, unless they hunt as a pack
      rate /= 1 + (1.5 - c.genome.soc) * 0.5 * (this.count(c.kind) - 1);
      if (!chance(rate, dt)) continue;
      this.act.hunts++;
      if (this.offline) { this.predate(c, prey); continue; }
      c.hunt = { prey, until: this.t + 10 };
      if (!prey.species) prey._doomed = c.id;
      this.hunting++;
      this.log(`${c.name} the ${SPECIES[c.kind].name.toLowerCase()} is hunting.`, 'hunt');
    }
    this.trapTick(dt);
  }

  // how much easier a given prey is to catch
  huntMult(pred, prey) {
    if (prey.species) return 1.2; // eggs can't run
    let m = 1;
    const g = prey.genome;
    // contrast against its background: plainer creatures blend in
    m *= 0.5 + this.contrast(prey);
    // glowing at night gives you away
    m *= 1 + (g.gl || 0) * this.night * 1.5;
    if (prey._trance > 0) m *= 3;
    if (prey.inf) m *= 2;
    if (prey.stage === 'juvenile' || prey.stage === 'elder') m *= 1.6;
    m /= g.spd || 1;
    // temperament: bold ones wander into the open, watchful ones see it coming
    m *= (0.65 + 0.7 * g.bold) * (1.3 - 0.6 * g.vig);
    // safety in numbers, for those who keep close to their kin
    if (g.soc > 0.2) {
      let kin = 0;
      const r = 14 * this.U;
      for (const o of this.fauna) if (o !== prey && o.kind === prey.kind && Math.abs(o.x - prey.x) < r && Math.abs(o.y - prey.y) < r) kin++;
      m /= 1 + g.soc * Math.min(kin, 3) * 0.3;
    }
    return m;
  }

  contrast(c) {
    if (c._cam == null) {
      const bg = c.kind === 'petalmoth' || c.kind === 'bellwisp' ? ['#c3ddc9', '#1a1f3e'] : c.kind === 'ribbonfin' ? ['#66b3ad', '#1b4352'] : ['#a69a60', '#262c38'];
      const d = (a, b) => { const x = hexToRgb(a), y = hexToRgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) / 441; };
      c._cam = [d(c.genome.c1, bg[0]), d(c.genome.c1, bg[1])];
    }
    return lerp(c._cam[0], c._cam[1], this.night);
  }

  predate(pred, prey) {
    this.endHunt(pred);
    if (prey.dead || prey.gone) return;
    const h = ECO.hunt[pred.kind];
    pred.digest = h.digest;
    pred.energy = Math.min(1, pred.energy + (prey.species ? 0.4 : 0.7));
    this.act.kills++;
    if (prey.species) { this.killFx(pred, prey); this.eatEgg(prey, pred); this.log(`${pred.name} ate a ${SPECIES[prey.species].name.toLowerCase()} egg.`, 'hunt'); return; }
    this.feed(pred, prey.n || 0, prey.x);
    prey.n = 0;
    this.killFx(pred, prey);
    this.log(`${pred.name} the ${SPECIES[pred.kind].name.toLowerCase()} caught ${prey.name} the ${SPECIES[prey.kind].name.toLowerCase()}.`, 'hunt');
    this.killFauna(prey, 'eaten');
    if (!this.offline) this.particles.burst(prey.x, prey.y, 8, { type: 'spark', color: prey.genome.c1, speed: 8 * this.U, life: 0.9, g: 20 * this.U });
    pred.onKill?.(this, prey);
  }
  // a kill animation: the drawing code plays it for about a second
  killFx(pred, prey) {
    if (this.offline) return;
    const U = this.U;
    let mx = pred.x, my = pred.y;
    if (pred.kind === 'hookjaw') { mx = pred.x + pred.dir * 6 * U * pred.scale; my = pred.y - 2.5 * U * pred.scale; }
    else if (pred.kind === 'snaplure' || pred.kind === 'dewveil') { const t = pred.tip(this); mx = t.x; my = t.y; }
    else if (pred.kind === 'mireeel') { mx = pred.x + pred.dir * 4 * U * pred.scale; }
    if (this.fx.length >= 4) this.fx.shift();
    this.fx.push({ t0: this.t, x: prey.x, y: prey.y, mx, my, prey, color: prey.genome.c1, glow: prey.genome.glow || prey.genome.eye || P.glowAmber, dir: pred.dir || 1 });
    // fragments: wing petals flutter, shells crumble
    const flutter = prey.kind === 'petalmoth' || prey.kind === 'bellwisp';
    for (let i = 0; i < 10; i++) {
      this.particles.emit({ type: 'mote', x: prey.x + rr(-2, 2) * U, y: prey.y + rr(-2, 1) * U, vx: rr(-10, 10) * U * 0.4, vy: flutter ? rr(-6, 2) * U * 0.4 : -rr(4, 10) * U * 0.4, g: flutter ? 6 * U : 30 * U, drag: flutter ? 1.8 : 0.6, wob: flutter ? 14 : 0, life: flutter ? rr(2.5, 4) : rr(0.8, 1.4), size: rr(1.6, 3.2), color: i % 3 ? prey.genome.c1 : prey.genome.c2 });
    }
    this.particles.emit({ type: 'ring', x: prey.x, y: prey.y, size: U, grow: 14 * U, life: 0.7, drag: 0, color: P.cream });
  }

  // ---- commanded hunts: you can point a predator at the glass, but only
  // every so often, and the usual refuges still protect dwindling prey
  orderWait() { return Math.max(0, (this.stats.orderReadyAt || 0) - this.simTime); }
  orderStatus(pred) {
    if (!pred || pred.dead) return { ok: false, why: 'gone' };
    if (pred.hunt || pred.lured || (pred.snapT > 0)) return { ok: false, why: 'busy' };
    if ((pred.kind === 'snaplure' || pred.kind === 'dewveil') && (pred.growth < 0.8 || pred.wither > 0)) return { ok: false, why: 'young' };
    if (PREDATORS.includes(pred.kind) && !pred.adult) return { ok: false, why: 'young' };
    const wait = this.orderWait();
    if (wait > 0) return { ok: false, why: 'cooldown', wait };
    if (!this.orderPrey(pred)) return { ok: false, why: 'noprey' };
    return { ok: true };
  }
  orderPrey(pred) {
    if (pred.findPrey) return pred.findPrey(this);
    const preyKind = pred.kind === 'snaplure' ? 'petalmoth' : 'bellwisp';
    if (this.count(preyKind) <= ECO.hunt[pred.kind].refuge) return null;
    let prey = null, bd = Infinity;
    for (const c of this.fauna) {
      if (c.kind !== preyKind || c.dead || c.lured || c._doomed) continue;
      const d = Math.abs(c.x - pred.x);
      if (d < bd) { bd = d; prey = c; }
    }
    return prey;
  }
  orderHunt(pred) {
    const st = this.orderStatus(pred);
    if (!st.ok) return st;
    const prey = this.orderPrey(pred);
    this.stats.orderReadyAt = this.simTime + ORDER_COOLDOWN;
    this.act.hunts++;
    if (pred.findPrey) {
      pred.digest = 0;
      pred.hunt = { prey, until: this.t + 25, ordered: true };
      if (!prey.species) prey._doomed = pred.id;
      this.log(`You sent ${pred.name} the ${SPECIES[pred.kind].name.toLowerCase()} to hunt.`, 'hunt');
    } else {
      pred.digest = 0; pred.closed = 0; pred.caught = 0;
      pred.lured = prey; pred.lureUntil = this.t + 30;
      prey.lured = pred;
      this.log(`You coaxed a ${SPECIES[pred.kind].name.toLowerCase()} into luring ${prey.name}.`, 'hunt');
    }
    return { ok: true, prey };
  }

  endHunt(pred) {
    if (!pred.hunt) return;
    const prey = pred.hunt.prey;
    if (prey && prey._doomed === pred.id) prey._doomed = null;
    pred.hunt = null;
  }

  // carnivorous plants lure their prey in; the kill happens when it arrives
  trapTick(dt) {
    for (const p of this.traps) {
      if (p.dead) continue;
      if (p.digest > 0) {
        p.digest -= dt;
        if (p.digest <= 0) { p.closed = 0; p.caught = 0; }
        continue;
      }
      if (p.growth < 0.8 || p.wither > 0) continue;
      if (p.lured) {
        if (p.lured.dead || this.t > p.lureUntil) { if (p.lured.lured === p) p.lured.lured = null; p.lured = null; }
        else continue;
      }
      const preyKind = p.kind === 'snaplure' ? 'petalmoth' : 'bellwisp';
      const h = ECO.hunt[p.kind];
      if (this.count(preyKind) <= h.refuge) continue;
      if (!chance(h.a * (p.kind === 'snaplure' ? 1 + this.night : 1), dt)) continue;
      let prey = null, bd = Infinity;
      for (const c of this.fauna) {
        if (c.kind !== preyKind || c.dead || c.lured || c._doomed) continue;
        const d = Math.abs(c.x - p.x) / (0.5 + this.contrast(c)) / (1 + (c.genome.gl || 0) * this.night);
        if (d < bd) { bd = d; prey = c; }
      }
      if (!prey) continue;
      this.act.hunts++;
      if (this.offline) { this.trapKill(p, prey); continue; }
      p.lured = prey; p.lureUntil = this.t + 25;
      prey.lured = p;
    }
  }

  trapKill(p, prey) {
    if (prey.dead) return;
    const h = ECO.hunt[p.kind];
    p.lured = null;
    prey.lured = null;
    p.closed = 1; p.caught = 1; p.snapT = 0.6; p.digest = h.digest; p.lastMeal = p.age;
    const keep = (prey.n || 0) * ECO.assim;
    const room = Math.max(0, ECO.nPlant[p.kind] * 3 - p.n);
    p.n += Math.min(keep, room);
    this.depositN(p.x, (prey.n || 0) - Math.min(keep, room));
    prey.n = 0;
    this.act.kills++;
    this.killFx(p, prey);
    this.log(`A ${SPECIES[p.kind].name.toLowerCase()} caught ${prey.name} the ${SPECIES[prey.kind].name.toLowerCase()}.`, 'hunt');
    this.killFauna(prey, 'eaten');
    if (!this.offline) this.particles.burst(prey.x, prey.y, 8, { type: 'spark', color: prey.genome.c1, speed: 6 * this.U, life: 0.8, g: 10 * this.U });
  }

  // well-fed traps seed new traps next to them; starving ones wither
  trapSlowTick() {
    const c = this.countFlora();
    for (const p of this.traps) {
      if (p.dead || p.growth < 1) continue;
      const kind = p.kind;
      const maxN = kind === 'snaplure' ? 4 : 2;
      if (p.age - (p.lastMeal ?? 0) > 30 * HR && p.life > p.age) { p.life = p.age; this.log(`A starving ${SPECIES[kind].name.toLowerCase()} has begun to wither.`, 'death'); }
      if (p.n >= 2 * ECO.nPlant[kind] && (c[kind] || 0) < maxN && this.flora.length < this.floraCap()) {
        const nb = ECO.nPlant[kind] * 0.5;
        p.n -= nb;
        let x = clamp(p.x + rr(-25, 25) * this.U, 4 * this.U, this.W - 4 * this.U);
        if (kind === 'snaplure' && this.inPond(x, 4 * this.U)) x = p.x;
        this.flora.push(new Plant({ kind, x, growth: 0.15, n: nb, lastMeal: 0 }));
        c[kind] = (c[kind] || 0) + 1;
      }
    }
  }

  // ------------------------------------------------------------ fungus
  // A simple crowding-driven infection: it only spreads where creatures pack
  // together, and gloomcaps rising from its victims seed more of it.
  fungusTick(dt) {
    const F = ECO.fungus;
    // crowding is counted per layer: ground, air and water creatures don't
    // breathe on each other
    const dens = this._dens || (this._dens = [new Float32Array(NB), new Float32Array(NB), new Float32Array(NB)]);
    const inf = this._infd || (this._infd = [new Float32Array(NB), new Float32Array(NB), new Float32Array(NB)]);
    for (let l = 0; l < 3; l++) { dens[l].fill(0); inf[l].fill(0); }
    for (const c of this.fauna) {
      if (c.kind === 'mindbloom') continue;
      const b = this.bucketOf(c.x), l = LAYER[c.kind];
      dens[l][b]++;
      if (c.inf) inf[l][b]++;
    }
    let outbreak = null;
    for (const c of this.fauna) {
      if (c.dead || c.inf || c.kind === 'mindbloom') continue;
      const b = this.bucketOf(c.x), l = LAYER[c.kind];
      let d = 0, i = 0, m = 0;
      let bl = 0;
      for (let k = b - 1; k <= b + 1; k++) { if (k < 0 || k >= NB) continue; d += dens[l][k]; i += inf[l][k]; if (l === 0) m += this.mush[k]; bl += Math.max(0, this.blight[k] - 0.65); }
      // a blighted weed's spores infect even the uncrowded
      if (bl > 0 && c.kind !== 'mindbloom' && chance(bl * (RESIST[c.kind] || 1) / (5 * HR), dt)) {
        c.inf = 1; c._infLife = rr(F.lifeMin, F.lifeMax); outbreak = c;
        this._blightCase = true;
        continue;
      }
      const crowd = Math.max(0, d - F.crowd);
      if (!crowd) continue;
      let rate = F.beta * (i + m * 2) * crowd + (d > F.crowd * 1.6 ? F.spont * crowd : 0);
      if (RESIST[c.kind]) rate *= RESIST[c.kind]; // big bodies shrug most of it off
      rate *= 0.4 + 0.8 * c.genome.soc; // huddlers catch it from each other
      if (chance(rate, dt)) {
        c.inf = 1;
        c._infLife = rr(F.lifeMin, F.lifeMax);
        outbreak = c;
      }
    }
    if (outbreak && this.t - (this._lastOutbreakLog || -1e9) > 1800) {
      this._lastOutbreakLog = this.t;
      if (this._blightCase) { this._blightCase = false; this.log(`${outbreak.name} the ${SPECIES[outbreak.kind].name.toLowerCase()} breathed in blight spores from a neglected task's weeds and caught the gloomcap fungus.`, 'fungus'); return; }
      this.log(`${outbreak.name} the ${SPECIES[outbreak.kind].name.toLowerCase()} has caught the gloomcap fungus. Crowded creatures pass it to each other.`, 'fungus');
    }
  }

  // ------------------------------------------------------------ genesis
  genesis() {
    const W = this.W, U = this.U;
    const r = mulberry32(this.seed);
    const plant = (kind, x, growth) => {
      if (this.inPond(x, 3 * U)) return;
      const p = new Plant({ kind, x, growth, age: rr(0, 10) * HR });
      p.n = ECO.nPlant[kind] * growth;
      if (kind === 'bulbstalk') { p.ripe = r() * 0.8; p.store = p.ripe * ECO.nFruit; }
      if (kind === 'lanternlily') { p.store = ECO.nNectar; p.nectar = 1; }
      this.flora.push(p);
    };
    const kinds = ['fanfern', 'bulbstalk', 'lanternlily', 'fanfern', 'grass', 'puffcap', 'lanternlily', 'bulbstalk', 'grass', 'fanfern', 'grass', 'grass', 'bulbstalk', 'lanternlily', 'grass', 'puffcap', 'fanfern', 'grass'];
    kinds.forEach((k, i) => plant(k, (i + 0.5 + (r() - 0.5) * 0.8) / kinds.length * W, 0.6 + r() * 0.4));
    for (let i = 0; i < 3; i++) this.spawn('scuttler', { age: rr(1, 4) * HR, origin: 'First settler', energy: 0.8 });
    for (let i = 0; i < 3; i++) this.spawn('petalmoth', { age: rr(0.6, 2) * HR, origin: 'First settler', energy: 0.8 });
    // every species starts with a little dormant life in the soil
    for (const k of ['scuttler', 'petalmoth']) for (let i = 0; i < 2; i++) this.bankAdd(k, CREATURES[k].randomGenome(r), ECO.nBody[k]);
    this.stats.created = Date.now();
    this.stats.n0 = this.totalN();
    this.stats.nIn = 0;
    this.rebuildIndex();
    this.log('A new terrarium was sealed. Three scuttlers and three petalmoths were the first to stir.', 'milestone');
  }

  // ------------------------------------------------------------ the sim
  update(dt) {
    this.t += dt;
    if (this.fx.length && this.t - this.fx[0].t0 > 1.4) this.fx.shift();
    this.simTime = this.now();
    // breathing gusts of air inside the glass
    this._gustT -= dt;
    if (this._gustT <= 0) { this._gustT = rr(20, 70); this._gustTarget = Math.random() < 0.4 ? rr(-1, 1) : 0; }
    this.gust = lerp(this.gust, this._gustTarget || 0, dt * 0.3);
    if (this.mindPulse) { this.mindPulse.age += dt; if (this.mindPulse.age > 10) this.mindPulse = null; }

    this.weather(dt);
    this._lifeAcc += dt;
    if (this._lifeAcc >= 1) { this.tick(this._lifeAcc); this._lifeAcc = 0; }

    for (const c of this.fauna) {
      if (c.dead) continue;
      c.move(this, dt);
      // the fungus makes its hosts stagger
      if (c.inf) c.x = clamp(c.x + Math.sin(this.t * 6 + c.phase) * this.U * 1.5 * dt, 2 * this.U, this.W - 2 * this.U);
    }
    for (const e of this.eggs) e.move(this, dt);
    for (const p of this.traps) if (p.snapT > 0) p.snapT -= dt;
    this.moveItems(dt);
    for (const v of this.visitors) v.update(this, dt);
    for (const r of this.ripples) r.t += dt;
    if (this.ripples.length && this.ripples[0].t > 3) this.ripples.shift();
    this.particles.update(dt, this.t);
  }

  // A slow drift of spores sometimes falls through the glass (visual only).
  weather(dt) {
    if (this.offline) return;
    if (this._driftAt == null) this._driftAt = this.t + rr(8, 25) * 60;
    if (this.t > this._driftAt && !this.drift) {
      this.drift = { until: this.t + rr(120, 240), col: [P.glowLime, P.glowAmber, P.glowPink, P.glowCyan][Math.floor(Math.random() * 4)] };
      this.log('A spore drift is falling through the glass.', 'visitor');
    }
    const d = this.drift;
    if (!d) return;
    if (this.t > d.until) { this.drift = null; this._driftAt = this.t + rr(35, 90) * 60; return; }
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
    this._tickN++;
    this.updateSky();
    this.rebuildIndex();
    for (const p of this.flora) if (!p.dead) p.tick(this, dt);
    for (const c of this.fauna) {
      if (c.dead) continue;
      if (c.inf) {
        c.inf += dt;
        c.energy -= dt / (3 * HR);
        if (c.inf > (c._infLife || 3 * HR)) { this.killFauna(c, 'fungus'); continue; }
      }
      // thorns of feral weeds wear down whatever lives among them
      const bl = this.blight[this.bucketOf(c.x)];
      if (bl > 0.45 && c.kind !== 'mindbloom') c.energy -= (bl - 0.3) * dt / (2 * HR);
      c.lifeTick(this, dt);
    }
    for (const e of this.eggs) if (!e.gone) e.tick(this, dt);
    for (const it of this.items) {
      if (it.gone) continue;
      it.age += dt;
      if (this.offline && !it.grounded) { it.grounded = true; it.inWater = this.inPond(it.x); it.y = it.inWater ? this.pondBottom(it.x) - this.U : this.groundY(it.x) - this.U * 0.8; }
      const rot = it.inWater ? 1.5 * HR : 4 * HR;
      if (it.age > rot) this.consumeItem(it, null);
    }
    this.huntTick(dt);
    if (this._tickN % 5 === 0) this.fungusTick(dt * 5);
    if (this._tickN % 30 === 0) {
      if (this._tickN % 600 === 0) this.pruneLineage();
      const sdt = dt * 30;
      this.diffuse(sdt);
      this.bankTick(sdt);
      this.immigrate(sdt);
      this.arrivals();
      this.trapSlowTick();
    }
    this.compact();
    this.sprout(dt);
    this.scheduleVisitors();
  }

  // drop dead things in place, without allocating new arrays
  compact() {
    const keep = (arr, alive) => { let w = 0; for (let i = 0; i < arr.length; i++) if (alive(arr[i])) arr[w++] = arr[i]; arr.length = w; };
    keep(this.flora, (p) => !p.dead);
    keep(this.fauna, (c) => !c.dead);
    keep(this.eggs, (e) => !e.gone);
    keep(this.items, (i) => !i.gone);
    keep(this.visitors, (v) => !v.done);
  }

  // nutrient slowly spreads sideways through the soil (conserving)
  diffuse(dt) {
    const s = this.soil;
    const k = Math.min(0.2, dt / (6 * HR));
    const tmp = this._tmp || (this._tmp = new Float64Array(SOIL_N));
    for (let i = 0; i < SOIL_N; i++) {
      const l = s[i > 0 ? i - 1 : i], r = s[i < SOIL_N - 1 ? i + 1 : i];
      tmp[i] = s[i] + k * (l + r - 2 * s[i]);
    }
    s.set(tmp);
  }

  sprout(dt) {
    const cap = this.floraCap();
    const n = this.flora.length;
    if (n >= cap) return;
    let avg = 0; for (const s of this.soil) avg += s; avg /= SOIL_N;
    const rate = Math.min(1.2, 0.3 + avg) * (1 - n / cap) / 900 * (n < cap * 0.5 ? 3 : 1);
    if (!chance(rate, dt)) return;
    // sample a few spots, prefer fertile and uncrowded
    let best = null, bs = -1;
    for (let k = 0; k < 6; k++) {
      const x = rr(0.03, 0.97) * this.W;
      if (this.inPond(x, 3 * this.U) || this.blight[this.bucketOf(x)] > 0.3) continue;
      let crowd = 0;
      for (const p of this.flora) { const d = Math.abs(p.x - x) / this.U; if (d < 6) crowd += (6 - d); }
      const s = this.fertAt(x) - crowd * 0.05;
      if (s > bs) { bs = s; best = x; }
    }
    if (best == null || this.fertAt(best) < 0.05) return;
    const kind = pickKind(sproutWeights(this));
    const seedN = this.takeN(best, ECO.nPlant[kind] * 0.1);
    this.flora.push(new Plant({ kind, x: best, n: seedN }));
    if (kind === 'coilspire' || kind === 'tubebloom') this.discover(kind);
  }

  // outsiders only arrive when a species has been gone a long time and its
  // seed bank is empty: the glass mostly rescues itself
  immigrate(dt) {
    for (const kind of FAUNA_KINDS) {
      if (!this.unlocked(kind)) continue;
      if (this.count(kind) + this.countEggs(kind) > 0 || this.bank[kind]) continue;
      const gone = this.stats.goneAt[kind] ?? (this.stats.goneAt[kind] = this.simTime);
      const wait = kind === 'mindbloom' ? 86400 : ECO.immigrateAfter;
      if (this.simTime - gone < wait * 1000) continue;
      if (!chance(1 / HR, dt)) continue;
      this.arrive(kind, `A lone ${SPECIES[kind].name.toLowerCase()} named {name} found its way in from the flats.`);
    }
  }

  arrive(kind, msg) {
    const g = CREATURES[kind].randomGenome(Math.random);
    const n = this.nStruct(kind, g);
    this.stats.nIn += n;
    const c = this.spawn(kind, { genome: g, n, age: CREATURES[kind].mature * rr(1, 2), energy: 0.75 });
    delete this.stats.goneAt[kind];
    this.log(msg.replace('{name}', c.name), 'arrival');
    return c;
  }

  // species unlocked before the predators existed arrive one at a time
  arrivals() {
    const q = this.stats.pendingArrivals;
    if (!q?.length || this.simTime < (this.stats.nextArrival || 0)) return;
    const kind = q.shift();
    this.stats.nextArrival = this.simTime + rr(2, 4) * HR * 1000;
    this.introduce(kind);
  }

  // put the first of a newly unlocked species into the glass
  introduce(kind, x) {
    const sp = SPECIES[kind];
    if (sp.kind === 'flora') {
      const U = this.U;
      let px = x ?? rr(0.1, 0.9) * this.W;
      if (kind === 'snaplure' && this.inPond(px, 5 * U)) px = this.pond.x0 - 10 * U;
      if (kind === 'dewveil') px = rr(0.4, 0.75) * this.W;
      const n = ECO.nPlant[kind];
      this.stats.nIn += n;
      this.flora.push(new Plant({ kind, x: px, growth: 0.5, n, lastMeal: 0 }));
      this.discover(kind);
      this.log(`A ${sp.name.toLowerCase()} has taken root in the glass.`, 'arrival');
      return null;
    }
    return this.arrive(kind, `A ${sp.name.toLowerCase()} named {name} has slipped into the glass.`);
  }

  scheduleVisitors() {
    if (this.offline || !this.unlocked('gloamwhale')) return;
    if (!this.stats.nextWhale) this.stats.nextWhale = this.simTime + rr(4, 12) * 60000;
    if (this.simTime > this.stats.nextWhale && !this.visitors.length) {
      this.stats.nextWhale = this.simTime + rr(35, 80) * 60000;
      this.visitors.push(new Gloamwhale(this));
      this.discover('gloamwhale');
      this.log('A gloamwhale drifted across the far sky.', 'visitor');
    }
  }

  // Replay the sim while the app was closed. Coarse steps, no motion; the
  // step grows with the gap so four days is still only ~2000 ticks.
  catchUp(seconds) {
    seconds = Math.min(seconds, 4 * 24 * HR);
    if (seconds < 5) return null;
    const before = { births: this.stats.births, deaths: this.stats.deaths, kills: this.act.kills };
    this.offline = true;
    const end = this.now();
    let t = end - seconds * 1000;
    const step = clamp(seconds / 2000, 20, 180);
    while (t < end) {
      const dt = Math.min(step, (end - t) / 1000);
      t += dt * 1000;
      this.simTime = t;
      this.jitter(dt);
      this.tick(dt);
    }
    this.offline = false;
    this.simTime = this.now();
    this.updateSky();
    this.rebuildIndex();
    // put things back where they belong
    for (const c of this.fauna) {
      c.hunt = null; c.lured = null; c._doomed = null;
      if (c.kind === 'scuttler' || c.kind === 'stiltstrider' || c.kind === 'hookjaw') { if (this.inPond(c.x, 4 * this.U)) c.x = this.pond.x0 - 8 * this.U; c.state = 'idle'; c.timer = 0; c.y = this.groundY(c.x); }
    }
    for (const p of this.traps) p.lured = null;
    return { seconds, births: this.stats.births - before.births, deaths: this.stats.deaths - before.deaths, kills: this.act.kills - before.kills };
  }

  // offline, nothing moves, so creatures wander a little each step to keep
  // crowding and hunting from freezing in place
  jitter(dt) {
    const k = Math.min(1, dt / 60) * 4 * this.U;
    for (const c of this.fauna) {
      if (c.kind === 'mindbloom') continue;
      if (c.kind === 'ribbonfin' || c.kind === 'mireeel') { c.x = clamp(c.x + rr(-k, k), this.pond.x0 + 3 * this.U, this.pond.x1 - 3 * this.U); continue; }
      let x = clamp(c.x + rr(-k, k), 3 * this.U, this.W - 3 * this.U);
      if ((c.kind === 'scuttler' || c.kind === 'stiltstrider' || c.kind === 'hookjaw') && this.inPond(x, 4 * this.U)) x = c.x;
      c.x = x;
    }
  }

  // ------------------------------------------------------------ hit testing
  // Creatures first, and generously: the nearest one within a finger's
  // reach of the tap wins, so small or moving ones are easy to catch.
  pick(x, y) {
    const U = this.U, finger = Math.max(24, 6 * U) / (this.pickZ || 1);
    let best = null, bs = Infinity;
    for (const c of this.fauna) {
      const s = c.scale * U;
      const r = Math.max(c.hitR * s, finger);
      const d = Math.hypot(x - c.x, y - (c.y - c.hitDY * s));
      if (d < r && d / r < bs) { bs = d / r; best = c; }
    }
    if (best) return { type: 'fauna', obj: best };
    for (const e of this.eggs) if (e.hit(this, x, y)) return { type: 'egg', obj: e };
    for (let i = this.flora.length - 1; i >= 0; i--) if (this.flora[i].kind !== 'grass' && this.flora[i].hit(this, x, y)) return { type: 'flora', obj: this.flora[i] };
    return null;
  }
  find(id) { return this.fauna.find((c) => c.id === id) || this.flora.find((p) => p.id === id) || this.eggs.find((e) => e.id === id); }

  // ------------------------------------------------------------ task rewards
  // A finished task becomes a creature. The task's words seed its genome,
  // so the same words always grow the same colours. Your work is the one
  // outside source of nutrient for the glass.
  bloomTask(task, x, y) {
    this.stats.tasksDone++;
    const done = this.stats.tasksDone;
    const newly = Object.keys(SPECIES).filter((k) => SPECIES[k].unlock === done);
    const pool = FAUNA_KINDS.filter((k) => this.unlocked(k) && k !== 'mindbloom' && !PREDATORS.includes(k));
    let kind = newly.find((k) => CREATURES[k] && k !== 'mindbloom');
    if (newly.includes('mindbloom')) kind = 'mindbloom';
    if (!kind) {
      let best = null, bs = -Infinity;
      for (const k of pool) {
        const room = this.ceil(k) - this.count(k) - this.countEggs(k);
        const s = room / this.ceil(k) + Math.random() * 0.35;
        if (room > 0 && s > bs) { bs = s; best = k; }
      }
      kind = best;
    }
    this.inject(x, 0.35 + Math.min(task.steps?.length || 0, 10) * 0.03);
    let creature = null;
    if (kind) {
      const r = mulberry32(hashStr(task.title.toLowerCase().trim() + kind));
      const genome = CREATURES[kind].randomGenome(r);
      // a finished project of many steps blooms into a grander creature
      const steps = task.steps?.length || 0;
      if (steps >= 3) genome.size = Math.min(1.3, genome.size * (1 + Math.min(steps, 10) * 0.025));
      const n = this.nStruct(kind, genome);
      this.stats.nIn += n;
      const o = { genome, n, origin: `Bloomed from “${task.title}”`, name: makeName(r), energy: 0.85, age: CREATURES[kind].mature * 0.25 };
      creature = this.spawn(kind, o);
      if (kind === 'scuttler' || kind === 'stiltstrider' || kind === 'hookjaw') { creature.x = x; creature.y = this.groundY(x); if (this.inPond(x, 5 * this.U)) this.placeNew(creature); }
      else if (kind === 'petalmoth' || kind === 'bellwisp') { creature.x = x; creature.y = y - 8 * this.U; }
      this.stats.births++;
      this.act.births++;
      this.log(`“${task.title}” was finished and bloomed into ${creature.name}, a ${SPECIES[kind].name}.`, 'task');
    } else {
      // everything is at capacity: the soil takes the gift instead
      this.inject(x, 0.3);
      for (let i = 0; i < 3; i++) {
        const k = pickKind(sproutWeights(this));
        const px = clamp(x + rr(-12, 12) * this.U, 0, this.W);
        this.flora.push(new Plant({ kind: k, x: px, n: this.takeN(px, ECO.nPlant[k] * 0.1) }));
      }
      this.log(`“${task.title}” was finished. The terrarium is full, so it fed the soil and three sprouts appeared.`, 'task');
    }
    for (const k of newly) {
      this.discover(k);
      if (SPECIES[k].kind === 'flora' && (k === 'snaplure' || k === 'dewveil')) this.introduce(k, k === 'snaplure' ? x + 10 * this.U : undefined);
      this.log(`Something new has arrived: the ${SPECIES[k].name}.`, 'milestone');
      this.emit('unlock', k);
    }
    return { creature, newly };
  }

  // ------------------------------------------------------------ family tree
  // Every creature gets a small record that outlives it, so the journal can
  // draw who descended from whom. Kept bounded by pruneLineage().
  record(c) {
    const old = this.lineage[c.id];
    if (old) return old;
    const g = c.genome, t = {};
    for (const k of TRAITS) t[k.k] = Math.round(g[k.k] * 100) / 100;
    const r = {
      id: c.id, pid: c.pid ?? null, name: c.name, kind: c.kind, gen: c.gen,
      b: Math.round(this.simTime - c.age * 1000), d: 0, cause: '', kids: 0,
      c1: g.c1, c2: g.c2 || g.c1, o: c.pid ? '' : c.origin, t,
    };
    this.lineage[c.id] = r;
    const p = c.pid && this.lineage[c.pid];
    if (p) p.kids++;
    return r;
  }

  // older saves have no records: start one for everyone alive, and link
  // children to living parents by name where the origin says who they were
  adoptLineage() {
    const byName = {};
    for (const c of this.fauna) byName[c.kind + ':' + c.name] = c;
    for (const c of this.fauna) {
      if (this.lineage[c.id]) continue;
      if (c.pid == null) {
        const m = /^Child of (.+)$/.exec(c.origin || '');
        const p = m && byName[c.kind + ':' + m[1]];
        if (p && p !== c) c.pid = p.id;
      }
    }
    for (const c of this.fauna) {
      if (c.pid && !this.lineage[c.pid]) { const p = this.fauna.find((o) => o.id === c.pid); if (p) this.record(p); }
      this.record(c);
    }
  }

  // Keep the living, a few generations of their ancestors, and the recently
  // dead; everything else fades out of the record.
  pruneLineage() {
    const L = this.lineage;
    const keep = new Set();
    const anc = (id, depth) => {
      for (let r = L[id], i = 0; r && i <= depth; r = L[r.pid], i++) keep.add(r.id);
    };
    for (const c of this.fauna) anc(c.id, LINEAGE_DEPTH);
    for (const e of this.eggs) if (e.pid) anc(e.pid, LINEAGE_DEPTH - 1);
    const now = this.simTime;
    const rest = [];
    for (const id in L) {
      if (keep.has(id)) continue;
      if (now - L[id].d < LINEAGE_FADE) rest.push(L[id]);
      else delete L[id];
    }
    // over budget: drop the longest-dead first
    if (keep.size + rest.length > LINEAGE_MAX) {
      rest.sort((a, b) => a.d - b.d);
      for (const r of rest.slice(0, keep.size + rest.length - LINEAGE_MAX)) delete L[r.id];
    }
  }

  rename(c, name) {
    c.name = name;
    const r = this.lineage[c.id];
    if (r) r.name = name;
  }

  // ------------------------------------------------------------ persistence
  serialize() {
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    return {
      v: SAVE_V,
      seed: this.seed,
      W: this.W, H: this.H,
      flora: this.flora.map((p) => p.serialize(this)),
      fauna: this.fauna.map((c) => c.serialize(this)),
      eggs: this.eggs.map((e) => e.serialize(this)),
      items: this.items.map((i) => ({ id: i.id, type: i.type, x: i.x / this.W, y: i.y / this.H, vy: 0, color: i.color, n: i.n, food: i.food, age: i.age, grounded: i.grounded, inWater: i.inWater })),
      soil: Array.from(this.soil, r4),
      bank: this.bank,
      lineage: Object.values(this.lineage),
      stats: this.stats,
      logs: this.logs.slice(-140),
    };
  }

  restore(d) {
    this.seed = d.seed;
    const W = this.W, H = this.H;
    const v = d.v ?? 1;
    const lookup = {};
    this.flora = d.flora.filter((o) => FLORA_KINDS.includes(o.kind)).map((o) => { bumpUid(o.id); return new Plant({ ...o, x: o.x * W }); });
    this.fauna = d.fauna.filter((o) => CREATURES[o.kind]).map((o) => {
      bumpUid(o.id);
      const c = new CREATURES[o.kind]({ ...o, x: o.x * W, y: o.y * H, state: o.kind === 'petalmoth' ? 'fly' : 'idle', timer: 0, hunt: null, lured: null });
      lookup[c.id] = c;
      return c;
    });
    this.eggs = (d.eggs || []).map((o) => new Egg({ ...o, x: o.x * W, y: o.y * H }));
    this.items = (d.items || []).map((i) => ({ ...i, x: i.x * W, y: i.y * H }));
    if (d.soil?.length === SOIL_N) this.soil = Float64Array.from(d.soil);
    this.stats = { ...this.stats, ...d.stats };
    this.bank = d.bank || {};
    this.logs = d.logs || [];
    this.lineage = {};
    for (const r of d.lineage || []) this.lineage[r.id] = r;
    if (v < 2) this.migrate1to2();
    this.adoptLineage();
    for (const c of this.fauna) if (c.kind === 'scuttler' || c.kind === 'stiltstrider' || c.kind === 'hookjaw') c.y = this.groundY(c.x);
    // re-baseline the ledger: saving rounds the soil a little
    this.stats.n0 = this.totalN() - (this.stats.nIn || 0);
    this.rebuildIndex();
  }

  // Version 1 saves predate nutrient tracking, seed banks and predators.
  migrate1to2() {
    for (const p of this.flora) {
      p.n = ECO.nPlant[p.kind] * p.growth;
      if (p.kind === 'bulbstalk') p.store = (p.ripe || 0) * ECO.nFruit;
      if (p.kind === 'lanternlily') p.store = (p.nectar ?? 1) * ECO.nNectar;
    }
    for (const c of this.fauna) {
      c.n = this.nStruct(c.kind, c.genome) * 1.3;
      c.genome.spd ??= 1;
      c.genome.gl ??= c.genome.glow ? 0.5 : 0;
      c.inf = 0;
    }
    for (const e of this.eggs) e.n = this.nStruct(e.species, e.genome);
    for (const i of this.items) i.n = (i.food || 1) * ECO.nFruit;
    for (const c of this.fauna) if (!this.bank[c.kind] || this.bank[c.kind].count < 2) this.bankAdd(c.kind, c.genome, this.nStruct(c.kind, c.genome) * 0.5);
    this.stats.nIn = 0;
    // unlocked species missing from an old glass come back soon, not in days
    this.stats.goneAt = {};
    for (const k of FAUNA_KINDS) if (this.unlocked(k) && !PREDATORS.includes(k) && !this.fauna.some((c) => c.kind === k)) this.stats.goneAt[k] = 0;
    // anyone already past the carnivore thresholds meets them gradually
    const due = [];
    for (const k of ['snaplure', 'dewveil', 'hookjaw', 'lancewing', 'mireeel']) if (this.unlocked(k)) due.push(k);
    this.stats.pendingArrivals = due;
    this.stats.nextArrival = this.simTime + rr(0.5, 1.5) * HR * 1000;
  }
}
