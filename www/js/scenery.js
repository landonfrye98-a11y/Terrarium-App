// Static-ish layers, rendered into offscreen canvases and only refreshed when
// the light changes noticeably. This is the main battery trick: the expensive
// landscape is drawn about once a minute, not every frame.
import { P } from './palette.js';
import { TAU, mulberry32, fbm, mixHex, hexToRgb, rgba, clamp, lerp } from './util.js';

export class Scenery {
  constructor(world) {
    this.world = world;
    this.bg = document.createElement('canvas');
    this.fg = document.createElement('canvas');
    this.key = '';
  }

  resize(W, H, dpr) {
    for (const c of [this.bg, this.fg]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    this.dpr = dpr;
    this.key = '';
    this.buildLayout();
  }

  // seeded geometry of the far megaflora + soil features
  buildLayout() {
    const w = this.world, W = w.W, H = w.H, U = w.U;
    const r = mulberry32(w.seed ^ 0x9e3779b9);
    this.horizon = w.groundBase - H * (w.portrait ? 0.1 : 0.13);
    const towers = [];
    const n = Math.round(W / (U * 9)) + 4;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < n; i++) {
        if (r() < 0.35) continue;
        const types = ['umbrella', 'stack', 'hoop', 'fan', 'spindle', 'umbrella', 'bulb'];
        const x = (i + r()) / n * W * 1.1 - W * 0.05;
        // a valley under the clock keeps the face readable
        const valley = 0.5 + 0.5 * Math.min(1, Math.abs(x - W / 2) / (W * 0.42));
        towers.push({
          row,
          x,
          h: (row ? 0.7 : 1) * (H * (0.07 + r() * 0.17)) * valley,
          w: U * (0.5 + r() * 1.3) * (row ? 1.2 : 0.9),
          type: types[Math.floor(r() * types.length)],
          lean: (r() - 0.5) * 0.15,
          s: r(),
        });
      }
    }
    this.towers = towers;
    this.stars = [];
    for (let i = 0; i < 140; i++) this.stars.push([r() * W, r() * this.horizon * 0.95, r() * 1.3 + 0.3, r()]);
    this.pebbles = [];
    for (let i = 0; i < Math.round(W / U * 0.5); i++) this.pebbles.push([r() * W, r(), r() * 1.4 + 0.4, r()]);
    this.fossils = [];
    for (let i = 0; i < 2 + Math.floor(r() * 2); i++) this.fossils.push([r() * W, 0.45 + r() * 0.45, (1.5 + r() * 1.5) * U, r() * TAU]);
    this.hatch = [];
    for (let i = 0; i < Math.round(W / U * 2.2); i++) this.hatch.push([r() * W, r(), r()]);
    this.drops = [];
    for (let i = 0; i < 40; i++) {
      const side = r() < 0.5 ? 0 : 1;
      this.drops.push([side ? W - r() * W * 0.22 : r() * W * 0.22, r() * H * 0.28 + w.topInset, (r() * 1.2 + 0.4) * U * 0.5]);
    }
  }

  // re-render when the sky color has moved enough to notice
  update(force) {
    const s = this.world.sky;
    const key = s.skyTop + s.skyBot + s.hillNear + Math.round(this.world.night * 20);
    if (!force && key === this.key) return false;
    this.key = key;
    this.renderBg();
    this.renderFg();
    return true;
  }

  renderBg() {
    const w = this.world, W = w.W, H = w.H, U = w.U, s = w.sky;
    const ctx = this.bg.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // sky
    const g = ctx.createLinearGradient(0, 0, 0, this.horizon + H * 0.05);
    g.addColorStop(0, s.skyTop);
    g.addColorStop(0.55, s.skyMid);
    g.addColorStop(1, s.skyBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // stars
    if (w.night > 0.05) {
      for (const [x, y, r, b] of this.stars) {
        ctx.globalAlpha = w.night * (0.3 + b * 0.7) * (1 - y / this.horizon * 0.6);
        ctx.fillStyle = b > 0.85 ? P.peach : P.cream;
        ctx.fillRect(x, y, r, r);
      }
      ctx.globalAlpha = 1;
    }

    this.drawPlanet(ctx);

    // haze bands
    for (let i = 0; i < 3; i++) {
      const y = this.horizon - H * (0.05 + i * 0.07);
      const hg = ctx.createLinearGradient(0, y - H * 0.03, 0, y + H * 0.03);
      hg.addColorStop(0, rgba(hexToRgb(s.haze), 0));
      hg.addColorStop(0.5, rgba(hexToRgb(s.haze), 0.16 - i * 0.04));
      hg.addColorStop(1, rgba(hexToRgb(s.haze), 0));
      ctx.fillStyle = hg;
      ctx.fillRect(0, y - H * 0.03, W, H * 0.06);
    }

    // megaflora, back row then front row
    for (const row of [1, 0]) {
      const col = row ? mixHex(s.far2, s.skyBot, 0.25) : s.far;
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      for (const t of this.towers) if (t.row === row) this.drawTower(ctx, t, col, s);
      // mist over the back row
      if (row) {
        const mg = ctx.createLinearGradient(0, this.horizon - H * 0.12, 0, this.horizon + 2);
        mg.addColorStop(0, rgba(hexToRgb(s.haze), 0));
        mg.addColorStop(1, rgba(hexToRgb(s.haze), 0.35));
        ctx.fillStyle = mg;
        ctx.fillRect(0, this.horizon - H * 0.12, W, H * 0.12 + 2);
      }
    }

    // far hills
    const seed = w.seed % 997;
    const hill = (yBase, amp, freq, col, sd) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W + 8; x += 8) ctx.lineTo(x, yBase + fbm(x / W * freq, sd, 3) * amp);
      ctx.lineTo(W, H);
      ctx.fill();
    };
    hill(this.horizon, U * 7, 3.2, s.hillFar, seed + 11);
    // hatching on far hills — the fine-line texture of the show's backgrounds
    ctx.strokeStyle = rgba(hexToRgb(mixHex(s.hillFar, P.ink, 0.35)), 0.35);
    ctx.lineWidth = Math.max(0.6, U * 0.15);
    ctx.beginPath();
    for (const [x, q] of this.hatch) {
      const top = this.horizon + fbm(x / W * 3.2, seed + 11, 3) * U * 7;
      const y = top + U * 1.5 + q * (w.groundBase - top);
      if (y > w.groundBase - U * 4) continue;
      ctx.moveTo(x, y); ctx.lineTo(x + U * 1.1, y - U * 0.7);
    }
    ctx.stroke();
    const midY = lerp(this.horizon, w.groundBase, 0.45);
    hill(midY, U * 4, 2.1, s.hillNear, seed + 29);
    // dotted texture on near hills
    ctx.fillStyle = rgba(hexToRgb(mixHex(s.hillNear, P.cream, 0.25)), 0.3);
    for (const [x, q, b] of this.hatch) {
      if (b < 0.5) continue;
      const top = midY + fbm(x / W * 2.1, seed + 29, 3) * U * 4;
      const y = top + U + q * (w.groundBase - top);
      if (y > w.groundBase - U * 2) continue;
      ctx.fillRect(x, y, U * 0.35, U * 0.35);
    }

    this.drawGround(ctx);
  }

  drawPlanet(ctx) {
    const w = this.world, W = w.W, H = w.H, s = w.sky;
    const R = Math.min(W, H) * (w.portrait ? 0.2 : 0.15);
    const cx = W * (w.portrait ? 0.8 : 0.82), cy = H * (w.portrait ? 0.13 : 0.2) + w.topInset * 0.5;
    const body = mixHex(s.planet, s.skyTop, 0.35);
    const ringCol = mixHex(s.planet, s.skyMid, 0.3);
    const tilt = -0.32;
    const ring = (front) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.strokeStyle = ringCol;
      ctx.globalAlpha = 0.55;
      for (let k = 0; k < 3; k++) {
        ctx.lineWidth = R * (0.035 - k * 0.008);
        ctx.beginPath();
        ctx.ellipse(0, 0, R * (1.55 + k * 0.13), R * (0.32 + k * 0.03), 0, front ? 0 : Math.PI, front ? Math.PI : TAU);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    };
    ring(false);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    ctx.fillStyle = body;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    // bands
    ctx.translate(cx, cy);
    ctx.rotate(tilt);
    const bandCols = [mixHex(body, P.salmon, 0.25), mixHex(body, P.sand, 0.2), mixHex(body, P.mauve, 0.18), mixHex(body, P.peach, 0.2)];
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = bandCols[i % bandCols.length];
      const y = -R + i * R * 0.31;
      ctx.beginPath();
      ctx.moveTo(-R * 1.2, y);
      for (let x = -R * 1.2; x <= R * 1.2; x += R * 0.2) ctx.lineTo(x, y + Math.sin(x / R * 4 + i) * R * 0.03);
      ctx.lineTo(R * 1.2, y + R * 0.13);
      ctx.lineTo(-R * 1.2, y + R * 0.13);
      ctx.fill();
    }
    // storm eye
    ctx.fillStyle = mixHex(body, P.coral, 0.3);
    ctx.beginPath(); ctx.ellipse(R * 0.3, R * 0.25, R * 0.15, R * 0.07, 0, 0, TAU); ctx.fill();
    ctx.restore();
    // terminator shade
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    ctx.fillStyle = rgba(hexToRgb(s.skyTop), 0.55);
    ctx.beginPath(); ctx.rect(cx - R, cy - R, R * 2, R * 2); ctx.arc(cx + R * 0.32, cy - R * 0.22, R * 1.08, 0, TAU);
    ctx.fill('evenodd');
    ctx.restore();
    ring(true);
    // little moon
    ctx.fillStyle = mixHex(s.planet, s.skyMid, 0.2);
    ctx.beginPath(); ctx.arc(cx - R * 1.9, cy + R * 0.9, R * 0.12, 0, TAU); ctx.fill();
  }

  drawTower(ctx, t, col, s) {
    const w = this.world, U = w.U;
    const baseY = this.horizon + U * 3;
    const topX = t.x + t.lean * t.h, topY = baseY - t.h;
    ctx.lineWidth = t.w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(t.x, baseY);
    ctx.quadraticCurveTo(t.x + t.lean * t.h * 0.2, baseY - t.h * 0.6, topX, topY);
    ctx.stroke();
    const k = t.h / w.H;
    switch (t.type) {
      case 'umbrella': {
        const r = U * (5 + t.s * 9) * (k * 4);
        ctx.beginPath(); ctx.ellipse(topX, topY, r, r * 0.32, t.lean, Math.PI, TAU); ctx.fill();
        ctx.lineWidth = Math.max(0.5, t.w * 0.25);
        ctx.beginPath();
        for (let i = -3; i <= 3; i++) { const x = topX + i * r * 0.28; ctx.moveTo(x, topY); ctx.lineTo(x + t.lean * 10, topY + r * (0.3 + ((i + 3) % 3) * 0.25)); }
        ctx.stroke();
        break;
      }
      case 'stack': {
        for (let i = 0; i < 3; i++) {
          const r = U * (2.4 - i * 0.6) * (k * 5);
          ctx.beginPath(); ctx.arc(topX - t.lean * i * 20, topY + i * r * 2.2, r, 0, TAU); ctx.fill();
        }
        break;
      }
      case 'hoop': {
        const r = U * (3 + t.s * 4) * (k * 4);
        ctx.lineWidth = t.w * 0.9;
        ctx.beginPath(); ctx.arc(topX, topY - r, r, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(topX, topY - r * 2, r * 0.25, 0, TAU); ctx.fill();
        break;
      }
      case 'fan': {
        ctx.lineWidth = Math.max(0.6, t.w * 0.45);
        const L = U * (4 + t.s * 5) * (k * 4);
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i - 2) * 0.38;
          const ex = topX + Math.cos(a) * L, ey = topY + Math.sin(a) * L;
          ctx.moveTo(topX, topY); ctx.lineTo(ex, ey);
        }
        ctx.stroke();
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i - 2) * 0.38;
          ctx.beginPath(); ctx.arc(topX + Math.cos(a) * L, topY + Math.sin(a) * L, t.w * 0.9, 0, TAU); ctx.fill();
        }
        break;
      }
      case 'bulb': {
        const r = U * (2 + t.s * 3) * (k * 4);
        ctx.beginPath(); ctx.ellipse(topX, topY - r * 0.8, r * 0.75, r * 1.1, t.lean, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.moveTo(topX, topY - r * 1.9); ctx.lineTo(topX + t.lean * 8, topY - r * 3); ctx.lineWidth = t.w * 0.4; ctx.stroke();
        break;
      }
      case 'spindle': {
        ctx.lineWidth = Math.max(0.5, t.w * 0.35);
        ctx.beginPath();
        for (let i = 1; i < 4; i++) {
          const y = baseY - t.h * (0.35 + i * 0.15);
          const x = t.x + t.lean * t.h * (0.35 + i * 0.15);
          const d = (i % 2 ? 1 : -1) * U * 2.5 * (k * 4);
          ctx.moveTo(x, y); ctx.quadraticCurveTo(x + d, y, x + d, y + U * 2 * k * 4);
        }
        ctx.stroke();
        break;
      }
    }
  }

  drawGround(ctx) {
    const w = this.world, W = w.W, H = w.H, U = w.U, s = w.sky;
    const step = 6;
    const surface = [];
    for (let x = 0; x <= W + step; x += step) surface.push([x, w.groundY(Math.min(x, W))]);
    const band = (off, col) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (const [x, y] of surface) ctx.lineTo(x, y + off(x));
      ctx.lineTo(W, H);
      ctx.fill();
    };
    const depth = H - w.groundBase;
    const sd = w.seed % 991;
    band(() => 0, s.ground);
    const strata = [
      [U * 2.2, mixHex(s.soil2, s.ground, 0.35)],
      [depth * 0.2, s.soil2],
      [depth * 0.38, mixHex(s.soil2, P.ochre, 0.18)],
      [depth * 0.55, s.soil],
      [depth * 0.78, mixHex(s.soil, P.plum, 0.25)],
    ];
    strata.forEach(([o, col], i) => band((x) => o + fbm(x / W * 3, sd + i * 13, 2) * U * (i ? 2.2 : 0.6), col));
    // pebbles & fossils in the cutaway
    for (const [x, q, r, b] of this.pebbles) {
      const y = w.groundY(x) + U * 3 + q * (depth - U * 5);
      if (w.inPond(x, U * 2) && y < w.pondBottom(x) + U) continue;
      ctx.fillStyle = mixHex(s.soil, b > 0.6 ? P.bone : P.sand, 0.25 + b * 0.15);
      ctx.beginPath(); ctx.ellipse(x, y, r * U * 0.7, r * U * 0.45, b * 3, 0, TAU); ctx.fill();
    }
    ctx.strokeStyle = mixHex(s.soil, P.bone, 0.3);
    ctx.lineWidth = Math.max(0.6, U * 0.2);
    for (const [x, q, r, a] of this.fossils) {
      const y = w.groundY(x) + q * depth;
      if (w.inPond(x, r * 2)) continue;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const t = i / 40 * TAU * 2.2;
        const rr2 = r * (t / (TAU * 2.2));
        const px = x + Math.cos(t + a) * rr2, py = y + Math.sin(t + a) * rr2 * 0.85;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
    // ground lip highlight
    ctx.strokeStyle = mixHex(s.ground, P.cream, 0.25);
    ctx.lineWidth = Math.max(1, U * 0.35);
    ctx.beginPath();
    surface.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    // little stones along the surface
    ctx.fillStyle = mixHex(s.ground, P.ink, 0.25);
    for (const [x, q, r, b] of this.pebbles) {
      if (b < 0.7 || w.inPond(x, U * 3)) continue;
      ctx.beginPath(); ctx.ellipse(x, w.groundY(x) + U * 0.2, r * U * 0.5, r * U * 0.3, 0, Math.PI, TAU); ctx.fill();
    }
    this.drawPond(ctx);
  }

  drawPond(ctx) {
    const w = this.world, U = w.U, s = w.sky, p = w.pond;
    ctx.save();
    // rim of darker clay
    ctx.fillStyle = mixHex(s.soil, P.ink, 0.3);
    ctx.beginPath();
    ctx.moveTo(p.x0 - U * 1.2, p.y);
    for (let i = 0; i <= 30; i++) { const x = p.x0 - U * 1.2 + (p.x1 - p.x0 + U * 2.4) * i / 30; const q = clamp((x - p.cx) / (p.rx + U * 1.2), -1, 1); ctx.lineTo(x, p.y + (p.depth + U * 1.2) * Math.sqrt(1 - q * q)); }
    ctx.closePath();
    ctx.fill();
    // water
    ctx.beginPath();
    ctx.moveTo(p.x0, p.y);
    for (let i = 0; i <= 30; i++) { const x = p.x0 + (p.x1 - p.x0) * i / 30; ctx.lineTo(x, w.pondBottom(x)); }
    ctx.closePath();
    const g = ctx.createLinearGradient(0, p.y, 0, p.y + p.depth);
    g.addColorStop(0, mixHex(s.water, s.skyBot, 0.25));
    g.addColorStop(0.35, s.water);
    g.addColorStop(1, mixHex(s.water, P.ink, 0.55));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    // light shafts
    ctx.fillStyle = rgba(hexToRgb(P.cream), 0.05 + (1 - w.night) * 0.05);
    for (let i = 0; i < 4; i++) {
      const x = p.x0 + (p.x1 - p.x0) * (0.15 + i * 0.22);
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x + U * 2, p.y); ctx.lineTo(x + U * 6, p.y + p.depth); ctx.lineTo(x + U * 3.5, p.y + p.depth); ctx.fill();
    }
    // weeds
    ctx.strokeStyle = mixHex(s.water, P.moss, 0.5);
    ctx.lineWidth = Math.max(1, U * 0.45);
    ctx.lineCap = 'round';
    const r = mulberry32(w.seed + 5);
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const x = p.x0 + (p.x1 - p.x0) * (0.08 + r() * 0.84);
      const b = w.pondBottom(x);
      const h = (b - p.y) * (0.3 + r() * 0.5);
      ctx.moveTo(x, b); ctx.bezierCurveTo(x + U * 2, b - h * 0.3, x - U * 2, b - h * 0.7, x + U, b - h);
    }
    ctx.stroke();
    ctx.restore();
    // surface line
    ctx.strokeStyle = rgba(hexToRgb(mixHex(s.skyBot, P.cream, 0.4)), 0.8);
    ctx.lineWidth = Math.max(1, U * 0.3);
    ctx.beginPath(); ctx.moveTo(p.x0, p.y); ctx.lineTo(p.x1, p.y); ctx.stroke();
  }

  // glass: reflections, condensation, vignette
  renderFg() {
    const w = this.world, W = w.W, H = w.H, U = w.U, s = w.sky;
    const ctx = this.fg.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const glass = 0.05 + (1 - w.night) * 0.04;
    // edge highlights
    const eg = ctx.createLinearGradient(0, 0, W * 0.06, 0);
    eg.addColorStop(0, `rgba(255,250,235,${glass * 2})`);
    eg.addColorStop(1, 'rgba(255,250,235,0)');
    ctx.fillStyle = eg; ctx.fillRect(0, 0, W * 0.06, H);
    const eg2 = ctx.createLinearGradient(W, 0, W * 0.95, 0);
    eg2.addColorStop(0, `rgba(255,250,235,${glass * 1.2})`);
    eg2.addColorStop(1, 'rgba(255,250,235,0)');
    ctx.fillStyle = eg2; ctx.fillRect(W * 0.94, 0, W * 0.06, H);
    // diagonal reflection streaks
    ctx.save();
    ctx.translate(W * 0.12, 0);
    ctx.rotate(0.35);
    ctx.fillStyle = `rgba(255,250,240,${glass * 0.9})`;
    ctx.fillRect(0, -H * 0.1, W * 0.05, H * 0.55);
    ctx.fillRect(W * 0.08, -H * 0.1, W * 0.015, H * 0.5);
    ctx.restore();
    // condensation beads near the top corners
    for (const [x, y, r] of this.drops) {
      ctx.fillStyle = `rgba(255,255,255,${0.1 + glass})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.25 + glass})`;
      ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, TAU); ctx.fill();
    }
    // vignette
    const vg = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(10,8,20,0)');
    vg.addColorStop(1, `rgba(10,8,20,${0.28 + w.night * 0.2})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    // the glass base rim
    ctx.fillStyle = rgba(hexToRgb(mixHex(s.soil, P.ink, 0.5)), 0.6);
    ctx.fillRect(0, H - U * 0.8, W, U * 0.8);
  }
}
