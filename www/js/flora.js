// Plants: they grow from fertile soil, sway in the air of the glass, feed
// the animals, and rot back into the ground.
import { P, FAMILIES } from './palette.js';
import { TAU, rr, pick, chance, uid, mixHex, drawGlow, mulberry32, smooth } from './util.js';
import { ECO } from './species.js';

// Optional richer artwork, registered by art.js when it is present.
let FLORA_ART = {};
export function setFloraArt(a) { FLORA_ART = a || {}; }

const H = 3600;

const DEF = {
  grass:       { grow: 0.4 * H, life: [14 * H, 30 * H], h: [3, 6] },
  fanfern:     { grow: 1.0 * H, life: [26 * H, 60 * H], h: [7, 13] },
  bulbstalk:   { grow: 1.4 * H, life: [30 * H, 60 * H], h: [16, 30] },
  lanternlily: { grow: 1.0 * H, life: [24 * H, 50 * H], h: [11, 19] },
  puffcap:     { grow: 0.7 * H, life: [16 * H, 36 * H], h: [4, 8] },
  tubebloom:   { grow: 1.5 * H, life: [30 * H, 70 * H], h: [5, 12] },
  coilspire:   { grow: 4.0 * H, life: [48 * H, 90 * H], h: [30, 52] },
  snaplure:    { grow: 1.5 * H, life: [60 * H, 120 * H], h: [5, 8] },
  dewveil:     { grow: 2.0 * H, life: [60 * H, 120 * H], h: [14, 24] },
  gloomcap:    { grow: 0.6 * H, life: [5 * H, 8 * H], h: [3, 6] },
};
export const FLORA_KINDS = Object.keys(DEF);

function genome(kind, r) {
  const g = { h: DEF[kind].h[0] + r() * (DEF[kind].h[1] - DEF[kind].h[0]), lean: (r() - 0.5) * 0.5, seed: Math.floor(r() * 1e9) };
  switch (kind) {
    case 'grass': g.c1 = pick([P.moss, P.olive, P.sea, P.chartreuse, P.sand], r); g.n = 3 + Math.floor(r() * 4); break;
    case 'fanfern': g.c1 = pick([P.teal, P.sea, P.moss, P.deepteal], r); g.c2 = pick([P.mint, P.chartreuse, P.sea], r); g.c3 = pick([P.cream, P.bone], r); g.n = 3 + Math.floor(r() * 4); break;
    case 'bulbstalk': g.c1 = pick([P.olive, P.moss, P.teal], r); g.c2 = pick([P.mint, P.sea, P.chartreuse], r); g.c3 = pick([P.coral, P.salmon, P.rust, P.amber], r); break;
    case 'lanternlily': g.c1 = pick([P.moss, P.olive, P.deepteal], r); g.c2 = pick([P.salmon, P.peach, P.rose, P.lilac, P.cream], r); g.c3 = pick([P.rust, P.plum, P.coral], r); g.glow = pick([P.glowAmber, P.glowPink, P.glowCyan], r); break;
    case 'puffcap': g.c1 = pick([P.bone, P.cream, P.sand], r); g.c2 = pick([P.coral, P.mauve, P.rust, P.teal, P.ochre], r); g.c3 = pick([P.cream, P.bone, P.peach], r); break;
    case 'tubebloom': g.c1 = pick([P.mauve, P.rose, P.salmon, P.teal, P.lilac], r); g.c2 = pick([P.cream, P.peach, P.mint], r); g.glow = pick(FAMILIES.glow, r); g.n = 3 + Math.floor(r() * 4); break;
    case 'snaplure': g.c1 = pick([P.olive, P.deepteal, P.moss], r); g.c2 = pick([P.rose, P.coral, P.salmon, P.rust], r); g.c3 = pick([P.cream, P.bone], r); g.glow = pick([P.glowAmber, P.glowPink], r); break;
    case 'dewveil': g.c1 = pick([P.lilac, P.mint, P.bone, P.peach], r); g.c2 = pick([P.mauve, P.teal, P.rose], r); g.c3 = pick([P.cream, P.mint], r); g.glow = pick([P.glowCyan, P.glowViolet], r); g.w = 5 + r() * 4; g.n = 8 + Math.floor(r() * 5); break;
    case 'gloomcap': g.c1 = pick([P.bone, P.cream, P.lilac], r); g.c2 = pick([P.mauve, P.plum, P.olive], r); g.c3 = pick([P.chartreuse, P.mint], r); g.n = 3 + Math.floor(r() * 3); break;
    case 'coilspire': g.c1 = pick([P.deepteal, P.olive, P.plum], r); g.c2 = pick([P.sea, P.mint, P.chartreuse, P.salmon], r); g.glow = pick(FAMILIES.glow, r); g.turns = 2.5 + r() * 2; break;
  }
  return g;
}

export class Plant {
  constructor(o) {
    this.id = uid();
    this.kind = o.kind;
    this.x = 0;
    this.age = 0;
    this.growth = 0.02;
    this.wither = 0;
    this.ripe = 0;       // bulbstalk fruit
    this.pollen = 0;     // bulbstalk pollination boost
    this.nectar = 1;     // lantern lily
    this.n = 0;          // nutrient in the plant's body
    this.store = 0;      // nutrient packed into fruit or nectar
    if (o.kind === 'snaplure' || o.kind === 'dewveil') { this.closed = 0; this.snapT = 0; this.digest = 0; this.caught = 0; this.lastMeal = 0; }
    Object.assign(this, o);
    if (!this.genome) this.genome = genome(this.kind, Math.random);
    if (!this.life) this.life = rr(...DEF[this.kind].life);
  }

  // per-plant random numbers, made once instead of on every frame
  rand() { return this._r || (this._r = Array.from({ length: 32 }, mulberry32(this.genome.seed))); }

  get height() { return this.genome.h * (0.25 + 0.75 * smooth(this.growth)) * (1 - this.wither * 0.35); }

  tick(world, dt) {
    this.age += dt;
    const def = DEF[this.kind];
    const nMax = ECO.nPlant[this.kind];
    if (this.growth < 1) {
      // growth draws nutrient from the soil; a starved plant stalls
      const f = 0.35 + world.fertAt(this.x) * 1.3;
      const want = Math.min(1, this.growth + (dt / def.grow) * f);
      if (this.kind !== 'gloomcap' && this.kind !== 'snaplure' && this.kind !== 'dewveil') {
        this.n += world.takeN(this.x, Math.max(0, nMax * want - this.n));
        this.growth = Math.min(want, Math.max(this.growth, this.n / nMax));
      } else {
        this.growth = want; // these feed on prey or the bodies they rise from
      }
    }
    // soured soil around a neglected task's weeds: plants start to die
    const bl = world.blight?.[world.bucketOf(this.x)] || 0;
    if (bl > 0.3 && this.kind !== 'gloomcap' && this.age <= this.life && chance(bl / (8 * 3600), dt)) this.life = this.age;
    if (this.age > this.life) {
      this.wither = Math.min(1, this.wither + dt / 2400);
      if (this.wither >= 1) { this.dead = true; world.onPlantDeath(this); }
      return;
    }
    if (this.kind === 'bulbstalk' && this.growth > 0.7) {
      const rate = (1 + this.pollen * 2.5) / 2700;
      this.store += world.takeN(this.x, Math.max(0, Math.min(ECO.nFruit, this.store + dt * rate * ECO.nFruit) - this.store));
      this.ripe = Math.min(1, this.store / ECO.nFruit);
      this.pollen = Math.max(0, this.pollen - dt / 5400);
      if (this.ripe >= 0.99 && chance(1 / 1800, dt)) {
        const p = this.tip(world);
        world.dropItem('fruit', p.x, p.y, this.genome.c3, this.store);
        this.store = 0; this.ripe = 0;
      }
    } else if (this.kind === 'lanternlily') {
      if (this.store < ECO.nNectar) this.store += world.takeN(this.x, Math.min(ECO.nNectar - this.store, dt / 1200 * ECO.nNectar));
      this.nectar = this.store / ECO.nNectar;
    } else if (this.kind === 'puffcap' && this.growth > 0.8 && !world.offline) {
      if (chance(1 / 300, dt)) this.puff(world);
    } else if (this.kind === 'gloomcap' && this.growth > 0.5 && !world.offline && chance(1 / 90, dt)) {
      this.puff(world);
    }
    if (this.kind === 'puffcap' && this.growth > 0.8 && chance(1 / 2400, dt)) world.trySporeFromPuffcap(this);
  }

  // an animal drinks or eats what the plant has stored
  harvest(world, eater, share = 1) {
    const n = this.store * share;
    this.store -= n;
    if (this.kind === 'bulbstalk') this.ripe = this.store / ECO.nFruit;
    if (this.kind === 'lanternlily') this.nectar = this.store / ECO.nNectar;
    world.feed(eater, n, this.x);
    return n;
  }

  puff(world) {
    const U = world.U;
    const y = world.groundY(this.x) - this.height * U;
    for (let i = 0; i < 9; i++) {
      world.particles.emit({ type: 'mote', x: this.x + rr(-2, 2) * U, y, vx: rr(-6, 6), vy: rr(-14, -5), drag: 0.9, wob: 8, life: rr(3, 6), size: rr(1.2, 2.4), color: this.genome.c3, glow: world.night > 0.4 ? P.glowLime : null });
    }
  }

  sway(world, k = 1) {
    const t = world.t * (1 - world.night * 0.4);
    return (Math.sin(t * 0.7 + this.x * 0.013) * 0.6 + Math.sin(t * 1.9 + this.x * 0.051) * 0.25 + world.gust * Math.sin(t * 3 + this.x * 0.02)) * k;
  }

  // world-space position of the top (fruit / flower) for animals to use
  tip(world) {
    const U = world.U, gy = world.groundY(this.x);
    const h = this.height * U;
    const sw = this.sway(world, 0.06) + this.genome.lean * 0.3;
    if (this.kind === 'lanternlily') {
      return { x: this.x + (h * 0.42 + sw * h * 0.3) * (this.genome.lean >= 0 ? 1 : -1), y: gy - h * 0.82 };
    }
    if (this.kind === 'dewveil') return { x: this.x, y: world.topInset + h * 0.85 };
    return { x: this.x + Math.sin(sw) * h, y: gy - Math.cos(sw) * h };
  }

  draw(ctx, world, amb) {
    const art = FLORA_ART[this.kind];
    if (art) { art.draw(ctx, this, world, amb); return; }
    if (this.kind === 'snaplure' || this.kind === 'dewveil' || this.kind === 'gloomcap') { this.drawSimple(ctx, world, amb); return; }
    const U = world.U, gy = world.groundY(this.x);
    const g = this.genome;
    const fade = 1 - this.wither * 0.6;
    ctx.save();
    ctx.translate(this.x, gy);
    ctx.scale(U, U);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const wq = Math.round(this.wither * 20) / 20;
    const wc = (hex) => (wq > 0 ? mixHex(hex, P.ochre, wq * 0.7) : hex);
    const h = this.height;
    switch (this.kind) {
      case 'grass': {
        ctx.strokeStyle = amb.c(wc(g.c1), fade);
        ctx.lineWidth = 0.42;
        const R = this.rand(); let ri = 0;
        ctx.beginPath();
        for (let i = 0; i < g.n; i++) {
          const bx = (R[ri++ & 31] - 0.5) * 2.4;
          const hh = h * (0.55 + R[ri++ & 31] * 0.45);
          const s = this.sway(world, 0.9) + (bx * 0.25);
          ctx.moveTo(bx, 0);
          ctx.quadraticCurveTo(bx + s * hh * 0.25, -hh * 0.6, bx + s * hh * 0.6, -hh);
        }
        ctx.stroke();
        break;
      }
      case 'fanfern': {
        const n = g.n;
        const sp = 1.6;
        for (let i = 0; i < n; i++) {
          const f = n === 1 ? 0 : i / (n - 1) - 0.5;
          const a = -Math.PI / 2 + f * sp + this.sway(world, 0.12) + g.lean * 0.3;
          const L = h * (0.75 + 0.25 * Math.cos(f * 2));
          const dx = Math.cos(a), dy = Math.sin(a);
          const px = -dy, py = dx;
          const w = L * 0.24;
          const tx = dx * L, ty = dy * L;
          ctx.fillStyle = amb.c(wc(i % 2 ? g.c1 : g.c2), fade);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(dx * L * 0.5 + px * w, dy * L * 0.5 + py * w, tx, ty);
          ctx.quadraticCurveTo(dx * L * 0.5 - px * w * 0.7, dy * L * 0.5 - py * w * 0.7, 0, 0);
          ctx.fill();
          ctx.strokeStyle = amb.c(g.c3, 0.55 * fade);
          ctx.lineWidth = 0.18;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(tx * 0.92, ty * 0.92);
          ctx.stroke();
          // dotted edge, a small Vesna detail
          ctx.fillStyle = amb.c(g.c3, 0.7 * fade);
          for (let k = 1; k < 4; k++) {
            const q = k / 4.2;
            const ww = w * Math.sin(q * Math.PI) * 0.62;
            ctx.fillRect(dx * L * q + px * ww - 0.12, dy * L * q + py * ww - 0.12, 0.26, 0.26);
          }
        }
        break;
      }
      case 'bulbstalk': {
        const s = this.sway(world, 0.06) + g.lean * 0.3;
        const tx = Math.sin(s) * h, ty = -Math.cos(s) * h;
        ctx.strokeStyle = amb.c(wc(g.c1), fade);
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(tx * 0.1 - g.lean * 4, ty * 0.55, tx, ty);
        ctx.stroke();
        // two leaves
        ctx.fillStyle = amb.c(wc(g.c2), 0.9 * fade);
        for (let k = 0; k < 2; k++) {
          const q = 0.28 + k * 0.22;
          const lx = tx * q * 0.6 - g.lean * 4 * q, ly = ty * q;
          const side = k % 2 ? 1 : -1;
          ctx.beginPath();
          ctx.ellipse(lx + side * 1.6, ly - 0.5, 2.0, 0.6, side * -0.5, 0, TAU);
          ctx.fill();
        }
        if (this.growth > 0.6) {
          const r = 1.2 + (this.growth - 0.6) * 2.5 + this.ripe * 1.6;
          ctx.fillStyle = amb.c(wc(mixHex(g.c2, g.c3, Math.round(smooth(this.ripe) * 24) / 24)), fade);
          ctx.beginPath();
          ctx.ellipse(tx, ty - r * 0.7, r * 0.85, r, s, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = amb.c(P.ink, 0.22);
          ctx.lineWidth = 0.16;
          ctx.beginPath();
          ctx.moveTo(tx - r * 0.35, ty - r * 1.5);
          ctx.quadraticCurveTo(tx - r * 0.55, ty - r * 0.7, tx - r * 0.3, ty);
          ctx.moveTo(tx + r * 0.3, ty - r * 1.55);
          ctx.quadraticCurveTo(tx + r * 0.55, ty - r * 0.7, tx + r * 0.35, ty);
          ctx.stroke();
          ctx.fillStyle = amb.c(P.cream, 0.6);
          ctx.beginPath();
          ctx.arc(tx - r * 0.3, ty - r * 1.1, r * 0.18, 0, TAU);
          ctx.fill();
        }
        break;
      }
      case 'lanternlily': {
        const dir = g.lean >= 0 ? 1 : -1;
        const s = this.sway(world, 0.08);
        const tipx = (h * 0.42 + s * h * 0.3) * dir, tipy = -h * 0.82;
        ctx.strokeStyle = amb.c(wc(g.c1), fade);
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(s * 2, -h * 0.7, tipx * 0.6, -h * 1.12, tipx, tipy);
        ctx.stroke();
        if (this.growth > 0.45) {
          const bs = 1.2 + this.growth * 1.6;
          const ang = s * 0.6 + dir * 0.15;
          ctx.save();
          ctx.translate(tipx, tipy);
          ctx.rotate(ang);
          ctx.fillStyle = amb.c(wc(g.c2), fade);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.bezierCurveTo(bs * 1.1, bs * 0.2, bs * 1.0, bs * 1.6, bs * 0.9, bs * 2.0);
          ctx.quadraticCurveTo(bs * 0.45, bs * 1.6, 0, bs * 2.1);
          ctx.quadraticCurveTo(-bs * 0.45, bs * 1.6, -bs * 0.9, bs * 2.0);
          ctx.bezierCurveTo(-bs * 1.0, bs * 1.6, -bs * 1.1, bs * 0.2, 0, 0);
          ctx.fill();
          ctx.strokeStyle = amb.c(g.c3, 0.5);
          ctx.lineWidth = 0.15;
          ctx.beginPath();
          ctx.moveTo(0, bs * 0.2); ctx.lineTo(0, bs * 1.9);
          ctx.moveTo(bs * 0.45, bs * 0.4); ctx.lineTo(bs * 0.5, bs * 1.7);
          ctx.moveTo(-bs * 0.45, bs * 0.4); ctx.lineTo(-bs * 0.5, bs * 1.7);
          ctx.stroke();
          ctx.fillStyle = amb.c(g.c3);
          ctx.beginPath(); ctx.arc(0, bs * 2.45, 0.32, 0, TAU); ctx.fill();
          ctx.restore();
        }
        break;
      }
      case 'puffcap': {
        const s = this.sway(world, 0.03);
        const tx = s * h, ty = -h;
        const r = 1.6 + this.growth * 2.2;
        ctx.strokeStyle = amb.c(wc(g.c3), fade);
        ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(0, ty * 0.5, tx, ty); ctx.stroke();
        // gills
        ctx.fillStyle = amb.c(wc(mixHex(g.c2, P.ink, 0.35)), fade);
        ctx.beginPath(); ctx.ellipse(tx, ty, r, r * 0.28, s * 0.3, 0, TAU); ctx.fill();
        ctx.fillStyle = amb.c(wc(g.c2), fade);
        ctx.beginPath(); ctx.ellipse(tx, ty, r, r * 0.8, s * 0.3, Math.PI, TAU); ctx.fill();
        ctx.fillStyle = amb.c(g.c1, 0.85 * fade);
        const R = this.rand(); let ri = 0;
        for (let k = 0; k < 5; k++) {
          const a = Math.PI + 0.35 + R[ri++ & 31] * (Math.PI - 0.7);
          const rr2 = r * (0.3 + R[ri++ & 31] * 0.5);
          ctx.beginPath(); ctx.arc(tx + Math.cos(a) * rr2, ty + Math.sin(a) * rr2 * 0.8, 0.25 + R[ri++ & 31] * 0.35, 0, TAU); ctx.fill();
        }
        break;
      }
      case 'tubebloom': {
        const R = this.rand(); let ri = 0;
        const open = world.night;
        for (let k = 0; k < g.n; k++) {
          const bx = (k - (g.n - 1) / 2) * 1.25 + (R[ri++ & 31] - 0.5) * 0.5;
          const hh = h * (0.5 + R[ri++ & 31] * 0.5);
          const s = this.sway(world, 0.03) * hh;
          ctx.strokeStyle = amb.c(wc(g.c1), fade);
          ctx.lineWidth = 1.05;
          ctx.beginPath(); ctx.moveTo(bx, 0); ctx.quadraticCurveTo(bx, -hh * 0.6, bx + s, -hh); ctx.stroke();
          ctx.fillStyle = amb.c(g.c2, fade);
          ctx.beginPath(); ctx.ellipse(bx + s, -hh, 0.55 + open * 0.35, 0.28 + open * 0.2, 0, 0, TAU); ctx.fill();
          if (open > 0.2) {
            ctx.fillStyle = amb.c(P.ink, 0.8);
            ctx.beginPath(); ctx.ellipse(bx + s, -hh, 0.3 + open * 0.2, 0.12 + open * 0.1, 0, 0, TAU); ctx.fill();
          }
        }
        break;
      }
      case 'coilspire': {
        const turns = g.turns;
        const steps = 26;
        const s = this.sway(world, 0.05);
        ctx.strokeStyle = amb.c(wc(g.c1), fade);
        let px = 0, py = 0;
        for (let i = 1; i <= steps; i++) {
          const q = i / steps;
          const w = 2.4 * (1 - q * 0.6);
          const x = Math.sin(q * turns * TAU) * w + s * q * q * h * 0.6;
          const y = -q * h;
          ctx.lineWidth = 1.1 * (1 - q * 0.7);
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
          if (i % 5 === 0) {
            ctx.fillStyle = amb.c(g.c2, 0.9 * fade);
            ctx.beginPath(); ctx.ellipse(x + (Math.cos(q * turns * TAU) > 0 ? 1 : -1) * 1.1, y, 1.1, 0.45, 0.4, 0, TAU); ctx.fill();
          }
          px = x; py = y;
        }
        ctx.fillStyle = amb.c(g.c2, fade);
        ctx.beginPath(); ctx.arc(px, py, 0.9, 0, TAU); ctx.fill();
        this._top = [px, py];
        break;
      }
    }
    ctx.restore();
  }

  // additive glow pass (night)
  // plain fallback for the newer plants when art.js isn't loaded
  drawSimple(ctx, world, amb) {
    const U = world.U, g = this.genome, h = this.height;
    ctx.save();
    if (this.kind === 'dewveil') {
      ctx.translate(this.x, world.topInset);
      ctx.scale(U, U);
      ctx.strokeStyle = amb.c(g.c1, 0.6);
      ctx.lineWidth = 0.2;
      ctx.beginPath();
      for (let i = 0; i < g.n; i++) {
        const x = (i / (g.n - 1) - 0.5) * 2 * g.w;
        ctx.moveTo(x, 0); ctx.lineTo(x + Math.sin(world.t * 0.6 + i) * 0.8, h * (0.7 + (i % 3) * 0.12));
      }
      ctx.stroke();
    } else {
      ctx.translate(this.x, world.groundY(this.x));
      ctx.scale(U, U);
      ctx.fillStyle = amb.c(this.kind === 'gloomcap' ? g.c1 : g.c2);
      ctx.beginPath(); ctx.ellipse(0, -h * 0.7, h * 0.35, h * 0.3 * (1 - (this.closed || 0) * 0.5), 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = amb.c(g.c1);
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -h * 0.5); ctx.stroke();
    }
    ctx.restore();
  }

  drawGlow(ctx, world) {
    const art = FLORA_ART[this.kind];
    if (art) { art.glow(ctx, this, world); return; }
    const n = world.night;
    if (n < 0.05 || this.growth < 0.4) return;
    const U = world.U;
    const g = this.genome;
    if (this.kind === 'lanternlily') {
      const p = this.tip(world);
      drawGlow(ctx, g.glow, p.x, p.y + 3 * U, 5 * U, n * (0.25 + this.nectar * 0.4) * (1 - this.wither));
    } else if (this.kind === 'tubebloom') {
      const gy = world.groundY(this.x);
      drawGlow(ctx, g.glow, this.x, gy - this.height * U * 0.8, this.height * U * 0.8, n * 0.5 * (1 - this.wither));
    } else if (this.kind === 'coilspire' && this._top) {
      const gy = world.groundY(this.x);
      drawGlow(ctx, g.glow, this.x + this._top[0] * U, gy + this._top[1] * U, 4 * U, n * 0.6);
    } else if (this.kind === 'puffcap') {
      const gy = world.groundY(this.x);
      drawGlow(ctx, P.glowLime, this.x, gy - this.height * U, 3 * U, n * 0.18);
    }
  }

  // roots in the soil cutaway
  drawRoots(ctx, world, amb) {
    if (this.kind === 'grass' || this.kind === 'dewveil' || this.kind === 'gloomcap' || this.growth < 0.3) return;
    const U = world.U, gy = world.groundY(this.x);
    const depth = Math.min(this.height * 0.55, 14) * U;
    const R = this.rand(); let ri = 16;
    ctx.strokeStyle = amb.c(P.bone, 0.18 * (1 - this.wither));
    ctx.lineWidth = Math.max(0.6, U * 0.18);
    ctx.beginPath();
    const n = this.kind === 'coilspire' || this.kind === 'bulbstalk' ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const dx = (R[ri++ & 31] - 0.5) * depth * 1.1;
      ctx.moveTo(this.x, gy + U);
      ctx.quadraticCurveTo(this.x + dx * 0.2, gy + depth * 0.5, this.x + dx, gy + depth * (0.6 + R[ri++ & 31] * 0.5));
    }
    ctx.stroke();
  }

  hit(world, x, y) {
    const U = world.U, gy = world.groundY(this.x);
    if (this.kind === 'dewveil') { const w = this.genome.w * U; return x > this.x - w && x < this.x + w && y > world.topInset && y < world.topInset + this.height * U; }
    const w = Math.max(3, this.genome.h * 0.3) * U;
    return x > this.x - w && x < this.x + w && y < gy + U && y > gy - this.height * U - 2 * U;
  }

  serialize(world) {
    const o = {};
    for (const k in this) if (k[0] !== '_') o[k] = this[k];
    o.x = this.x / world.W;
    return o;
  }
}

export function sproutWeights(world) {
  const c = world.countFlora();
  const tasks = world.stats.tasksDone;
  const w = {
    grass: 2.2,
    fanfern: 2.6,
    bulbstalk: c.bulbstalk < 3 ? 5 : 2.2,
    lanternlily: c.lanternlily < 3 ? 4.5 : 2,
    puffcap: c.puffcap < 1 ? 3 : 1.2,
    tubebloom: tasks >= 6 ? 1.6 : 0,
    coilspire: tasks >= 10 && c.coilspire < 3 ? 0.8 : 0,
  };
  // traps and gloomcaps never sprout at random: they spread on their own terms
  return w;
}

export function pickKind(weights) {
  let tot = 0;
  for (const k in weights) tot += weights[k];
  let r = Math.random() * tot;
  for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
  return 'grass';
}

