// Fixed-size particle pool. No allocation during frames.
import { drawGlow, rr, TAU } from './util.js';

export class Particles {
  constructor(max = 220) {
    this.max = max;
    this.p = [];
    // every particle gets its full shape up front so the hidden class is stable
    for (let i = 0; i < max; i++) {
      this.p.push({ on: false, type: 'mote', x: 0, y: 0, vx: 0, vy: 0, g: 0, drag: 0.6, life: 0, max: 2, size: 1.5, grow: 0, color: '#ffffff', glow: null, wob: 0, ph: 0 });
    }
    this.cursor = 0;
    this.live = 0;
    // per-type counts so draw() can skip whole passes; recounted in update()
    // and bumped on emit so particles born after update() still draw this frame
    this.nDot = 0;
    this.nRing = 0;
    this.nGlow = 0;
  }

  _slot() {
    const max = this.max, p = this.p;
    for (let k = 0; k < max; k++) {
      let i = this.cursor + k;
      if (i >= max) i -= max;
      const q = p[i];
      if (!q.on) {
        this.cursor = i + 1 >= max ? 0 : i + 1;
        return q;
      }
    }
    return null;
  }

  // Shared field setup for emit() and burst(); o supplies the style fields,
  // position/velocity/life come in explicitly so burst() never copies o.
  _fill(q, o, x, y, vx, vy, life) {
    q.on = true;
    q.type = o.type || 'mote';
    q.x = x; q.y = y;
    q.vx = vx || 0; q.vy = vy || 0;
    q.g = o.g || 0;
    q.drag = o.drag ?? 0.6;
    q.life = 0; q.max = life || 2;
    q.size = o.size || 1.5;
    q.grow = o.grow || 0;
    q.color = o.color || '#ffffff';
    q.glow = o.glow || null;
    q.wob = o.wob || 0;
    q.ph = Math.random() * TAU;
    if (q.type === 'ring') this.nRing++; else this.nDot++;
    if (q.glow) this.nGlow++;
    return q;
  }

  // type: 'mote' drifting dot, 'spark' burst dot, 'ring' expanding stroke,
  //       'drop' falling droplet, 'glow' soft glowing mote
  emit(o) {
    const q = this._slot();
    return q ? this._fill(q, o, o.x, o.y, o.vx, o.vy, o.life) : null;
  }

  burst(x, y, n, o) {
    const sMin = o.speedMin ?? 0.3, speed = o.speed || 20, ovx = o.vx || 0, ovy = o.vy || 0, life = o.life || 1.5;
    for (let i = 0; i < n; i++) {
      // same random draw order as before: angle, speed, life, then phase
      const a = rr(0, TAU);
      const s = rr(sMin, 1) * speed;
      const vx = Math.cos(a) * s + ovx, vy = Math.sin(a) * s + ovy;
      const l = rr(0.6, 1) * life;
      const q = this._slot();
      if (q) this._fill(q, o, x, y, vx, vy, l);
    }
  }

  update(dt, t) {
    let live = 0, nRing = 0, nGlow = 0;
    const p = this.p;
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      if (!q.on) continue;
      q.life += dt;
      if (q.life >= q.max) { q.on = false; continue; }
      live++;
      if (q.type === 'ring') nRing++;
      if (q.glow) nGlow++;
      const d = Math.exp(-q.drag * dt);
      q.vx *= d; q.vy = q.vy * d + q.g * dt;
      q.x += q.vx * dt + (q.wob ? Math.sin(t * 1.7 + q.ph) * q.wob * dt : 0);
      q.y += q.vy * dt;
      q.size += q.grow * dt;
    }
    this.live = live;
    this.nRing = nRing;
    this.nDot = live - nRing;
    this.nGlow = nGlow;
  }

  draw(ctx, night) {
    if (!this.live) return;
    const p = this.p;
    // plain dots first
    if (this.nDot) {
      let fill = null;
      for (let i = 0; i < p.length; i++) {
        const q = p[i];
        if (!q.on || q.type === 'ring') continue;
        const k = 1 - q.life / q.max;
        const a = q.type === 'spark' ? k : Math.min(1, k * 2.5) * Math.min(1, q.life * 4);
        ctx.globalAlpha = a;
        if (q.color !== fill) ctx.fillStyle = fill = q.color;
        const s = q.size;
        if (s < 2.2) ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
        else { ctx.beginPath(); ctx.arc(q.x, q.y, s / 2, 0, TAU); ctx.fill(); }
      }
      ctx.globalAlpha = 1;
    }
    // rings
    if (this.nRing) {
      for (let i = 0; i < p.length; i++) {
        const q = p[i];
        if (!q.on || q.type !== 'ring') continue;
        const k = 1 - q.life / q.max;
        ctx.globalAlpha = k * 0.7;
        ctx.strokeStyle = q.color;
        ctx.lineWidth = 1 + k * 1.5;
        ctx.beginPath(); ctx.arc(q.x, q.y, q.size, 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // additive glows
    if (this.nGlow) {
      ctx.globalCompositeOperation = 'lighter';
      const gn = 0.35 + night * 0.5;
      for (let i = 0; i < p.length; i++) {
        const q = p[i];
        if (!q.on || !q.glow) continue;
        const k = 1 - q.life / q.max;
        drawGlow(ctx, q.glow, q.x, q.y, q.size * 3.5, k * gn);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}
