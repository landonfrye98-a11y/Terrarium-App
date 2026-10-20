// Fixed-size particle pool. No allocation during frames.
import { drawGlow, rr, TAU } from './util.js';

export class Particles {
  constructor(max = 220) {
    this.max = max;
    this.p = [];
    for (let i = 0; i < max; i++) this.p.push({ on: false });
    this.cursor = 0;
    this.live = 0;
  }

  // type: 'mote' drifting dot, 'spark' burst dot, 'ring' expanding stroke,
  //       'drop' falling droplet, 'glow' soft glowing mote
  emit(o) {
    for (let k = 0; k < this.max; k++) {
      const i = (this.cursor + k) % this.max;
      const q = this.p[i];
      if (!q.on) {
        this.cursor = (i + 1) % this.max;
        q.on = true;
        q.type = o.type || 'mote';
        q.x = o.x; q.y = o.y;
        q.vx = o.vx || 0; q.vy = o.vy || 0;
        q.g = o.g || 0;
        q.drag = o.drag ?? 0.6;
        q.life = 0; q.max = o.life || 2;
        q.size = o.size || 1.5;
        q.grow = o.grow || 0;
        q.color = o.color || '#ffffff';
        q.glow = o.glow || null;
        q.wob = o.wob || 0;
        q.ph = Math.random() * TAU;
        return q;
      }
    }
    return null;
  }

  burst(x, y, n, o) {
    for (let i = 0; i < n; i++) {
      const a = rr(0, TAU);
      const s = rr(o.speedMin ?? 0.3, 1) * (o.speed || 20);
      this.emit({ ...o, x, y, vx: Math.cos(a) * s + (o.vx || 0), vy: Math.sin(a) * s + (o.vy || 0), life: rr(0.6, 1) * (o.life || 1.5) });
    }
  }

  update(dt, t) {
    let live = 0;
    for (const q of this.p) {
      if (!q.on) continue;
      q.life += dt;
      if (q.life >= q.max) { q.on = false; continue; }
      live++;
      const d = Math.exp(-q.drag * dt);
      q.vx *= d; q.vy = q.vy * d + q.g * dt;
      q.x += q.vx * dt + (q.wob ? Math.sin(t * 1.7 + q.ph) * q.wob * dt : 0);
      q.y += q.vy * dt;
      q.size += q.grow * dt;
    }
    this.live = live;
  }

  draw(ctx, night) {
    if (!this.live) return;
    // plain dots first
    for (const q of this.p) {
      if (!q.on || q.type === 'ring') continue;
      const k = 1 - q.life / q.max;
      const a = q.type === 'spark' ? k : Math.min(1, k * 2.5) * Math.min(1, q.life * 4);
      ctx.globalAlpha = a;
      ctx.fillStyle = q.color;
      const s = q.size;
      if (s < 2.2) ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
      else { ctx.beginPath(); ctx.arc(q.x, q.y, s / 2, 0, TAU); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    // rings
    for (const q of this.p) {
      if (!q.on || q.type !== 'ring') continue;
      const k = 1 - q.life / q.max;
      ctx.globalAlpha = k * 0.7;
      ctx.strokeStyle = q.color;
      ctx.lineWidth = 1 + k * 1.5;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.size, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // additive glows
    ctx.globalCompositeOperation = 'lighter';
    for (const q of this.p) {
      if (!q.on || !q.glow) continue;
      const k = 1 - q.life / q.max;
      drawGlow(ctx, q.glow, q.x, q.y, q.size * 3.5, k * (0.35 + night * 0.5));
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
