// Ambient markers for a running focus timer: a cloud drifting along the far
// hills with the task written faintly on it, a small comet for every five
// focused minutes, and a bigger one when the target is reached.
import { P } from './palette.js';
import { TAU, rr, lerp, drawGlow, mixHex, hexToRgb, rgba } from './util.js';

const MAX_COMETS = 3;

export class SkyFx {
  constructor() {
    this.comets = [];
    this.cloudA = 0;     // fades in and out with the focus timer
    this.cloudX = null;
    this.text = '';
    this.textW = 0;
    this.font = '';
    this.puffs = null;
  }

  comet(world, big = false) {
    if (this.comets.length >= MAX_COMETS) this.comets.shift();
    const W = world.W, H = world.H;
    this.comets.push({
      t: 0,
      dur: big ? 2.6 : 1.7,
      x0: W * rr(0.55, 1.05), y0: world.topInset + H * rr(0.04, 0.16),
      dx: -W * rr(0.7, 1.0), dy: H * rr(0.12, 0.22),
      len: (big ? 34 : 20) * world.U,
      col: big ? P.glowAmber : P.glowCyan,
      big,
    });
  }

  // label is null when no task is being focused on
  update(dt, world, label, font) {
    for (const c of this.comets) c.t += dt;
    if (this.comets.length && this.comets[0].t > this.comets[0].dur) this.comets.shift();
    this.cloudA = lerp(this.cloudA, label ? 1 : 0, Math.min(1, dt * 0.8));
    if (label && label !== this.text) { this.text = label; this.textW = 0; }
    if (!label && this.cloudA < 0.01) { this.cloudX = null; return; }
    if (this.font !== font) { this.font = font; this.textW = 0; }
    // drifts slowly to the right and wraps around
    const span = world.W + this.width(world) * 2;
    if (this.cloudX == null) this.cloudX = world.W * 0.32;
    this.cloudX += dt * world.W / 160;
    if (this.cloudX > world.W + this.width(world)) this.cloudX -= span;
  }

  width(world) { return Math.max(this.textW, 30 * world.U) + 12 * world.U; }

  draw(ctx, world, amb) {
    if (this.comets.length) this.drawComets(ctx, world);
    if (this.cloudA > 0.01 && this.cloudX != null) this.drawCloud(ctx, world, amb);
  }

  drawComets(ctx, world) {
    const U = world.U;
    ctx.lineCap = 'round';
    for (const c of this.comets) {
      const k = c.t / c.dur;
      const e = k * (2 - k); // eases out
      const hx = c.x0 + c.dx * e, hy = c.y0 + c.dy * e;
      const fade = k < 0.12 ? k / 0.12 : k > 0.75 ? (1 - k) / 0.25 : 1;
      const ang = Math.atan2(c.dy, c.dx);
      const tx = -Math.cos(ang), ty = -Math.sin(ang);
      const rgb = hexToRgb(c.col);
      // tail: a few tapering segments
      for (let i = 0; i < 6; i++) {
        const a0 = i / 6, a1 = (i + 1) / 6;
        ctx.strokeStyle = rgba(rgb, fade * 0.55 * (1 - a0));
        ctx.lineWidth = Math.max(0.6, (c.big ? 1.1 : 0.7) * U * (1 - a0));
        ctx.beginPath();
        ctx.moveTo(hx + tx * c.len * a0, hy + ty * c.len * a0);
        ctx.lineTo(hx + tx * c.len * a1, hy + ty * c.len * a1);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(ctx, c.col, hx, hy, (c.big ? 7 : 4.5) * U, fade * 0.9);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba([255, 250, 238], fade);
      ctx.beginPath(); ctx.arc(hx, hy, (c.big ? 0.7 : 0.45) * U, 0, TAU); ctx.fill();
    }
  }

  drawCloud(ctx, world, amb) {
    const U = world.U, s = world.sky;
    const fs = Math.max(10, U * 2.5);
    ctx.font = `600 ${fs}px ${this.font}`;
    if (!this.textW) this.textW = ctx.measureText(this.text).width;
    const w = this.width(world), h = 7 * U;
    const cx = this.cloudX;
    // open sky between the top of the clock and the planet
    const cy = Math.max(world.topInset + h, world.clock.cy - world.clock.R - world.H * 0.06) + Math.sin(world.t * 0.15) * U * 0.6;
    const a = this.cloudA;
    const night = world.night;
    const fill = night > 0.5 ? mixHex(s.skyMid, P.lilac, 0.45) : mixHex(s.skyMid, P.cream, 0.7);
    // puffy outline: a base and a row of rounded humps, built once per size
    if (!this.puffs || this.puffs.w !== w) {
      const n = Math.max(3, Math.round(w / (9 * U)));
      const r = [];
      // humps swell toward the middle, with a little irregularity
      for (let i = 0; i < n; i++) r.push([(i + 0.5) / n - 0.5, 0.5 + 0.75 * Math.sin((i + 0.5) / n * Math.PI) * (0.8 + ((i * 7919) % 5) / 12)]);
      this.puffs = { w, r };
    }
    ctx.fillStyle = amb.c(fill, (night > 0.5 ? 0.55 : 0.72) * a);
    ctx.beginPath();
    ctx.ellipse(cx, cy + h * 0.2, w * 0.5, h * 0.38, 0, 0, TAU);
    for (const [fx, fr] of this.puffs.r) {
      const px = cx + fx * w * 0.84, pr = h * 0.5 * fr;
      ctx.moveTo(px + pr, cy + h * 0.2 - pr * 0.55);
      ctx.arc(px, cy + h * 0.2 - pr * 0.55, pr, 0, TAU);
    }
    ctx.fill();
    // a faint lighter rim on top
    ctx.strokeStyle = amb.c(mixHex(fill, P.cream, 0.6), 0.35 * a);
    ctx.lineWidth = Math.max(1, U * 0.25);
    ctx.beginPath();
    for (const [fx, fr] of this.puffs.r) {
      const px = cx + fx * w * 0.84, pr = h * 0.5 * fr, py = cy + h * 0.2 - pr * 0.55;
      ctx.moveTo(px - pr * 0.7, py - pr * 0.7);
      ctx.arc(px, py, pr, Math.PI * 1.25, Math.PI * 1.75);
    }
    ctx.stroke();
    // the words, faint
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // the words skip the night tint so they stay legible
    ctx.fillStyle = night > 0.5 ? rgba(hexToRgb(P.cream), 0.62 * a) : amb.c(P.ink, 0.6 * a);
    ctx.fillText(this.text, cx, cy + h * 0.22);
    ctx.textBaseline = 'alphabetic';
  }
}
