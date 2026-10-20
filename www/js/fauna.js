// The animals of the glass. Every creature carries a genome drawn from the
// palette; offspring inherit it with small drift and the occasional mutation,
// so lineages slowly develop their own look over days.
import { P, FAMILIES } from './palette.js';
import { SPECIES, makeName } from './species.js';
import {
  TAU, clamp, lerp, rr, pick, chance, uid, mixHex, jitterHex, drawGlow, mulberry32, smooth, fbm, dist2,
} from './util.js';

const HR = 3600;

// ---------------------------------------------------------------- base
export class Creature {
  constructor(o = {}) {
    const C = this.constructor;
    this.id = uid();
    this.kind = C.kind;
    this.name = makeName();
    this.age = 0;
    this.energy = 0.65;
    this.gen = 1;
    this.born = Date.now();
    this.origin = 'Wandered in';
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.dir = Math.random() < 0.5 ? -1 : 1;
    this.phase = Math.random() * TAU;
    this.state = 'idle';
    this.timer = 0;
    Object.assign(this, o);
    if (!this.genome) this.genome = C.randomGenome(Math.random);
    if (!this.life) this.life = rr(C.lifeRange[0], C.lifeRange[1]);
    this._trance = 0;
  }

  get grown() { return clamp(this.age / this.constructor.mature, 0, 1); }
  get scale() { return (0.42 + 0.58 * smooth(this.grown)) * this.genome.size; }
  get stage() {
    if (this.age < this.constructor.mature) return 'juvenile';
    if (this.age > this.life * 0.82) return 'elder';
    return 'adult';
  }
  get adult() { return this.age >= this.constructor.mature; }

  lifeTick(world, dt) {
    this.age += dt;
    this.energy -= dt / this.constructor.metabolism;
    if (this.energy < 0) { this.energy = 0; this.age += dt * 2; }
    if (world.offline) this.forage(world, dt);
    if (this.age >= this.life) world.killFauna(this, 'age');
  }
  forage() {}

  // offspring genome: numeric drift, color drift, rare structural mutation
  childGenome(r = Math.random) {
    const g = { ...this.genome };
    for (const k in g) {
      const v = g[k];
      if (typeof v === 'number' && k !== 'seed') g[k] = v * (1 + (r() * 2 - 1) * 0.05);
      else if (typeof v === 'string' && v[0] === '#' && !k.startsWith('glow')) g[k] = jitterHex(v, 6, r);
    }
    g.seed = Math.floor(r() * 1e9);
    g.size = clamp(g.size, 0.78, 1.3);
    let mutation = null;
    if (r() < 0.12) mutation = this.constructor.mutate(g, r);
    return { genome: g, mutation };
  }
  static mutate(g, r) {
    const keys = Object.keys(g).filter((k) => k.startsWith('c'));
    const k = pick(keys, r);
    const fam = pick(Object.keys(FAMILIES).filter((f) => f !== 'glow'), r);
    g[k] = pick(FAMILIES[fam], r);
    return 'a new colouration';
  }

  trance(world, dt) {
    this._trance = Math.max(0, this._trance - dt);
    const m = world.mindPulse;
    if (m && m.age < 0.5 && dist2(this.x, this.y, m.x, m.y) < (60 * world.U) ** 2) this._trance = 9;
    return this._trance > 0;
  }

  hit(world, x, y) {
    const r = this.hitR * world.U * this.scale;
    return dist2(x, y + this.hitDY * world.U * this.scale, this.x, this.y) < r * r;
  }
  get hitR() { return 6; }
  get hitDY() { return 0; }

  serialize(world) {
    const o = {};
    for (const k in this) if (k[0] !== '_' && k !== 'target' && k !== 'reach') o[k] = this[k];
    o.x = this.x / world.W;
    o.y = this.y / world.H;
    return o;
  }
}

// ---------------------------------------------------------------- scuttler
export class Scuttler extends Creature {
  static kind = 'scuttler';
  static lifeRange = [8 * HR, 15 * HR];
  static mature = 40 * 60;
  static metabolism = 9 * HR;
  static randomGenome(r) {
    return {
      c1: pick([P.ochre, P.sand, P.moss, P.rust, P.amber, P.olive], r),
      c2: pick([P.cream, P.bone, P.peach], r),
      c3: pick([P.plum, P.deepteal, P.rust, P.ink], r),
      eye: pick([P.glowCyan, P.glowLime, P.glowAmber], r),
      size: rr(0.85, 1.15),
      bands: 2 + Math.floor(r() * 3),
      stalks: r() < 0.85 ? 2 : 3,
      seed: Math.floor(r() * 1e9),
    };
  }
  static mutate(g, r) {
    if (r() < 0.4) { g.stalks = g.stalks === 2 ? 3 : 2; return g.stalks === 3 ? 'a third eye-stalk' : 'a return to two eye-stalks'; }
    if (r() < 0.5) { g.bands = clamp(g.bands + (r() < 0.5 ? -1 : 1), 1, 6); return 'a different shell banding'; }
    return super.mutate(g, r);
  }
  get hitR() { return 5; }
  get hitDY() { return 2; }

  constructor(o) {
    super(o);
    this.depth = this.depth || 0; // U below surface when burrowed
  }

  move(world, dt) {
    const U = world.U;
    if (this.trance(world, dt)) { this.y = world.groundY(this.x) + this.depth * U; return; }
    this.timer -= dt;
    const speed = 2.4 * U * (0.7 + 0.3 * this.scale) * (this.stage === 'elder' ? 0.7 : 1);
    switch (this.state) {
      case 'idle':
        if (this.timer <= 0) this.choose(world);
        break;
      case 'walk': {
        const dx = this.tx - this.x;
        if (Math.abs(dx) < U) { this.state = 'idle'; this.timer = rr(1, 5); break; }
        this.dir = Math.sign(dx);
        const nx = this.x + this.dir * speed * dt;
        if (this.depth < 0.5 && world.inPond(nx, 2 * U)) { this.tx = this.x - this.dir * rr(10, 30) * U; this.tx = clamp(this.tx, 4 * U, world.W - 4 * U); break; }
        this.x = nx;
        this.phase += dt * speed / U * 2.4;
        if (this.target && !this.target.gone && Math.abs(this.target.x - this.x) < 1.6 * U) {
          this.state = 'eat'; this.timer = rr(4, 8);
        }
        break;
      }
      case 'eat':
        this.phase += dt * 3;
        if (this.timer <= 0) {
          const it = this.target;
          if (it && !it.gone) {
            world.consumeItem(it);
            this.energy = Math.min(1, this.energy + 0.45 * it.food);
            world.addFert(this.x, 0.12);
            world.particles.burst(this.x, world.groundY(this.x), 5, { type: 'spark', color: P.bone, speed: 10, life: 0.8, g: 30 });
          }
          this.target = null; this.state = 'idle'; this.timer = rr(2, 6);
          this.maybeSplit(world);
        }
        break;
      case 'dig':
        this.depth = Math.min(this.digTo, this.depth + dt * 1.6);
        this.phase += dt * 4;
        if (this.depth >= this.digTo) { this.state = 'tunnel'; }
        if (Math.random() < dt * 6) world.particles.emit({ type: 'spark', x: this.x, y: world.groundY(this.x) + U, vx: rr(-8, 8), vy: rr(-14, -6), g: 40, life: 0.7, size: 1.6, color: world.sky.ground });
        break;
      case 'tunnel': {
        const dx = this.tx - this.x;
        this.dir = Math.sign(dx) || 1;
        this.x += this.dir * speed * 0.6 * dt;
        this.phase += dt * speed / U * 1.6;
        if (Math.abs(dx) < U || world.inPond(this.x + this.dir * 3 * U, 3 * U)) this.state = 'rise';
        break;
      }
      case 'rise':
        this.depth = Math.max(0, this.depth - dt * 2);
        this.phase += dt * 4;
        if (this.depth <= 0) { this.state = 'idle'; this.timer = rr(1, 3); world.particles.burst(this.x, world.groundY(this.x), 6, { type: 'spark', color: world.sky.ground, speed: 12, life: 0.7, g: 40 }); }
        break;
    }
    this.x = clamp(this.x, 3 * U, world.W - 3 * U);
    this.y = world.groundY(this.x) + this.depth * U;
  }

  choose(world) {
    const U = world.U;
    const food = world.nearestItem(this.x, 70 * U, (it) => it.grounded && !it.inWater);
    if (food && (this.energy < 0.85 || Math.random() < 0.5)) {
      this.target = food; this.tx = food.x; this.state = 'walk'; return;
    }
    if (Math.random() < 0.22 && this.adult) {
      this.state = 'dig'; this.digTo = rr(4, 11);
      this.tx = clamp(this.x + rr(-35, 35) * U, 5 * U, world.W - 5 * U);
      if (world.inPond(this.tx, 6 * U)) this.tx = this.x;
      return;
    }
    this.tx = clamp(this.x + rr(-30, 30) * U, 4 * U, world.W - 4 * U);
    this.state = 'walk';
  }

  maybeSplit(world) {
    if (this.adult && this.energy > 0.85 && world.room('scuttler')) {
      this.energy *= 0.5;
      world.birth(this, { x: this.x + this.dir * -3 * world.U, energy: this.energy });
    }
  }

  forage(world, dt) {
    if (this.energy < 0.8 && chance(1 / 1800, dt)) {
      const it = world.items.find((i) => i.grounded && !i.inWater && !i.gone);
      if (it) { world.consumeItem(it); this.energy = Math.min(1, this.energy + 0.45 * it.food); world.addFert(it.x, 0.12); this.maybeSplit(world); }
    }
  }

  draw(ctx, world, amb) {
    const g = this.genome;
    const s = this.scale * world.U;
    const under = this.depth > 0.4;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(s * this.dir, s);
    ctx.lineCap = 'round';
    if (under) {
      // tunnel pocket
      ctx.fillStyle = amb.c(P.ink, 0.35);
      ctx.beginPath(); ctx.ellipse(0, -1.4, 5, 2.6, 0, 0, TAU); ctx.fill();
    }
    const bob = this.state === 'eat' ? Math.sin(this.phase * 4) * 0.25 : 0;
    // legs
    ctx.strokeStyle = amb.c(g.c3, under ? 0.6 : 1);
    ctx.lineWidth = 0.32;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const hx = -1.6 + i * 1.6;
      const sw = Math.sin(this.phase + i * 2.1) * 0.7;
      const lift = Math.max(0, Math.cos(this.phase + i * 2.1)) * 0.5;
      ctx.moveTo(hx, -0.9);
      ctx.lineTo(hx + sw * 0.5 + 0.4, -1.3 - lift);
      ctx.lineTo(hx + sw, -lift);
    }
    ctx.stroke();
    // shell
    ctx.fillStyle = amb.c(g.c1, under ? 0.7 : 1);
    ctx.beginPath();
    ctx.moveTo(-3.2, -0.8 + bob);
    ctx.bezierCurveTo(-3.0, -4.0 + bob, 2.6, -4.2 + bob, 3.2, -0.8 + bob);
    ctx.closePath();
    ctx.fill();
    // bands
    ctx.strokeStyle = amb.c(g.c2, under ? 0.5 : 0.85);
    ctx.lineWidth = 0.38;
    ctx.beginPath();
    for (let k = 0; k < g.bands; k++) {
      const x = -2 + (k + 0.5) * (4 / g.bands);
      ctx.moveTo(x - 0.4, -0.9 + bob);
      ctx.quadraticCurveTo(x + 0.4, -2.4 + bob, x, -3.2 + Math.abs(x) * 0.3 + bob);
    }
    ctx.stroke();
    // rim
    ctx.fillStyle = amb.c(g.c3, under ? 0.6 : 0.9);
    ctx.fillRect(-3.3, -1.0 + bob, 6.6, 0.45);
    // head + eye stalks
    ctx.fillStyle = amb.c(g.c2, under ? 0.6 : 1);
    ctx.beginPath(); ctx.ellipse(3.2, -1.2 + bob, 1.0, 0.8, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = amb.c(g.c3);
    ctx.lineWidth = 0.22;
    const look = Math.sin(world.t * 0.9 + this.phase) * 0.3;
    for (let k = 0; k < g.stalks; k++) {
      const ex = 3.5 + k * 0.45 + look, ey = -3.0 - (k === 1 ? 0.5 : 0) + bob;
      ctx.beginPath(); ctx.moveTo(3.3, -1.6 + bob); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = amb.c(P.cream);
      ctx.beginPath(); ctx.arc(ex, ey, 0.42, 0, TAU); ctx.fill();
      ctx.fillStyle = amb.c(P.ink);
      ctx.beginPath(); ctx.arc(ex + 0.12, ey, 0.2, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  drawGlow(ctx, world) {
    if (world.night < 0.1) return;
    const s = this.scale * world.U;
    drawGlow(ctx, this.genome.eye, this.x + this.dir * 3.7 * s, this.y - 3.1 * s, 2.2 * s, world.night * 0.7);
  }
}

// ---------------------------------------------------------------- petalmoth
export class Petalmoth extends Creature {
  static kind = 'petalmoth';
  static lifeRange = [5 * HR, 9 * HR];
  static mature = 30 * 60;
  static metabolism = 3 * HR;
  static randomGenome(r) {
    return {
      c1: pick([P.salmon, P.coral, P.peach, P.rose, P.lilac, P.mint, P.cream], r),
      c2: pick([P.teal, P.plum, P.rust, P.deepteal, P.mauve], r),
      c3: pick([P.ink, P.plum, P.deepteal], r),
      glow: pick([P.glowLime, P.glowAmber, P.glowPink, P.glowCyan], r),
      size: rr(0.85, 1.2),
      wings: r() < 0.88 ? 4 : 6,
      flap: rr(7, 11),
      seed: Math.floor(r() * 1e9),
    };
  }
  static mutate(g, r) {
    if (r() < 0.35) { g.wings = g.wings === 4 ? 6 : 4; return g.wings === 6 ? 'a third pair of wings' : 'a return to four wings'; }
    if (r() < 0.3) { g.glow = pick(FAMILIES.glow, r); return 'a new glow'; }
    return super.mutate(g, r);
  }
  get hitR() { return 6; }

  constructor(o) {
    super(o);
    this.state = this.state === 'idle' ? 'fly' : this.state;
    this.tx = this.tx ?? this.x; this.ty = this.ty ?? this.y;
  }

  pickTarget(world) {
    const U = world.U;
    this.target = null; this.perch = null;
    if (world.focusPod && Math.random() < 0.25) {
      const p = world.focusPod;
      this.tx = p.x + rr(-8, 8) * U; this.ty = p.y - rr(6, 18) * U; this.state = 'fly'; this.timer = rr(6, 14); return;
    }
    if (this.energy < 0.75 || Math.random() < 0.35) {
      let best = null, bd = Infinity;
      for (const p of world.flora) {
        if (p.kind !== 'lanternlily' || p.growth < 0.5 || p.nectar < 0.25 || p.wither > 0.4) continue;
        const d = Math.abs(p.x - this.x) + Math.random() * 60 * U;
        if (d < bd) { bd = d; best = p; }
      }
      if (best) { this.target = best; this.state = 'fly'; return; }
    }
    if (Math.random() < 0.2 + world.night * 0.25) {
      // rest on the clock ring
      const c = world.clock;
      const a = rr(-Math.PI * 0.95, -Math.PI * 0.05);
      this.perch = a; this.tx = c.cx + Math.cos(a) * c.R; this.ty = c.cy + Math.sin(a) * c.R; this.state = 'fly'; return;
    }
    this.tx = rr(6 * U, world.W - 6 * U);
    this.ty = rr(world.H * 0.22, world.groundBase - 12 * U);
    this.state = 'fly';
    this.timer = rr(5, 12);
  }

  move(world, dt) {
    const U = world.U;
    if (this.trance(world, dt)) {
      const m = world.mindPulse;
      if (m) { this.dir = Math.sign(m.x - this.x) || 1; }
      this.flapT = (this.flapT || 0) + dt * 2;
      return;
    }
    this.timer -= dt;
    const flapRate = this.genome.flap;
    if (this.state === 'fly') {
      if (this.target) { const p = this.target.tip(world); this.tx = p.x; this.ty = p.y + 3.2 * U; }
      if (this.perch != null) { const c = world.clock; this.tx = c.cx + Math.cos(this.perch) * c.R; this.ty = c.cy + Math.sin(this.perch) * c.R - 1.2 * U * this.scale; }
      const dx = this.tx - this.x, dy = this.ty - this.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = 11 * U * (this.stage === 'elder' ? 0.75 : 1);
      const wob = fbm(world.t * 0.6 + this.phase, 3) * 9 * U;
      const near = d < 2.2 * U;
      const k = near ? 0.6 : 1;
      this.vx = lerp(this.vx, (dx / d) * sp * k, Math.min(1, dt * 1.6));
      this.vy = lerp(this.vy, (dy / d) * sp * k + wob * 0.6, Math.min(1, dt * 1.6));
      if (near) {
        if (this.target) { this.state = 'feed'; this.timer = rr(6, 12); }
        else if (this.perch != null) { this.state = 'perch'; this.timer = rr(25, 90); }
        else if (this.timer <= 0) this.pickTarget(world);
        else this.pickTarget(world);
      }
      if (this.timer < -20) this.pickTarget(world);
      this.flapT = (this.flapT || 0) + dt * flapRate;
    } else if (this.state === 'feed') {
      const t = this.target;
      if (!t || t.dead) { this.pickTarget(world); return; }
      const p = t.tip(world);
      this.vx = (p.x + Math.sin(world.t * 2 + this.phase) * 1.2 * U - this.x) * 3;
      this.vy = (p.y + 3.2 * U - this.y) * 3;
      this.flapT = (this.flapT || 0) + dt * flapRate * 0.8;
      if (this.timer <= 0) {
        this.energy = Math.min(1, this.energy + 0.35 * t.nectar);
        t.nectar = Math.max(0, t.nectar - 0.4);
        world.pollinate(this);
        this.maybeLay(world);
        this.pickTarget(world);
      }
    } else if (this.state === 'perch') {
      const c = world.clock;
      this.x = c.cx + Math.cos(this.perch) * c.R; this.y = c.cy + Math.sin(this.perch) * c.R - 1.2 * U * this.scale;
      this.vx = this.vy = 0;
      this.flapT = (this.flapT || 0) + dt * 0.8;
      if (this.timer <= 0) { this.pickTarget(world); this.vy = -6 * U; }
      return;
    } else {
      this.pickTarget(world);
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (Math.abs(this.vx) > 0.5 * U) this.dir = Math.sign(this.vx);
    const gy = world.groundY(this.x) - 2 * U;
    if (this.y > gy) { this.y = gy; this.vy = -Math.abs(this.vy); }
    this.x = clamp(this.x, 2 * U, world.W - 2 * U);
    this.y = clamp(this.y, world.H * 0.08, gy);
  }

  maybeLay(world) {
    if (!this.adult || this.energy < 0.8 || !world.room('petalmoth')) return;
    const hosts = world.flora.filter((p) => (p.kind === 'fanfern' || p.kind === 'bulbstalk' || p.kind === 'coilspire') && p.growth > 0.6 && !p.wither);
    if (!hosts.length) return;
    const h = pick(hosts);
    this.energy -= 0.45;
    const gy = world.groundY(h.x);
    world.layEgg(this, { x: h.x + rr(-1.5, 1.5) * world.U, y: gy - h.height * world.U * rr(0.35, 0.7), hatch: rr(30, 55) * 60, host: h.id });
  }

  forage(world, dt) {
    if (this.energy < 0.8 && chance(1 / 900, dt)) {
      const lily = world.flora.find((p) => p.kind === 'lanternlily' && p.nectar > 0.3 && p.growth > 0.5);
      if (lily) { lily.nectar -= 0.4; this.energy = Math.min(1, this.energy + 0.3); world.pollinate(this); this.maybeLay(world); }
    }
  }

  draw(ctx, world, amb) {
    const g = this.genome;
    const s = this.scale * world.U;
    const f = this.state === 'perch' ? 0.55 + 0.45 * Math.sin(this.flapT || 0) : 0.2 + 0.8 * Math.abs(Math.sin(this.flapT || 0));
    const tilt = clamp(this.vy / (20 * world.U), -0.45, 0.45) * this.dir;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(tilt);
    ctx.scale(s * this.dir, s);
    const wingFill = amb.c(g.c1, 0.93);
    const wingEdge = amb.c(mixHex(g.c1, P.ink, 0.45), 0.8);
    const wing = (cx, cy, rx, ry, rot) => {
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, rot, 0, TAU);
      ctx.fillStyle = wingFill; ctx.fill();
      ctx.strokeStyle = wingEdge; ctx.lineWidth = 0.16; ctx.stroke();
    };
    const eye = (cx, cy, r) => {
      if (r < 0.15) return;
      ctx.fillStyle = amb.c(g.c2);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
      ctx.fillStyle = amb.c(P.cream);
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, TAU); ctx.fill();
      ctx.fillStyle = amb.c(P.ink);
      ctx.beginPath(); ctx.arc(cx + r * 0.1, cy, r * 0.28, 0, TAU); ctx.fill();
    };
    for (const sgn of [-1, 1]) {
      const ff = f * sgn;
      if (g.wings === 6) wing(-1.9, ff * 1.0, 0.8, Math.abs(ff) * 1.05 + 0.1, sgn * 0.7);
      wing(-0.8, ff * 1.6, 1.15, Math.abs(ff) * 1.65 + 0.1, sgn * -0.45);
      wing(0.5, ff * 2.3, 1.45, Math.abs(ff) * 2.35 + 0.12, sgn * 0.35);
      eye(0.55, ff * 2.6, Math.abs(f) * 0.62);
    }
    // body
    ctx.fillStyle = amb.c(g.c3);
    ctx.beginPath(); ctx.ellipse(0, 0, 1.7, 0.5, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = amb.c(g.c1, 0.9);
    ctx.fillRect(-1.0, -0.12, 0.25, 0.24); ctx.fillRect(-0.4, -0.12, 0.25, 0.24);
    // antennae
    ctx.strokeStyle = amb.c(g.c3);
    ctx.lineWidth = 0.14;
    ctx.beginPath();
    ctx.moveTo(1.5, -0.1); ctx.quadraticCurveTo(2.5, -0.6, 2.8, -1.5);
    ctx.moveTo(1.5, 0.1); ctx.quadraticCurveTo(2.7, -0.2, 3.2, -0.9);
    ctx.stroke();
    ctx.fillStyle = amb.c(g.c2);
    ctx.fillRect(2.65, -1.65, 0.35, 0.35); ctx.fillRect(3.05, -1.05, 0.35, 0.35);
    ctx.restore();
  }

  drawGlow(ctx, world) {
    if (world.night < 0.08) return;
    const s = this.scale * world.U;
    drawGlow(ctx, this.genome.glow, this.x, this.y, 3.2 * s, world.night * 0.85);
  }
}

// ---------------------------------------------------------------- bellwisp
export class Bellwisp extends Creature {
  static kind = 'bellwisp';
  static lifeRange = [3.5 * HR, 7 * HR];
  static mature = 25 * 60;
  static metabolism = 5 * HR;
  static randomGenome(r) {
    return {
      c1: pick([P.cream, P.peach, P.mint, P.lilac, P.salmon, P.bone], r),
      c2: pick([P.coral, P.rust, P.teal, P.mauve, P.rose], r),
      c3: pick([P.plum, P.deepteal, P.rust, P.ink], r),
      glow: pick([P.glowCyan, P.glowPink, P.glowViolet, P.glowLime], r),
      size: rr(0.85, 1.2),
      tendrils: 3 + Math.floor(r() * 3),
      spots: 3 + Math.floor(r() * 5),
      len: rr(9, 15),
      seed: Math.floor(r() * 1e9),
    };
  }
  static mutate(g, r) {
    if (r() < 0.4) { g.tendrils = clamp(g.tendrils + (r() < 0.5 ? -1 : 1), 2, 7); return `${g.tendrils} tendrils`; }
    if (r() < 0.3) { g.len *= 1.4; return 'unusually long tendrils'; }
    return super.mutate(g, r);
  }
  get hitR() { return 6; }

  move(world, dt) {
    const U = world.U;
    if (this.homeY == null || !isFinite(this.homeY)) this.homeY = rr(world.H * 0.12, world.groundBase - 28 * U);
    if (this.trance(world, dt)) { this.vx *= 0.95; this.vy *= 0.95; }
    const t = world.t;
    const wantX = fbm(t * 0.03 + this.phase * 5, 9) * 5 * U;
    const bob = Math.sin(t * 0.45 + this.phase) * 3 * U;
    this.vx = lerp(this.vx, wantX + world.gust * 6 * U, dt * 0.4);
    this.vy = lerp(this.vy, bob + (this.homeY - this.y) * 0.05, dt * 0.5);
    // soft walls: steer back well before the glass
    const pad = 14 * U;
    if (this.x < pad) this.vx += (pad - this.x) * dt * 0.8; else if (this.x > world.W - pad) this.vx -= (this.x - (world.W - pad)) * dt * 0.8;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.x = clamp(this.x, 6 * U, world.W - 6 * U);
    this.y = clamp(this.y, world.H * 0.07, world.groundBase - 22 * U);
    if (Math.random() < dt / 120) this.homeY = rr(world.H * 0.12, world.groundBase - 28 * U);
    this.tilt = clamp(this.vx / (15 * U), -0.3, 0.3);
  }

  lifeTick(world, dt) {
    this.energy += dt / (3 * HR) * (1 - world.night) * 0.9;
    this.energy = Math.min(1, this.energy);
    if (this.age + dt >= this.life) { this.burst(world); return; }
    super.lifeTick(world, dt);
  }

  burst(world) {
    const U = world.U;
    const n = this.energy > 0.6 ? 3 : this.energy > 0.3 ? 2 : 1;
    if (!world.offline) {
      world.particles.burst(this.x, this.y, 22, { type: 'spark', color: this.genome.c1, glow: this.genome.glow, speed: 14 * U, life: 2.2, size: 2, g: -4, drag: 1.4 });
      world.particles.emit({ type: 'ring', x: this.x, y: this.y, size: 2 * U, grow: 14 * U, life: 1.4, color: this.genome.c2 });
    }
    for (let i = 0; i < n; i++) {
      if (!world.room('bellwisp')) break;
      world.layEgg(this, { x: this.x + rr(-4, 4) * U, y: this.y + rr(-4, 4) * U, hatch: rr(15, 35) * 60, float: true });
    }
    world.killFauna(this, 'burst');
  }

  draw(ctx, world, amb) {
    const g = this.genome;
    const s = this.scale * world.U;
    const t = world.t;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.tilt || 0);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    // tendrils
    ctx.strokeStyle = amb.c(g.c2, 0.75);
    ctx.lineWidth = 0.28;
    const n = g.tendrils;
    for (let i = 0; i < n; i++) {
      const bx = (i - (n - 1) / 2) * (3.6 / Math.max(1, n - 1));
      let x = bx, y = 3.0;
      ctx.beginPath(); ctx.moveTo(x, y);
      const segs = 7;
      const L = g.len * (i % 2 ? 0.8 : 1);
      for (let k = 1; k <= segs; k++) {
        const q = k / segs;
        x = bx * (1 + q * 0.4) + Math.sin(t * 1.3 + i * 1.7 + k * 0.7 + this.phase) * q * 1.6 - (this.vx / world.U) * q * 0.35;
        y = 3.0 + q * L;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = amb.c(g.c3, 0.85);
      ctx.beginPath(); ctx.arc(x, y, 0.35, 0, TAU); ctx.fill();
    }
    const breathe = 1 + Math.sin(t * 0.9 + this.phase) * 0.04;
    ctx.scale(breathe, 1 / breathe);
    // bladder
    ctx.fillStyle = amb.c(g.c1, 0.82);
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.bezierCurveTo(2.3, -4, 3.3, -0.6, 2.8, 1.9);
    ctx.quadraticCurveTo(1.8, 3.4, 0, 3.3);
    ctx.quadraticCurveTo(-1.8, 3.4, -2.8, 1.9);
    ctx.bezierCurveTo(-3.3, -0.6, -2.3, -4, 0, -4);
    ctx.fill();
    ctx.strokeStyle = amb.c(mixHex(g.c1, P.ink, 0.4), 0.7);
    ctx.lineWidth = 0.18;
    ctx.stroke();
    // veins
    ctx.strokeStyle = amb.c(g.c3, 0.22);
    ctx.beginPath();
    ctx.moveTo(-1.2, -3.4); ctx.quadraticCurveTo(-2.2, 0, -1.5, 3.1);
    ctx.moveTo(1.2, -3.4); ctx.quadraticCurveTo(2.2, 0, 1.5, 3.1);
    ctx.moveTo(0, -4); ctx.lineTo(0, 3.3);
    ctx.stroke();
    // organ
    ctx.fillStyle = amb.c(g.c2, 0.78);
    ctx.beginPath(); ctx.ellipse(0, 0.9, 1.25, 1.75, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = amb.c(g.c3, 0.9);
    ctx.beginPath(); ctx.arc(0, 0.5, 0.45, 0, TAU); ctx.fill();
    // spots
    if (!this._spots) {
      const r = mulberry32(g.seed);
      this._spots = [];
      for (let i = 0; i < g.spots; i++) {
        const a = r() * TAU, d = 0.5 + r() * 0.45;
        this._spots.push([Math.cos(a) * 2.3 * d, -1 + Math.sin(a) * 2.4 * d, 0.18 + r() * 0.3]);
      }
    }
    ctx.fillStyle = amb.c(g.c3, 0.7);
    for (const [x, y, r] of this._spots) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
    // crown
    ctx.fillStyle = amb.c(g.c2, 0.9);
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath(); ctx.ellipse(k * 0.7, -4.3 + Math.abs(k) * 0.25, 0.32, 0.75, k * 0.5, 0, TAU); ctx.fill();
    }
    // lower lip scallops
    ctx.fillStyle = amb.c(g.c2, 0.65);
    for (let k = -2; k <= 2; k++) { ctx.beginPath(); ctx.arc(k * 0.75, 3.15 - Math.abs(k) * 0.12, 0.4, 0, Math.PI); ctx.fill(); }
    ctx.restore();
  }

  drawGlow(ctx, world) {
    const s = this.scale * world.U;
    const k = 0.15 + world.night * 0.75;
    drawGlow(ctx, this.genome.glow, this.x, this.y + 0.9 * s, 4.5 * s, k * (0.4 + this.energy * 0.6));
  }
}

// ---------------------------------------------------------------- ribbonfin
export class Ribbonfin extends Creature {
  static kind = 'ribbonfin';
  static lifeRange = [26 * HR, 48 * HR];
  static mature = 2 * HR;
  static metabolism = 14 * HR;
  static randomGenome(r) {
    return {
      c1: pick([P.coral, P.salmon, P.cream, P.lilac, P.amber, P.mint], r),
      c2: pick([P.teal, P.mauve, P.rose, P.sea, P.plum], r),
      c3: pick([P.ink, P.plum, P.deepteal], r),
      glow: pick([P.glowCyan, P.glowViolet, P.glowPink], r),
      size: rr(0.85, 1.2),
      ribbon: rr(6, 10),
      frills: 4 + Math.floor(r() * 4),
      seed: Math.floor(r() * 1e9),
    };
  }
  static mutate(g, r) {
    if (r() < 0.5) { g.ribbon *= 1.35; return 'an extravagant ribbon'; }
    return super.mutate(g, r);
  }
  get hitR() { return 6; }

  move(world, dt) {
    const U = world.U, p = world.pond;
    this.timer -= dt;
    if (this.state === 'jump') {
      this.vy += 34 * U * dt;
      this.x += this.vx * dt; this.y += this.vy * dt;
      this.ang = Math.atan2(this.vy, this.vx * this.dir) * this.dir;
      if (this.vy > 0 && this.y > p.y) {
        this.state = 'swim'; this.vy *= 0.3;
        world.splash(this.x, p.y, 1);
      }
      return;
    }
    if (this.trance(world, dt)) { this.vx *= 0.9; this.vy *= 0.9; }
    else {
      if (this.timer <= 0 || dist2(this.x, this.y, this.tx || 0, this.ty || 0) < (2 * U) ** 2) {
        this.tx = rr(p.x0 + 4 * U, p.x1 - 4 * U);
        const bot = world.pondBottom(this.tx);
        this.ty = rr(p.y + 2.5 * U, Math.max(p.y + 3 * U, bot - 2.5 * U));
        this.timer = rr(3, 9);
        if (this.adult && this.energy > 0.5 && !world.offline && Math.random() < 0.06) {
          this.state = 'jump';
          this.dir = Math.random() < 0.5 ? -1 : 1;
          if (this.x < p.x0 + (p.x1 - p.x0) * 0.3) this.dir = 1;
          if (this.x > p.x1 - (p.x1 - p.x0) * 0.3) this.dir = -1;
          this.y = p.y + 0.5 * U;
          this.vx = this.dir * rr(5, 9) * U; this.vy = -rr(15, 22) * U;
          world.splash(this.x, p.y, 0.7);
          this.energy -= 0.05;
          return;
        }
      }
      const dx = this.tx - this.x, dy = this.ty - this.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = 4.5 * U;
      this.vx = lerp(this.vx, dx / d * sp, dt * 0.9);
      this.vy = lerp(this.vy, dy / d * sp * 0.6, dt * 0.9);
    }
    this.x += this.vx * dt; this.y += this.vy * dt;
    if (Math.abs(this.vx) > 0.3 * U) this.dir = Math.sign(this.vx);
    this.x = clamp(this.x, p.x0 + 3 * U, p.x1 - 3 * U);
    const bot = world.pondBottom(this.x);
    this.y = clamp(this.y, p.y + 2 * U, Math.max(p.y + 2.2 * U, bot - 1.5 * U));
    this.ang = clamp(this.vy / (6 * U), -0.5, 0.5) * this.dir;
    this.swim = (this.swim || 0) + dt * (2 + Math.hypot(this.vx, this.vy) / U * 0.5);
  }

  lifeTick(world, dt) {
    // plankton, richer when the pond's soil is rich, plus fruit that sinks in
    this.energy = Math.min(1, this.energy + dt / (9 * HR) * (0.6 + world.fertAt(world.pond.cx)));
    if (this.energy < 0.75 && chance(1 / 600, dt)) {
      const it = world.items.find((i) => i.inWater && !i.gone);
      if (it) { world.consumeItem(it); this.energy = Math.min(1, this.energy + 0.4 * it.food); }
    }
    super.lifeTick(world, dt);
    if (this.adult && this.energy > 0.8 && chance(1 / (3 * HR), dt) && world.room('ribbonfin')) {
      this.energy -= 0.4;
      const p = world.pond;
      const x = rr(p.x0 + 6 * world.U, p.x1 - 6 * world.U);
      world.layEgg(this, { x, y: world.pondBottom(x) - 1.2 * world.U, hatch: rr(50, 90) * 60, water: true });
    }
  }

  draw(ctx, world, amb) {
    const g = this.genome;
    const s = this.scale * world.U;
    const t = this.swim || 0;
    const inAir = this.state === 'jump';
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.ang || 0);
    ctx.scale(s * this.dir, s);
    ctx.lineCap = 'round';
    const a = inAir ? 1 : 0.88;
    // ribbon tail
    ctx.strokeStyle = amb.c(g.c2, a * 0.85);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    const L = g.ribbon;
    for (let k = 1; k <= 8; k++) {
      const q = k / 8;
      ctx.lineTo(-2 - q * L, Math.sin(t * 2.2 - q * 5) * q * 1.6);
    }
    ctx.stroke();
    ctx.lineWidth = 0.35;
    ctx.strokeStyle = amb.c(g.c1, a * 0.6);
    ctx.stroke();
    // body
    ctx.fillStyle = amb.c(g.c1, a);
    ctx.beginPath();
    ctx.moveTo(3.2, 0);
    ctx.quadraticCurveTo(1.2, -1.5, -2.2, -0.45);
    ctx.lineTo(-2.2, 0.45);
    ctx.quadraticCurveTo(1.2, 1.5, 3.2, 0);
    ctx.fill();
    // frills
    ctx.fillStyle = amb.c(g.c2, a * 0.9);
    for (let k = 0; k < g.frills; k++) {
      const x = 1.6 - k * (3.6 / g.frills);
      const h = 0.7 + Math.sin(t * 3 + k) * 0.25;
      ctx.beginPath(); ctx.ellipse(x, -1.0 + Math.abs(x) * 0.12, 0.3, h, 0.3, 0, TAU); ctx.fill();
    }
    // flank seam + eye
    ctx.strokeStyle = amb.c(g.c3, 0.5);
    ctx.lineWidth = 0.15;
    ctx.beginPath(); ctx.moveTo(2.4, 0.2); ctx.lineTo(-2, 0.1); ctx.stroke();
    ctx.fillStyle = amb.c(P.cream);
    ctx.beginPath(); ctx.arc(2.15, -0.25, 0.32, 0, TAU); ctx.fill();
    ctx.fillStyle = amb.c(P.ink);
    ctx.beginPath(); ctx.arc(2.25, -0.25, 0.17, 0, TAU); ctx.fill();
    ctx.restore();
  }

  drawGlow(ctx, world) {
    if (world.night < 0.1) return;
    const s = this.scale * world.U;
    drawGlow(ctx, this.genome.glow, this.x, this.y, 3.5 * s, world.night * 0.55);
  }
}

// ---------------------------------------------------------------- stiltstrider
export class Stiltstrider extends Creature {
  static kind = 'stiltstrider';
  static lifeRange = [36 * HR, 72 * HR];
  static mature = 4 * HR;
  static metabolism = 14 * HR;
  static randomGenome(r) {
    return {
      c1: pick([P.sand, P.ochre, P.teal, P.salmon, P.bone, P.mauve], r),
      c2: pick([P.rust, P.plum, P.deepteal, P.coral, P.olive], r),
      c3: pick([P.cream, P.peach, P.mint], r),
      c4: pick([P.coral, P.rose, P.amber, P.lilac, P.sea], r),
      eye: pick([P.glowCyan, P.glowAmber, P.glowLime], r),
      size: rr(0.9, 1.15),
      legs: r() < 0.85 ? 4 : 6,
      leg: rr(10, 13),
      neck: rr(6, 8.5),
      stripes: 3 + Math.floor(r() * 4),
      eyes: 4 + Math.floor(r() * 4),
      seed: Math.floor(r() * 1e9),
    };
  }
  static mutate(g, r) {
    if (r() < 0.3) { g.legs = g.legs === 4 ? 6 : 4; return g.legs === 6 ? 'six legs' : 'a return to four legs'; }
    if (r() < 0.35) { g.leg *= 1.18; return 'longer legs'; }
    if (r() < 0.4) { g.eyes = clamp(g.eyes + 2, 3, 10); return 'extra eyes around the cup'; }
    return super.mutate(g, r);
  }
  get hitR() { return 9; }
  get hitDY() { return this.genome.leg * 0.8; }

  constructor(o) {
    super(o);
    this.rest = this.rest || 0;
    this.headOpen = 0.3;
    this.gait = this.gait || 0;
  }

  move(world, dt) {
    const U = world.U;
    this.timer -= dt;
    const sleepy = world.night > 0.7 && this.state !== 'eat';
    this.rest = lerp(this.rest, sleepy ? 1 : 0, dt * 0.25);
    this.headOpen = lerp(this.headOpen, this.state === 'eat' ? 1 : 0.35 - this.rest * 0.3, dt * 2);
    if (this.trance(world, dt)) { this.reach = null; return; }
    if (sleepy) { this.state = 'idle'; this.reach = null; return; }
    const sp = 2.6 * U * this.scale * (this.stage === 'elder' ? 0.7 : 1);
    switch (this.state) {
      case 'idle':
        if (this.timer <= 0) this.choose(world);
        break;
      case 'walk': {
        const dx = this.tx - this.x;
        if (Math.abs(dx) < U) {
          if (this.target && !this.target.gone && !this.target.dead) { this.state = 'eat'; this.timer = rr(5, 9); this.dir = Math.sign(this.foodX() - this.x) || this.dir; }
          else { this.state = 'idle'; this.timer = rr(3, 10); }
          break;
        }
        this.dir = Math.sign(dx);
        const nx = this.x + this.dir * sp * dt;
        if (world.inPond(nx, 4 * U)) { this.state = 'idle'; this.timer = 2; this.target = null; this.tx = this.x; break; }
        this.x = nx;
        this.gait += dt * sp / U * 0.55;
        break;
      }
      case 'eat': {
        const fx = this.foodX(), fy = this.foodY(world);
        this.reach = fx != null ? [fx, fy] : null;
        if (this.timer <= 0) {
          const t = this.target;
          if (t && t.kind === 'bulbstalk' && t.ripe > 0.5) { this.energy = Math.min(1, this.energy + 0.5 * t.ripe); t.ripe = 0; world.particles.burst(fx, fy, 6, { type: 'spark', color: t.genome.c3, speed: 8 * U, life: 1, g: 30 }); }
          else if (t && t.food) { world.consumeItem(t); this.energy = Math.min(1, this.energy + 0.4); }
          this.target = null; this.reach = null; this.state = 'idle'; this.timer = rr(4, 12);
          this.maybeLay(world);
        }
        break;
      }
    }
    this.x = clamp(this.x, 8 * U, world.W - 8 * U);
    this.y = world.groundY(this.x);
  }

  foodX() { const t = this.target; if (!t) return null; return t.kind === 'bulbstalk' ? t._tipX : t.x; }
  foodY(world) { const t = this.target; if (!t) return null; if (t.kind === 'bulbstalk') { const p = t.tip(world); t._tipX = p.x; return p.y; } return t.y; }

  choose(world) {
    const U = world.U;
    if (this.energy < 0.9 || Math.random() < 0.3) {
      let best = null, bd = Infinity;
      for (const p of world.flora) {
        if (p.kind !== 'bulbstalk' || p.ripe < 0.55 || p.wither > 0.3) continue;
        const d = Math.abs(p.x - this.x);
        if (d < bd) { bd = d; best = p; }
      }
      const fruit = world.nearestItem(this.x, 80 * U, (i) => i.type === 'fruit' && i.grounded && !i.inWater);
      if (fruit && (!best || Math.abs(fruit.x - this.x) < bd)) best = fruit;
      if (best) {
        const tip = best.kind === 'bulbstalk' ? best.tip(world) : best;
        best._tipX = tip.x;
        const side = this.x < tip.x ? -1 : 1;
        this.target = best;
        this.tx = clamp(tip.x + side * this.genome.neck * 0.9 * U * this.scale, 8 * U, world.W - 8 * U);
        if (world.inPond(this.tx, 4 * U)) { this.target = null; } else { this.state = 'walk'; return; }
      }
    }
    this.target = null;
    this.tx = clamp(this.x + rr(-40, 40) * U, 8 * U, world.W - 8 * U);
    if (world.inPond(this.tx, 6 * U)) this.tx = this.x - (this.tx - this.x);
    this.state = 'walk';
  }

  maybeLay(world) {
    if (!this.adult || this.energy < 0.85 || !world.room('stiltstrider') || this.stage === 'elder') return;
    this.energy -= 0.45;
    world.layEgg(this, { x: this.x - this.dir * 4 * world.U, y: world.groundY(this.x - this.dir * 4 * world.U), hatch: rr(90, 150) * 60 });
  }

  forage(world, dt) {
    if (this.energy < 0.85 && chance(1 / 2400, dt)) {
      const b = world.flora.find((p) => p.kind === 'bulbstalk' && p.ripe > 0.55);
      if (b) { this.energy = Math.min(1, this.energy + 0.5 * b.ripe); b.ripe = 0; this.maybeLay(world); }
    }
  }

  draw(ctx, world, amb) {
    const g = this.genome;
    const s = this.scale * world.U;
    const rest = this.rest;
    const legH = g.leg * (1 - rest * 0.62);
    const bob = Math.abs(Math.sin(this.gait * Math.PI)) * 0.35 * (1 - rest);
    const bodyY = -legH - bob;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(s * this.dir, s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pairs = g.legs / 2;
    const hips = pairs === 3 ? [-2.6, 0, 2.6] : [-2.4, 2.4];
    const leg = (hx, ph, far) => {
      const stride = 2.0 * (1 - rest);
      const fx = hx + Math.sin(ph) * stride - rest * hx * 0.2;
      const lift = Math.max(0, Math.cos(ph)) * 1.1 * (1 - rest);
      const fy = -lift;
      const hy = bodyY + 1.4;
      const mx = (hx + fx) / 2, my = (hy + fy) / 2;
      const kx = mx - 1.1 - rest * 2.2, ky = my - 0.4 - rest * 1.0;
      ctx.strokeStyle = amb.c(far ? mixHex(g.c2, P.ink, 0.35) : g.c2);
      ctx.lineWidth = far ? 0.5 : 0.6;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
      ctx.fillStyle = amb.c(g.c2);
      ctx.beginPath(); ctx.ellipse(fx + 0.3, fy, 0.6, 0.25, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = amb.c(g.c3, 0.9);
      ctx.beginPath(); ctx.arc(kx, ky, 0.32, 0, TAU); ctx.fill();
    };
    hips.forEach((hx, i) => leg(hx + 0.4, this.gait * Math.PI + i * 1.3 + Math.PI, true));
    // tail tuft
    ctx.strokeStyle = amb.c(g.c4, 0.9);
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const sw = Math.sin(world.t * 1.2 + k) * 0.4;
      ctx.moveTo(-4.8, bodyY - 0.3); ctx.quadraticCurveTo(-6, bodyY + 0.5 + k * 0.4, -6.2 + sw, bodyY + 1.8 + k * 0.5);
    }
    ctx.stroke();
    // body
    ctx.fillStyle = amb.c(g.c1);
    ctx.beginPath(); ctx.ellipse(0, bodyY, 5, 3, 0, 0, TAU); ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = amb.c(g.c2, 0.85);
    for (let k = 0; k < g.stripes; k++) {
      const x = -4 + (k + 0.5) * (8 / g.stripes);
      ctx.beginPath();
      ctx.moveTo(x - 0.3, bodyY - 3.2);
      ctx.quadraticCurveTo(x + 0.9, bodyY, x - 0.2, bodyY + 3.2);
      ctx.lineTo(x + 0.45, bodyY + 3.2);
      ctx.quadraticCurveTo(x + 1.5, bodyY, x + 0.35, bodyY - 3.2);
      ctx.fill();
    }
    ctx.fillStyle = amb.c(g.c3, 0.55);
    ctx.beginPath(); ctx.ellipse(0.3, bodyY + 2.0, 4.2, 1.3, 0, 0, TAU); ctx.fill();
    ctx.restore();
    // dorsal studs
    ctx.fillStyle = amb.c(g.c4);
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(-2.4 + k * 1.5, bodyY - 3.0 + Math.abs(k - 1.5) * 0.25, 0.35, 0, TAU); ctx.fill(); }
    // neck + head
    let hx = 4.6 + g.neck * 0.45, hy = bodyY - g.neck * (0.95 - rest * 0.7);
    if (this.reach) {
      const lx = (this.reach[0] - this.x) / s * this.dir;
      const ly = (this.reach[1] - this.y) / s;
      const d = Math.hypot(lx - 4, ly - bodyY);
      const maxR = g.neck * 1.25;
      const k = d > maxR ? maxR / d : 1;
      hx = lerp(hx, 4 + (lx - 4) * k - 0.6, 0.85);
      hy = lerp(hy, bodyY + (ly - bodyY) * k + 0.4, 0.85);
    }
    hy += Math.sin(world.t * 0.8 + this.phase) * 0.3;
    this._hx = lerp(this._hx ?? hx, hx, 0.15); this._hy = lerp(this._hy ?? hy, hy, 0.15);
    hx = this._hx; hy = this._hy;
    ctx.strokeStyle = amb.c(g.c1);
    ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(3.6, bodyY - 1.4); ctx.quadraticCurveTo(5.6, bodyY - 2.5, hx, hy); ctx.stroke();
    ctx.strokeStyle = amb.c(g.c2, 0.7);
    ctx.lineWidth = 0.25;
    ctx.stroke();
    // cup head
    const ang = Math.atan2(hy - (bodyY - 2.5), hx - 5.6);
    const open = this.headOpen;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(ang);
    ctx.fillStyle = amb.c(g.c4);
    ctx.beginPath();
    ctx.moveTo(-0.6, -0.6);
    ctx.quadraticCurveTo(1.2, -0.7, 2.4, -1.2 - open * 1.1);
    ctx.lineTo(2.4, 1.2 + open * 1.1);
    ctx.quadraticCurveTo(1.2, 0.7, -0.6, 0.6);
    ctx.fill();
    const ry = 1.2 + open * 1.1;
    ctx.fillStyle = amb.c(P.ink);
    ctx.beginPath(); ctx.ellipse(2.4, 0, 0.45 + open * 0.35, ry, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = amb.c(g.c3);
    ctx.lineWidth = 0.25;
    ctx.stroke();
    ctx.fillStyle = amb.c(g.c3);
    const ne = g.eyes;
    this._eyeAng = ang;
    for (let k = 0; k < ne; k++) {
      const a = (k / ne) * TAU;
      ctx.beginPath(); ctx.arc(2.4 + Math.cos(a) * 0.15, Math.sin(a) * ry * 0.72, 0.17, 0, TAU); ctx.fill();
    }
    ctx.restore();
    // near legs
    hips.forEach((hx2, i) => leg(hx2, this.gait * Math.PI + i * 1.3, false));
    ctx.restore();
    this._head = [this.x + hx * s * this.dir, this.y + hy * s];
  }

  drawGlow(ctx, world) {
    if (world.night < 0.1 || !this._head) return;
    const s = this.scale * world.U;
    drawGlow(ctx, this.genome.eye, this._head[0] + this.dir * 2 * s, this._head[1], 3 * s, world.night * (0.25 + (1 - this.rest) * 0.4));
  }
}

// ---------------------------------------------------------------- mindbloom
export class Mindbloom extends Creature {
  static kind = 'mindbloom';
  static lifeRange = [40 * HR, 70 * HR];
  static mature = 1.5 * HR;
  static metabolism = 30 * HR;
  static randomGenome(r) {
    return {
      c1: pick([P.lilac, P.rose, P.mauve, P.salmon, P.mint], r),
      c2: pick([P.coral, P.amber, P.teal, P.cream], r),
      c3: pick([P.plum, P.deepteal, P.ink], r),
      glow: pick([P.glowViolet, P.glowPink, P.glowCyan], r),
      size: rr(0.95, 1.15),
      arms: 6 + Math.floor(r() * 3),
      rings: 3 + Math.floor(r() * 2),
      seed: Math.floor(r() * 1e9),
    };
  }
  static mutate(g, r) {
    if (r() < 0.5) { g.rings = clamp(g.rings + 1, 3, 6); return 'another ring in its eye'; }
    return super.mutate(g, r);
  }
  get hitR() { return 9; }

  move(world, dt) {
    const U = world.U;
    if (this.ax == null || this.ax > 1) this.ax = rr(0.12, 0.3);
    this.ax = clamp(this.ax + fbm(world.t * 0.01 + this.phase, 4) * dt * 0.0006, 0.08, 0.34);
    const ax = this.ax * world.W;
    const L = world.H * 0.13 + Math.sin(world.t * 0.21 + this.phase) * 1.5 * U;
    this.x = ax + Math.sin(world.t * 0.3 + this.phase) * 3 * U;
    this.y = world.topInset + L;
    this.timer -= dt;
    this.pulseK = Math.max(0, (this.pulseK || 0) - dt * 0.5);
    if (this.timer <= 0 && this.adult) {
      this.timer = rr(80, 160) * (world.focusPod ? 0.6 : 1);
      this.pulseK = 1;
      world.mindPulse = { x: this.x, y: this.y, age: 0 };
      world.particles.emit({ type: 'ring', x: this.x, y: this.y, size: 5 * U, grow: 11 * U, life: 2.8, drag: 0, color: this.genome.glow });
      world.particles.emit({ type: 'ring', x: this.x, y: this.y, size: 3 * U, grow: 8 * U, life: 2.2, drag: 0, color: this.genome.c1 });
      world.onPulse?.();
    }
    // the eye follows whatever holds attention
    const look = world.focusPod || world.lastTouch;
    this.lookX = lerp(this.lookX || 0, look ? clamp((look.x - this.x) / (40 * U), -1, 1) : Math.sin(world.t * 0.2), dt);
    this.lookY = lerp(this.lookY || 0, look ? clamp((look.y - this.y) / (40 * U), -1, 1) : 0.3, dt);
  }

  lifeTick(world, dt) {
    if (world.focusPod) this.energy = Math.min(1, this.energy + dt / (1.5 * HR));
    super.lifeTick(world, dt);
  }

  draw(ctx, world, amb) {
    const g = this.genome;
    const s = this.scale * world.U;
    const t = world.t;
    // tendril to the glass ceiling
    ctx.strokeStyle = amb.c(g.c3, 0.8);
    ctx.lineWidth = Math.max(1, 0.5 * s);
    ctx.beginPath();
    ctx.moveTo(this.ax * world.W, 0);
    ctx.quadraticCurveTo(this.ax * world.W + Math.sin(t * 0.3 + this.phase) * 6 * world.U, (world.topInset + this.y) * 0.5, this.x, this.y - 3.5 * s);
    ctx.stroke();
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    // arms
    const n = g.arms;
    for (let i = 0; i < n; i++) {
      const bx = (i - (n - 1) / 2) * (7 / (n - 1));
      ctx.strokeStyle = amb.c(i % 2 ? g.c1 : mixHex(g.c1, g.c3, 0.3), 0.9);
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(bx, 2.4);
      let x = bx, y = 2.4;
      const L = 7 + (i % 3) * 1.6;
      for (let k = 1; k <= 6; k++) {
        const q = k / 6;
        x = bx * (1 + q * 0.25) + Math.sin(t * 0.9 + i * 1.1 + k * 0.8) * q * 1.4;
        y = 2.4 + q * L;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = amb.c(g.c2, 0.8);
      ctx.beginPath(); ctx.arc(x, y, 0.35, 0, TAU); ctx.fill();
    }
    // mantle
    const pk = this.pulseK || 0;
    const sw = 1 + pk * 0.08;
    ctx.scale(sw, sw);
    ctx.fillStyle = amb.c(g.c1);
    ctx.beginPath();
    ctx.moveTo(-5, 2.2);
    ctx.bezierCurveTo(-5.6, -3.5, -2.5, -5.2, 0, -5.2);
    ctx.bezierCurveTo(2.5, -5.2, 5.6, -3.5, 5, 2.2);
    for (let k = 4; k >= -4; k--) ctx.quadraticCurveTo(k * 1.2 + 0.6, 3.4, k * 1.2 - 0.1 + (k === -4 ? -0.9 : 0), 2.3);
    ctx.fill();
    ctx.strokeStyle = amb.c(g.c3, 0.5);
    ctx.lineWidth = 0.2;
    ctx.stroke();
    // eye: concentric rings
    const cols = [g.c2, P.ink, g.c1, g.c3, P.cream];
    const ex = (this.lookX || 0) * 0.6, ey = -1 + (this.lookY || 0) * 0.4;
    for (let k = 0; k < g.rings; k++) {
      const r = 3.4 * (1 - k / (g.rings + 0.5));
      ctx.fillStyle = amb.c(cols[k % cols.length]);
      ctx.beginPath(); ctx.arc(ex * (k / g.rings), ey + (k / g.rings) * 0.2, r, 0, TAU); ctx.fill();
    }
    const blink = (Math.sin(t * 0.37 + this.phase) > 0.985) ? 0.1 : 1;
    ctx.fillStyle = amb.c(P.ink);
    ctx.beginPath(); ctx.ellipse(ex, ey + 0.2, 0.3, 1.1 * blink, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }

  drawGlow(ctx, world) {
    const s = this.scale * world.U;
    const k = 0.2 + world.night * 0.4 + (this.pulseK || 0) * 0.6 + (world.focusPod ? 0.2 : 0);
    drawGlow(ctx, this.genome.glow, this.x, this.y - s, 9 * s, Math.min(1, k));
  }
}

export const CREATURES = { scuttler: Scuttler, petalmoth: Petalmoth, bellwisp: Bellwisp, ribbonfin: Ribbonfin, stiltstrider: Stiltstrider, mindbloom: Mindbloom };

// ---------------------------------------------------------------- eggs
export class Egg {
  constructor(o) {
    this.id = uid();
    this.age = 0;
    Object.assign(this, o);
    this.phase = this.phase ?? Math.random() * TAU;
  }
  tick(world, dt) {
    this.age += dt;
    if (this.age >= this.hatch) world.hatch(this);
  }
  move(world, dt) {
    if (this.float) {
      const U = world.U;
      this.x += (fbm(world.t * 0.05 + this.phase, 2) * 3 * U + world.gust * 4 * U) * dt;
      this.y += Math.sin(world.t * 0.5 + this.phase) * 1.2 * U * dt;
      this.x = clamp(this.x, 4 * U, world.W - 4 * U);
      this.y = clamp(this.y, world.H * 0.1, world.groundBase - 20 * U);
    } else if (!this.water && !this.host) {
      this.y = world.groundY(this.x);
    }
  }
  draw(ctx, world, amb) {
    const g = this.genome;
    const U = world.U;
    const k = this.age / this.hatch;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(U, U);
    switch (this.species) {
      case 'petalmoth': {
        const sw = Math.sin(world.t * 0.8 + this.phase) * 0.15;
        ctx.rotate(sw);
        ctx.strokeStyle = amb.c(P.cream, 0.5); ctx.lineWidth = 0.12;
        ctx.beginPath(); ctx.moveTo(0, -1.2); ctx.lineTo(0, 0); ctx.stroke();
        ctx.fillStyle = amb.c(mixHex(g.c1, P.bone, 0.5));
        ctx.beginPath(); ctx.ellipse(0, 1.3, 0.8, 1.4, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = amb.c(g.c2, 0.6); ctx.lineWidth = 0.15;
        ctx.beginPath(); for (let i = 0; i < 3; i++) { ctx.moveTo(-0.7, 0.6 + i * 0.6); ctx.lineTo(0.7, 0.8 + i * 0.6); } ctx.stroke();
        if (k > 0.85) { ctx.fillStyle = amb.c(g.c1); ctx.fillRect(-0.15, 2.4, 0.3, 0.3); }
        break;
      }
      case 'stiltstrider': {
        const wob = k > 0.9 ? Math.sin(world.t * 9) * 0.12 : 0;
        ctx.rotate(wob);
        ctx.fillStyle = amb.c(mixHex(g.c1, P.cream, 0.5));
        ctx.beginPath(); ctx.ellipse(0, -1.6, 1.3, 1.65, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = amb.c(g.c2, 0.8);
        const r = mulberry32(g.seed);
        for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc((r() - 0.5) * 1.8, -1.6 + (r() - 0.5) * 2.4, 0.12 + r() * 0.2, 0, TAU); ctx.fill(); }
        break;
      }
      case 'bellwisp': {
        ctx.fillStyle = amb.c(g.c1, 0.85);
        ctx.beginPath(); ctx.arc(0, 0, 0.8 + k * 0.7, 0, TAU); ctx.fill();
        ctx.fillStyle = amb.c(g.c2, 0.85);
        ctx.beginPath(); ctx.arc(0, 0.15, 0.35 + k * 0.3, 0, TAU); ctx.fill();
        break;
      }
      case 'ribbonfin': {
        ctx.fillStyle = amb.c(g.c1, 0.55);
        for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc((i % 3) * 0.7 - 0.7, -Math.floor(i / 3) * 0.6, 0.38, 0, TAU); ctx.fill(); }
        ctx.fillStyle = amb.c(g.c3, 0.8);
        for (let i = 0; i < 6; i++) ctx.fillRect((i % 3) * 0.7 - 0.75, -Math.floor(i / 3) * 0.6 - 0.05, 0.12, 0.12);
        break;
      }
      default: {
        ctx.fillStyle = amb.c(g.c1 || P.bone);
        ctx.beginPath(); ctx.arc(0, -1, 1, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }
  drawGlow(ctx, world) {
    if (this.species === 'bellwisp') drawGlow(ctx, this.genome.glow || P.glowCyan, this.x, this.y, 3 * world.U, 0.25 + world.night * 0.5);
    else if (this.species === 'ribbonfin' && world.night > 0.2) drawGlow(ctx, this.genome.glow || P.glowCyan, this.x, this.y, 2.5 * world.U, world.night * 0.4);
  }
  hit(world, x, y) { return dist2(x, y, this.x, this.y - world.U) < (5 * world.U) ** 2; }
  serialize(world) {
    const o = {};
    for (const k in this) if (k[0] !== '_') o[k] = this[k];
    o.x = this.x / world.W; o.y = this.y / world.H;
    return o;
  }
}

// ---------------------------------------------------------------- gloamwhale (visitor)
export class Gloamwhale {
  constructor(world) {
    const W = world.W, H = world.H;
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.len = Math.max(W, H) * rr(0.45, 0.6);
    this.x = this.dir > 0 ? -this.len * 0.7 : W + this.len * 0.7;
    this.y = H * rr(0.12, 0.2);
    this.speed = (W + this.len * 1.4) / rr(220, 300);
    this.phase = Math.random() * TAU;
    this.done = false;
    this.fronds = [];
    const r = mulberry32((Math.random() * 1e9) | 0);
    for (let i = 0; i < 14; i++) this.fronds.push([r() * 1.6 - 0.8, H * (0.06 + r() * 0.16), r() * TAU]);
  }
  update(world, dt) {
    this.x += this.dir * this.speed * dt;
    if ((this.dir > 0 && this.x > world.W + this.len) || (this.dir < 0 && this.x < -this.len)) this.done = true;
  }
  draw(ctx, world) {
    const sky = world.sky;
    const L = this.len, Hh = L * 0.13;
    const t = world.t;
    const body = mixHex(sky.far2, sky.skyMid, 0.35);
    ctx.save();
    ctx.translate(this.x, this.y + Math.sin(t * 0.1 + this.phase) * Hh * 0.2);
    ctx.scale(this.dir, 1);
    ctx.globalAlpha = 0.8;
    // fronds
    ctx.strokeStyle = body;
    ctx.lineWidth = Math.max(1, L * 0.003);
    ctx.beginPath();
    for (const [fx, fl, ph] of this.fronds) {
      const x0 = fx * L * 0.42;
      ctx.moveTo(x0, Hh * 0.3);
      ctx.quadraticCurveTo(x0 + Math.sin(t * 0.3 + ph) * 8 - 10, fl * 0.5, x0 + Math.sin(t * 0.25 + ph) * 14 - 22, fl);
    }
    ctx.stroke();
    // body
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(L * 0.5, 0);
    ctx.bezierCurveTo(L * 0.35, -Hh * 1.1, -L * 0.25, -Hh * 0.9, -L * 0.5, -Hh * 0.1);
    ctx.lineTo(-L * 0.6, -Hh * 0.5);
    ctx.lineTo(-L * 0.58, Hh * 0.35);
    ctx.lineTo(-L * 0.5, Hh * 0.1);
    ctx.bezierCurveTo(-L * 0.25, Hh * 0.75, L * 0.35, Hh * 0.8, L * 0.5, 0);
    ctx.fill();
    // ribs
    ctx.strokeStyle = mixHex(body, sky.skyBot, 0.35);
    ctx.lineWidth = Math.max(1, L * 0.004);
    ctx.beginPath();
    for (let i = 0; i < 11; i++) {
      const x = -L * 0.38 + i * L * 0.07;
      const hh = Hh * 0.75 * Math.sin((i + 1) / 12 * Math.PI);
      ctx.moveTo(x, -hh); ctx.quadraticCurveTo(x + L * 0.02, 0, x, hh);
    }
    ctx.stroke();
    ctx.fillStyle = mixHex(body, sky.skyBot, 0.6);
    ctx.beginPath(); ctx.arc(L * 0.4, -Hh * 0.15, Hh * 0.07, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
    if (world.night > 0.2) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 11; i += 2) drawGlow(ctx, P.glowCyan, this.x + this.dir * (-L * 0.38 + i * L * 0.07), this.y, Hh * 0.8, world.night * 0.18);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

export function speciesName(kind) { return SPECIES[kind]?.name || kind; }
