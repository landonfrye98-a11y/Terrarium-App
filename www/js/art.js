// Glasswild art: hand-tuned drawings for every creature and the carnivorous
// plants. Flat graphic shapes with fine linework (stipple, hatching, dotted
// edges), translucent membranes and night glow, after the Vesna look.
//
// Conventions
//  - creature entries: { draw(ctx, c, world, amb), glow(ctx, c, world) }
//  - plant entries:    { draw(ctx, p, world, amb), glow(ctx, p, world) }
//  - glow() runs while ctx.globalCompositeOperation === 'lighter'.
//  - only world.{t, night, gust, sky, W, H, U, topInset, groundY, clock} are read.
//  - no per-frame allocation: helpers are module functions, static geometry is
//    cached on the creature/plant as underscored fields, derived colours are
//    built once per creature (and again only when it becomes an elder).
import { P } from './palette.js';
import { TAU, clamp, lerp, smooth, mixHex, drawGlow, mulberry32 } from './util.js';

const PI = Math.PI;
// shared scratch buffers (never escape a draw call)
const XA = new Float32Array(64), YA = new Float32Array(64);
const XB = new Float32Array(64), YB = new Float32Array(64);
const WA = new Float32Array(64);

// ------------------------------------------------------------ helpers
function isElder(c) { return c.stage === 'elder' ? 1 : 0; }
function fade(hex, el) { return el ? mixHex(hex, P.bone, 0.3) : hex; }

// per-creature derived palette, rebuilt only when the genome object or the
// elder flag changes
function palOf(c, build) {
  const el = isElder(c);
  let p = c._pal;
  if (!p || p._el !== el || p._g !== c.genome) {
    p = c._pal = build(c.genome, el);
    p._el = el; p._g = c.genome;
  }
  return p;
}

// ellipse as its own sub-path, so many can share one fill
function oval(ctx, x, y, rx, ry, rot) {
  ctx.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot));
  ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
}
function dot(ctx, x, y, r) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
function sq(ctx, x, y, r) { ctx.rect(x - r, y - r, r * 2, r * 2); }

// a petal / leaf / wing blade from (bx,by) along angle a
function blade(ctx, bx, by, a, L, w, tipRound) {
  const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
  const tx = bx + dx * L, ty = by + dy * L;
  ctx.moveTo(bx, by);
  ctx.bezierCurveTo(
    bx + dx * L * 0.2 + nx * w * 1.1, by + dy * L * 0.2 + ny * w * 1.1,
    tx - dx * L * 0.1 + nx * w * tipRound, ty - dy * L * 0.1 + ny * w * tipRound,
    tx, ty);
  ctx.bezierCurveTo(
    tx - dx * L * 0.15 - nx * w * tipRound * 0.6, ty - dy * L * 0.15 - ny * w * tipRound * 0.6,
    bx + dx * L * 0.3 - nx * w * 0.5, by + dy * L * 0.3 - ny * w * 0.5,
    bx, by);
}

// ------------------------------------------------------------ infection
function infGeo(c) {
  let g = c._infG;
  if (g) return g;
  const r = mulberry32((c.genome.seed || 1) ^ 0x5f3759df);
  g = c._infG = new Float32Array(5 * 5);
  for (let i = 0; i < 5; i++) {
    g[i * 5] = r() * 2 - 1;          // position along spread
    g[i * 5 + 1] = 0.6 + r() * 0.8;  // stalk length
    g[i * 5 + 2] = (r() - 0.5) * 0.9; // lean
    g[i * 5 + 3] = 0.6 + r() * 0.6;  // cap size
    g[i * 5 + 4] = r();
  }
  return g;
}
const INF_STALK = mixHex(P.bone, P.cream, 0.4);
const INF_CAP = mixHex(P.bone, P.chartreuse, 0.35);
const INF_GILL = mixHex(P.olive, P.plum, 0.3);
const INF_DOT = P.glowLime;
const INF_HYPHA = mixHex(P.bone, P.mint, 0.3);

// draws in the creature's local frame: (ax, ay) is the surface anchor,
// spread the half-width of the growth patch, sz a size factor
function infectLocal(ctx, c, amb, ax, ay, spread, sz) {
  const k = Math.min(1, c.inf / 7200);
  if (k <= 0) return;
  const g = infGeo(c);
  const n = 2 + Math.min(3, Math.floor(k * 3.99));
  const grow = 0.35 + 0.65 * k;
  // hyphae: a branching mat
  ctx.strokeStyle = amb.c(INF_HYPHA, 0.75);
  ctx.lineWidth = 0.12 * sz;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = ax + g[i * 5] * spread;
    ctx.moveTo(x - 0.5 * sz * grow, ay + 0.2 * sz);
    ctx.quadraticCurveTo(x, ay - 0.1, x + 0.6 * sz * grow, ay + 0.25 * sz);
    ctx.moveTo(x, ay);
    const L = g[i * 5 + 1] * grow * sz * 1.4;
    ctx.quadraticCurveTo(x + g[i * 5 + 2] * L * 0.2, ay - L * 0.6, x + g[i * 5 + 2] * L, ay - L);
  }
  ctx.stroke();
  // caps
  ctx.fillStyle = amb.c(INF_CAP, 0.95);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const L = g[i * 5 + 1] * grow * sz * 1.4;
    const x = ax + g[i * 5] * spread + g[i * 5 + 2] * L, y = ay - L;
    const r = g[i * 5 + 3] * 0.42 * sz * grow;
    ctx.moveTo(x - r, y);
    ctx.quadraticCurveTo(x - r * 0.9, y - r * 1.2, x, y - r * 1.1);
    ctx.quadraticCurveTo(x + r * 0.9, y - r * 1.2, x + r, y);
    ctx.quadraticCurveTo(x, y - r * 0.35, x - r, y);
  }
  ctx.fill();
  // gills / spore dots
  ctx.fillStyle = amb.c(INF_GILL, 0.8);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const L = g[i * 5 + 1] * grow * sz * 1.4;
    const x = ax + g[i * 5] * spread + g[i * 5 + 2] * L, y = ay - L;
    const r = g[i * 5 + 3] * 0.42 * sz * grow;
    ctx.rect(x - r * 0.7, y - r * 0.12, r * 1.4, r * 0.18);
  }
  ctx.fill();
  ctx.fillStyle = amb.c(INF_DOT, 0.85);
  ctx.beginPath();
  for (let i = 0; i < 2 + n; i++) {
    const q = g[(i % 5) * 5 + 4];
    sq(ctx, ax + (q * 2 - 1) * spread * 1.2, ay + 0.15 - q * 0.5 * sz, 0.09 * sz);
  }
  ctx.fill();
}

// anchors (local units) used when drawInfection is called from outside
function infAnchorY(c) {
  switch (c.kind) {
    case 'scuttler': return -3.7;
    case 'stiltstrider': return c._bodyY != null ? c._bodyY - 2.8 : -12;
    case 'hookjaw': return -3.4;
    case 'mindbloom': return -4.8;
    case 'bellwisp': return -3.8;
    case 'petalmoth': return -0.4;
    case 'lancewing': return -0.5;
    case 'mireeel': return -1.2;
    case 'ribbonfin': return -0.9;
    default: return -2;
  }
}

export function drawInfection(ctx, c, world, amb, s) {
  if (!(c.inf > 0)) return;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(s * (c.dir || 1), s);
  ctx.lineCap = 'round';
  infectLocal(ctx, c, amb, 0, infAnchorY(c), 1.6, 1);
  ctx.restore();
}

// ============================================================ SCUTTLER
function scPal(g, el) {
  const c1 = fade(g.c1, el), c2 = fade(g.c2, el);
  const flesh = mixHex(c2, P.salmon, 0.45);
  return {
    shell: c1,
    shellDk: mixHex(c1, P.ink, 0.38),
    shellLt: mixHex(c1, P.cream, 0.55),
    seam: mixHex(c1, g.c3, 0.45),
    stip: mixHex(c1, g.c3, 0.6),
    flesh,
    fleshDk: mixHex(flesh, P.plum, 0.45),
    leg: mixHex(g.c3, c1, 0.3),
    legFar: mixHex(g.c3, P.ink, 0.45),
    joint: mixHex(c2, c1, 0.3),
    spine: mixHex(mixHex(g.c3, c1, 0.4), P.bone, el ? 0.5 : 0.3),
    eyeW: mixHex(P.cream, g.eye, 0.2),
    iris: mixHex(g.eye, P.deepteal, 0.35),
    tunnel: P.ink,
    tunnelRim: mixHex(P.ink, P.rust, 0.3),
    lichen: el ? mixHex(P.bone, P.sea, 0.4) : mixHex(P.sea, P.chartreuse, 0.35),
    lichenDot: P.chartreuse,
  };
}
function scGeo(c) {
  let G = c._scG;
  if (G) return G;
  const r = mulberry32(c.genome.seed || 7);
  G = c._scG = { st: new Float32Array(22 * 2), li: new Float32Array(6 * 3) };
  for (let i = 0; i < 22; i++) { G.st[i * 2] = 0.08 + r() * 0.84; G.st[i * 2 + 1] = 0.15 + r() * 0.75; }
  for (let i = 0; i < 6; i++) { G.li[i * 3] = 0.15 + r() * 0.6; G.li[i * 3 + 1] = 0.55 + r() * 0.4; G.li[i * 3 + 2] = 0.25 + r() * 0.35; }
  return G;
}
const SC_X0 = -3.7, SC_X1 = 3.2;
// dome profile: height above rim at u (0 = rear .. 1 = front)
function scTop(u) { return 3.0 * Math.pow(Math.sin(PI * (0.04 + u * 0.92)), 0.7) * (1.06 - 0.26 * u); }
function scX(u) { return SC_X0 + u * (SC_X1 - SC_X0); }

function scuttlerDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, scPal);
  const G = scGeo(c);
  const s = c.scale * world.U;
  const under = (c.depth || 0) > 0.4;
  const A = under ? 0.6 : 1;
  const st = c.stage;
  const juv = st === 'juvenile';
  const ph = c.phase || 0;
  const eat = c.state === 'eat';
  const walking = c.state === 'walk' || c.state === 'tunnel';
  const tr = c._trance > 0 ? 1 : 0;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(s * c.dir, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const dep = c.depth || 0;
  if (dep > 0.02) {
    // below ground: nothing shows above the soil surface (local y = -depth)
    const surf = -dep * world.U / s;
    ctx.beginPath(); ctx.rect(-30, surf, 60, 40); ctx.clip();
  }

  if (under) {
    // tunnel behind, pocket around the body
    ctx.fillStyle = amb.c(pl.tunnel, 0.28);
    ctx.beginPath();
    ctx.moveTo(-3.5, -3.2);
    ctx.quadraticCurveTo(-9, -3.6, -14, -2.6);
    ctx.lineTo(-14, -0.6);
    ctx.quadraticCurveTo(-9, -0.2, -3.5, -0.3);
    oval(ctx, 0.2, -2.0, 5.0, 2.9, 0);
    ctx.fill();
    ctx.strokeStyle = amb.c(pl.tunnelRim, 0.35);
    ctx.lineWidth = 0.18;
    ctx.beginPath(); ctx.ellipse(0.2, -2.0, 5.0, 2.9, 0, PI * 1.1, PI * 1.9); ctx.stroke();
  }

  const bob = eat ? Math.sin(ph * 4) * 0.22 + 0.15 : walking ? Math.abs(Math.sin(ph)) * 0.12 : 0;
  const R = -1.05 + bob;
  const stride = eat ? 0.25 : 0.8;

  // far legs (opposite phase: alternating tripod)
  ctx.strokeStyle = amb.c(pl.legFar, A);
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) scLeg(ctx, -1.9 + i * 1.65 + 0.35, R, ph + i * PI + PI, stride, 0.85);
  ctx.stroke();

  // soft underside
  ctx.fillStyle = amb.c(pl.flesh, A);
  ctx.beginPath();
  ctx.moveTo(SC_X0 + 0.2, R - 0.2);
  ctx.bezierCurveTo(-2.4, R + 0.95, 1.6, R + 0.95, SC_X1 + 0.3, R - 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.fleshDk, 0.7 * A);
  ctx.lineWidth = 0.13;
  ctx.beginPath();
  for (let k = 0; k < 5; k++) {
    const x = -2.6 + k * 1.25;
    ctx.moveTo(x, R + 0.05); ctx.quadraticCurveTo(x + 0.25, R + 0.4, x + 0.05, R + 0.62);
  }
  ctx.stroke();

  // rear telson plates
  ctx.fillStyle = amb.c(pl.shellDk, A);
  ctx.beginPath();
  ctx.moveTo(SC_X0 + 0.3, R - 1.4);
  ctx.quadraticCurveTo(SC_X0 - 0.9, R - 1.2, SC_X0 - 1.0, R - 0.2);
  ctx.quadraticCurveTo(SC_X0 - 0.3, R - 0.45, SC_X0 + 0.4, R - 0.3);
  ctx.fill();

  // carapace dome
  ctx.fillStyle = amb.c(pl.shell, A);
  ctx.beginPath();
  ctx.moveTo(SC_X0, R);
  for (let i = 0; i <= 18; i++) { const u = i / 18; ctx.lineTo(scX(u), R - scTop(u)); }
  ctx.lineTo(SC_X1, R);
  ctx.quadraticCurveTo(0, R + 0.3, SC_X0, R);
  ctx.fill();

  // lateral flange (thickness of the shell edge)
  ctx.fillStyle = amb.c(pl.shellDk, A);
  ctx.beginPath();
  ctx.moveTo(SC_X0, R);
  for (let i = 0; i <= 12; i++) { const u = i / 12; ctx.lineTo(scX(u), R - 0.12 - 0.6 * Math.sin(PI * (0.05 + u * 0.9)) - 0.1); }
  ctx.lineTo(SC_X1, R);
  ctx.quadraticCurveTo(0, R + 0.3, SC_X0, R);
  ctx.fill();

  // plate seams
  const nSeam = (g.bands || 3) + 1;
  ctx.strokeStyle = amb.c(pl.seam, 0.9 * A);
  ctx.lineWidth = 0.13;
  ctx.beginPath();
  for (let k = 0; k < nSeam; k++) {
    const u = 0.1 + (k + 1) / (nSeam + 1) * 0.82;
    const x = scX(u), top = R - scTop(u);
    ctx.moveTo(x + 0.15, R - 0.15);
    ctx.quadraticCurveTo(x - 0.55, (R + top) * 0.5, x - 0.2, top + 0.02);
  }
  ctx.stroke();
  // rim highlights: the leading lip of each plate + a sheen along the crest
  ctx.strokeStyle = amb.c(pl.shellLt, 0.75 * A);
  ctx.lineWidth = 0.15;
  ctx.beginPath();
  for (let k = 0; k < nSeam; k++) {
    const u = 0.1 + (k + 1) / (nSeam + 1) * 0.82;
    const x = scX(u) + 0.24, top = R - scTop(u + 0.03);
    ctx.moveTo(x - 0.25, (R * 0.35 + top * 0.65));
    ctx.quadraticCurveTo(x - 0.4, (R + top) * 0.5 - 0.6, x - 0.12, top + 0.3);
  }
  ctx.moveTo(scX(0.32), R - scTop(0.32) + 0.4);
  for (let i = 1; i <= 6; i++) { const u = 0.32 + i * 0.06; ctx.lineTo(scX(u), R - scTop(u) + 0.4); }
  ctx.stroke();
  // stipple
  ctx.fillStyle = amb.c(pl.stip, 0.75 * A);
  ctx.beginPath();
  for (let i = 0; i < 22; i++) {
    const u = G.st[i * 2], v = G.st[i * 2 + 1];
    sq(ctx, scX(u), R - 0.75 - (scTop(u) - 0.8) * v, juv ? 0.07 : 0.09);
  }
  // dotted edge along the flange top
  for (let i = 1; i < 12; i++) { const u = i / 12; sq(ctx, scX(u), R - 0.35 - 0.6 * Math.sin(PI * (0.05 + u * 0.9)), 0.07); }
  ctx.fill();

  // dorsal spines on each plate crest (not juveniles)
  if (!juv) {
    ctx.fillStyle = amb.c(pl.spine, A);
    ctx.beginPath();
    for (let k = 0; k < nSeam; k++) {
      const u = 0.1 + (k + 1) / (nSeam + 1) * 0.82 - 0.04;
      const x = scX(u), y = R - scTop(u);
      const h = 0.35 + 0.2 * Math.sin(u * PI);
      ctx.moveTo(x - 0.22, y + 0.12);
      ctx.quadraticCurveTo(x - 0.1, y - h * 0.6, x - 0.4, y - h);
      ctx.quadraticCurveTo(x + 0.15, y - h * 0.5, x + 0.24, y + 0.08);
    }
    ctx.fill();
  }
  // lichen patches on adults, thicker on elders
  if (!juv) {
    const nl = st === 'elder' ? 6 : 3;
    ctx.fillStyle = amb.c(pl.lichen, 0.85 * A);
    ctx.beginPath();
    for (let i = 0; i < nl; i++) {
      const u = G.li[i * 3], v = G.li[i * 3 + 1], r = G.li[i * 3 + 2];
      const x = scX(u), y = R - 0.9 - (scTop(u) - 0.9) * v;
      dot(ctx, x, y, r); dot(ctx, x + r * 0.9, y + r * 0.3, r * 0.65);
    }
    ctx.fill();
    ctx.fillStyle = amb.c(pl.lichenDot, 0.9 * A);
    ctx.beginPath();
    for (let i = 0; i < nl; i++) {
      const u = G.li[i * 3], v = G.li[i * 3 + 1];
      sq(ctx, scX(u) + 0.1, R - 0.9 - (scTop(u) - 0.9) * v - 0.1, 0.08);
    }
    ctx.fill();
  }

  // head under the hood
  const hb = eat ? Math.sin(ph * 4 + 1) * 0.18 : 0;
  ctx.fillStyle = amb.c(pl.flesh, A);
  ctx.beginPath();
  oval(ctx, SC_X1 + 0.2, R - 0.35 + hb, 0.85, 0.68, 0.2);
  ctx.fill();
  // mandibles + feeding palps
  const pm = eat ? Math.sin(ph * 8) * 0.25 : Math.sin(world.t * 1.7 + ph) * 0.08;
  ctx.strokeStyle = amb.c(pl.leg, A);
  ctx.lineWidth = 0.17;
  ctx.beginPath();
  ctx.moveTo(SC_X1 + 0.8, R - 0.15 + hb);
  ctx.quadraticCurveTo(SC_X1 + 1.5, R - 0.1 + hb, SC_X1 + 1.45 + pm, R + 0.45 + hb);
  ctx.moveTo(SC_X1 + 0.7, R + 0.05 + hb);
  ctx.quadraticCurveTo(SC_X1 + 1.2, R + 0.4 + hb, SC_X1 + 0.95 - pm, R + 0.8 + hb);
  ctx.moveTo(SC_X1 + 0.6, R - 0.6 + hb);
  ctx.lineTo(SC_X1 + 1.3, R - 0.85 + hb);
  ctx.lineTo(SC_X1 + 1.65 + pm, R - 0.45 + hb);
  ctx.stroke();

  // near legs
  ctx.strokeStyle = amb.c(pl.leg, A);
  ctx.lineWidth = 0.27;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) scLeg(ctx, -1.9 + i * 1.65, R, ph + i * PI, stride, 1);
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.joint, A);
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const p2 = ph + i * PI;
    const sw = Math.sin(p2) * stride, lift = Math.max(0, Math.cos(p2)) * 0.55 * (stride / 0.8);
    dot(ctx, -1.9 + i * 1.65 + 0.55 + sw * 0.3, R - 0.3 - lift * 0.45, 0.14);
  }
  ctx.fill();

  // eye stalks
  const n = g.stalks || 2;
  const look = Math.sin(world.t * 0.9 + ph) * 0.3;
  ctx.strokeStyle = amb.c(pl.flesh, A);
  ctx.lineWidth = 0.24;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const bx = SC_X1 - 0.45 + k * 0.3, by = R - 0.75 + hb;
    const ex = SC_X1 + 0.35 + k * 0.55 + look * (1 - tr), ey = R - 2.55 - (k === 1 ? 0.5 : 0) - tr * 0.6 + hb + Math.sin(world.t * 2.1 + k * 2 + ph) * 0.08;
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + 0.9, by - 0.6, ex, ey);
    XA[k] = ex; YA[k] = ey;
  }
  ctx.stroke();
  const er = juv ? 0.5 : 0.44;
  ctx.fillStyle = amb.c(pl.eyeW, A);
  ctx.beginPath();
  for (let k = 0; k < n; k++) dot(ctx, XA[k], YA[k], er);
  ctx.fill();
  ctx.fillStyle = amb.c(pl.iris, A);
  ctx.beginPath();
  for (let k = 0; k < n; k++) dot(ctx, XA[k] + 0.1, YA[k] + 0.02, er * (tr ? 0.78 : 0.62));
  ctx.fill();
  ctx.fillStyle = amb.c(P.ink, A);
  ctx.beginPath();
  for (let k = 0; k < n; k++) dot(ctx, XA[k] + 0.13, YA[k] + 0.02, er * (tr ? 0.6 : 0.3));
  ctx.fill();
  ctx.fillStyle = amb.c(P.cream, 0.95 * A);
  ctx.beginPath();
  for (let k = 0; k < n; k++) sq(ctx, XA[k] - er * 0.3, YA[k] - er * 0.35, 0.08);
  ctx.fill();

  if (c.inf > 0) infectLocal(ctx, c, amb, -0.6, R - 2.9, 1.6, 1);
  ctx.restore();
}
// jointed leg: hip on the rim, knee raised, foot on the ground
function scLeg(ctx, hx, R, p, stride, k) {
  const sw = Math.sin(p) * stride;
  const lift = Math.max(0, Math.cos(p)) * 0.55 * (stride / 0.8);
  ctx.moveTo(hx, R + 0.1);
  ctx.lineTo(hx + 0.55 + sw * 0.3, R - 0.3 * k - lift * 0.45);
  ctx.lineTo(hx + 1.0 + sw * 0.8, -0.3 - lift * 0.7);
  ctx.lineTo(hx + 1.3 + sw, -lift * 0.5);
}
function scuttlerGlow(ctx, c, world) {
  if (world.night < 0.1) return;
  const s = c.scale * world.U;
  const n = c.genome.stalks || 2;
  if ((c.depth || 0) > 0.02) return; // eyes are clipped below the soil
  const k = 1;
  for (let i = 0; i < n; i++) {
    drawGlow(ctx, c.genome.eye, c.x + c.dir * (3.6 + i * 0.55) * s, c.y - (3.4 + (i === 1 ? 0.5 : 0)) * s, 1.6 * s, world.night * 0.55 * k);
  }
}

// ============================================================ PETALMOTH
function pmPal(g, el) {
  const c1 = fade(g.c1, el);
  return {
    wing: c1,
    wingFar: mixHex(c1, g.c2, 0.22),
    edge: mixHex(c1, P.ink, 0.45),
    tip: fade(g.c2, el),
    vein: mixHex(g.c2, c1, 0.35),
    body: g.c3,
    fuzz: mixHex(c1, P.cream, 0.4),
    band: mixHex(c1, g.c3, 0.2),
    ring: g.c2,
  };
}
// wing ellipse k (0 fore, 1 hind, 2 third pair) on side sd (-1 up, +1 down);
// writes centre/radii/rotation into the scratch slot 40..44
function pmWing(k, a, sd) {
  if (k === 0) { XA[40] = 0.5; YA[40] = sd * 2.3 * a; XA[41] = 1.5; YA[41] = 2.35 * a + 0.18; XA[42] = sd * 0.35; }
  else if (k === 1) { XA[40] = -0.8; YA[40] = sd * 1.6 * a; XA[41] = 1.2; YA[41] = 1.65 * a + 0.14; XA[42] = -sd * 0.45; }
  else { XA[40] = -1.9; YA[40] = sd * 1.0 * a; XA[41] = 0.85; YA[41] = 1.05 * a + 0.1; XA[42] = sd * 0.7; }
}
// point at local (lx, ly) of the current wing ellipse -> XA[43], YA[43]
function pmPt(lx, ly) {
  const r = XA[42], cs = Math.cos(r), sn = Math.sin(r);
  XA[43] = XA[40] + lx * cs - ly * sn; YA[43] = YA[40] + lx * sn + ly * cs;
}
function pmWings(ctx, a, six, mode) {
  for (let sd = -1; sd <= 1; sd += 2) {
    if (mode === 0) {          // hind (+ third) pair
      pmWing(1, a, sd); oval(ctx, XA[40], YA[40], XA[41], YA[41], XA[42]);
      if (six) { pmWing(2, a, sd); oval(ctx, XA[40], YA[40], XA[41], YA[41], XA[42]); }
      continue;
    }
    pmWing(0, a, sd);
    const rx = XA[41], ry = YA[41];
    if (mode === 1) {          // fore pair
      oval(ctx, XA[40], YA[40], rx, ry, XA[42]);
    } else if (mode === 2) {   // coloured outer band
      pmPt(0, sd * ry * 0.6); oval(ctx, XA[43], YA[43], rx * 0.78, ry * 0.36, XA[42]);
    } else if (mode === 3) {   // veins
      for (let v = -1; v <= 1; v++) { ctx.moveTo(0.4, 0); pmPt(v * rx * 0.55, sd * ry * 0.8); ctx.lineTo(XA[43], YA[43]); }
      pmWing(1, a, sd); ctx.moveTo(-0.2, 0); pmPt(-XA[41] * 0.2, sd * YA[41] * 0.8); ctx.lineTo(XA[43], YA[43]);
    } else if (mode === 4) {   // dotted margin
      for (let d = -2; d <= 2; d++) { const th = sd * PI / 2 + d * 0.42; pmPt(Math.cos(th) * rx * 0.86, Math.sin(th) * ry * 0.86); sq(ctx, XA[43], YA[43], 0.1); }
    } else {                   // eye spots (mode 5: ring, 6: white, 7: pupil)
      pmPt(0, sd * ry * 0.18);
      const er = Math.min(rx, ry) * 0.5 * (mode === 5 ? 1 : mode === 6 ? 0.58 : 0.28);
      oval(ctx, XA[43], YA[43], er, er * (mode === 7 ? 1 : Math.min(1, ry / rx + 0.15)), 0);
    }
  }
}
function petalmothDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, pmPal);
  const s = c.scale * world.U;
  const ft = c.flapT || 0;
  const f = c.state === 'perch' ? 0.75 + 0.25 * Math.sin(ft) : 0.15 + 0.85 * Math.abs(Math.sin(ft));
  const tilt = clamp((c.vy || 0) / (20 * world.U), -0.45, 0.45) * c.dir;
  const six = g.wings === 6;
  const tr = c._trance > 0 ? 1 : 0;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(tilt);
  ctx.scale(s * c.dir, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // hind (and third) wings, behind the body
  ctx.fillStyle = amb.c(pl.wingFar, 0.92);
  ctx.beginPath(); pmWings(ctx, f, six, 0); ctx.fill();
  ctx.strokeStyle = amb.c(pl.edge, 0.6);
  ctx.lineWidth = 0.12;
  ctx.stroke();
  // abdomen
  ctx.fillStyle = amb.c(pl.body);
  ctx.beginPath();
  ctx.moveTo(0, -0.42);
  ctx.bezierCurveTo(-1.2, -0.55, -2.4, -0.3, -2.6, 0.15);
  ctx.bezierCurveTo(-2.3, 0.5, -1.0, 0.55, 0, 0.4);
  ctx.fill();
  ctx.fillStyle = amb.c(pl.band, 0.9);
  ctx.beginPath();
  for (let k = 0; k < 4; k++) ctx.rect(-0.55 - k * 0.5, -0.4 + k * 0.03, 0.17, 0.8 - k * 0.08);
  ctx.fill();
  // fore wings, mirrored above and below the body axis
  ctx.fillStyle = amb.c(pl.wing, 0.95);
  ctx.beginPath(); pmWings(ctx, f, six, 1); ctx.fill();
  ctx.strokeStyle = amb.c(pl.edge, 0.75);
  ctx.lineWidth = 0.13;
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.tip, 0.85);
  ctx.beginPath(); pmWings(ctx, f, six, 2); ctx.fill();
  ctx.strokeStyle = amb.c(pl.vein, 0.5);
  ctx.lineWidth = 0.09;
  ctx.beginPath(); pmWings(ctx, f, six, 3); ctx.stroke();
  ctx.fillStyle = amb.c(pl.edge, 0.85);
  ctx.beginPath(); pmWings(ctx, f, six, 4); ctx.fill();
  // a wing-eye on each fore wing
  ctx.fillStyle = amb.c(pl.ring);
  ctx.beginPath(); pmWings(ctx, f, six, 5); ctx.fill();
  ctx.fillStyle = amb.c(P.cream);
  ctx.beginPath(); pmWings(ctx, f, six, 6); ctx.fill();
  ctx.fillStyle = amb.c(P.ink);
  ctx.beginPath(); pmWings(ctx, f, six, 7); ctx.fill();
  // thorax fuzz + head
  ctx.fillStyle = amb.c(pl.fuzz);
  ctx.beginPath(); oval(ctx, 0.55, 0, 0.75, 0.6, 0); ctx.fill();
  ctx.strokeStyle = amb.c(pl.fuzz, 0.8);
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  for (let k = 0; k < 7; k++) {
    const a = -PI * 0.9 + k * 0.3;
    ctx.moveTo(0.55 + Math.cos(a) * 0.6, Math.sin(a) * 0.5);
    ctx.lineTo(0.55 + Math.cos(a) * 0.95, Math.sin(a) * 0.82);
  }
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.body);
  ctx.beginPath(); dot(ctx, 1.45, 0.05, 0.42); ctx.fill();
  ctx.fillStyle = amb.c(pl.ring);
  ctx.beginPath(); dot(ctx, 1.62, -0.05, tr ? 0.28 : 0.2); ctx.fill();
  ctx.fillStyle = amb.c(P.cream);
  ctx.fillRect(1.58, -0.15, 0.08, 0.08);
  // feathered antennae + proboscis
  ctx.strokeStyle = amb.c(pl.body);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  ctx.moveTo(1.6, -0.3); ctx.quadraticCurveTo(2.4, -0.8, 2.75, -1.8);
  ctx.moveTo(1.7, -0.2); ctx.quadraticCurveTo(2.7, -0.4, 3.25, -1.15);
  for (let k = 1; k <= 4; k++) {
    const q = k / 5;
    const x1 = lerp(2.0, 2.75, q), y1 = lerp(-0.6, -1.8, q);
    ctx.moveTo(x1, y1); ctx.lineTo(x1 + 0.35, y1 + 0.05);
    const x2 = lerp(2.2, 3.25, q), y2 = lerp(-0.32, -1.15, q);
    ctx.moveTo(x2, y2); ctx.lineTo(x2 + 0.25, y2 + 0.22);
  }
  const feed = c.state === 'feed';
  ctx.moveTo(1.75, 0.3);
  if (feed) ctx.quadraticCurveTo(2.4, 0.5, 2.6, 1.5);
  else { ctx.quadraticCurveTo(2.2, 0.6, 2.0, 0.75); ctx.quadraticCurveTo(1.8, 0.85, 1.85, 0.6); }
  ctx.stroke();
  if (c.inf > 0) infectLocal(ctx, c, amb, -1.0, -0.4, 0.8, 0.55);
  ctx.restore();
}
function petalmothGlow(ctx, c, world) {
  if (world.night < 0.08) return;
  const s = c.scale * world.U;
  drawGlow(ctx, c.genome.glow, c.x, c.y, 3 * s, world.night * 0.45);
  drawGlow(ctx, c.genome.glow, c.x - c.dir * 2.4 * s, c.y + 0.1 * s, 1.1 * s, world.night * 0.6);
}

// ============================================================ BELLWISP
function bwPal(g, el) {
  const c1 = fade(g.c1, el);
  return {
    skin: c1,
    sheen: mixHex(c1, P.cream, 0.6),
    rim: mixHex(c1, P.ink, 0.4),
    vein: g.c3,
    organ: fade(g.c2, el),
    nuc: g.c3,
    spot: g.c3,
    tend: g.c2,
    tendLt: mixHex(g.c2, P.cream, 0.5),
    bead: mixHex(g.c3, g.c2, 0.3),
    lip: fade(g.c2, el),
    egg: mixHex(g.c2, P.cream, 0.45),
  };
}
function bwSpots(c) {
  let a = c._bwS;
  if (a) return a;
  const g = c.genome, r = mulberry32(g.seed || 3), n = g.spots || 4;
  a = c._bwS = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = r() * TAU, d = 0.5 + r() * 0.45;
    a[i * 3] = Math.cos(t) * 2.3 * d; a[i * 3 + 1] = -1 + Math.sin(t) * 2.4 * d; a[i * 3 + 2] = 0.16 + r() * 0.28;
  }
  return a;
}
function bwBell(ctx, k) {
  ctx.moveTo(0, -4 * k);
  ctx.bezierCurveTo(2.3 * k, -4 * k, 3.3 * k, -0.6 * k, 2.8 * k, 1.9 * k);
  ctx.quadraticCurveTo(1.8 * k, 3.4 * k, 0, 3.3 * k);
  ctx.quadraticCurveTo(-1.8 * k, 3.4 * k, -2.8 * k, 1.9 * k);
  ctx.bezierCurveTo(-3.3 * k, -0.6 * k, -2.3 * k, -4 * k, 0, -4 * k);
}
function bellwispDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, bwPal);
  const s = c.scale * world.U;
  const t = world.t;
  const ph = c.phase || 0;
  const vx = (c.vx || 0) / world.U;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.tilt || 0);
  ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // tendrils (one path), beads recorded in scratch
  const n = g.tendrils || 3;
  const L0 = g.len || 12;
  let nb = 0;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const bx = (i - (n - 1) / 2) * (3.6 / Math.max(1, n - 1));
    let x = bx, y = 3.0;
    ctx.moveTo(x, y);
    const L = L0 * (i % 2 ? 0.8 : 1);
    for (let k = 1; k <= 8; k++) {
      const q = k / 8;
      x = bx * (1 + q * 0.4) + Math.sin(t * 1.3 + i * 1.7 + k * 0.7 + ph) * q * 1.6 - vx * q * 0.35;
      y = 3.0 + q * L;
      ctx.lineTo(x, y);
      if ((k & 1) === 0 && nb < 60) { XA[nb] = x; YA[nb] = y; WA[nb] = k === 8 ? 0.38 : 0.16; nb++; }
    }
  }
  ctx.strokeStyle = amb.c(pl.tend, 0.7);
  ctx.lineWidth = 0.3;
  ctx.stroke();
  ctx.strokeStyle = amb.c(pl.tendLt, 0.45);
  ctx.lineWidth = 0.1;
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.bead, 0.85);
  ctx.beginPath();
  for (let i = 0; i < nb; i++) dot(ctx, XA[i], YA[i], WA[i]);
  ctx.fill();
  // frilly oral skirt under the lip
  ctx.strokeStyle = amb.c(pl.lip, 0.6);
  ctx.lineWidth = 0.22;
  ctx.beginPath();
  for (let k = -3; k <= 3; k++) {
    const x0 = k * 0.6;
    const w = Math.sin(t * 2 + k + ph) * 0.35;
    ctx.moveTo(x0, 3.1);
    ctx.quadraticCurveTo(x0 + w, 3.9, x0 - w * 0.5, 4.6 + Math.abs(k) * -0.15);
  }
  ctx.stroke();
  const breathe = 1 + Math.sin(t * 0.9 + ph) * 0.04;
  ctx.scale(breathe, 1 / breathe);
  // bladder
  ctx.fillStyle = amb.c(pl.skin, 0.72);
  ctx.beginPath(); bwBell(ctx, 1); ctx.fill();
  ctx.strokeStyle = amb.c(pl.rim, 0.7);
  ctx.lineWidth = 0.16;
  ctx.stroke();
  // inner membrane sheen
  ctx.save();
  ctx.translate(-0.45, -0.5);
  ctx.fillStyle = amb.c(pl.sheen, 0.28);
  ctx.beginPath(); bwBell(ctx, 0.72); ctx.fill();
  ctx.restore();
  // veins: meridians with dotted cross-ribs
  ctx.strokeStyle = amb.c(pl.vein, 0.24);
  ctx.lineWidth = 0.13;
  ctx.beginPath();
  ctx.moveTo(-1.2, -3.6); ctx.quadraticCurveTo(-2.3, 0, -1.6, 3.15);
  ctx.moveTo(1.2, -3.6); ctx.quadraticCurveTo(2.3, 0, 1.6, 3.15);
  ctx.moveTo(-0.4, -3.95); ctx.quadraticCurveTo(-0.8, 0, -0.55, 3.3);
  ctx.moveTo(0.4, -3.95); ctx.quadraticCurveTo(0.8, 0, 0.55, 3.3);
  ctx.stroke();
  // organ + clutch of eggs + nucleus
  const pulse = 1 + Math.sin(t * 2.4 + ph) * 0.06 + (c._trance > 0 ? 0.15 : 0);
  ctx.fillStyle = amb.c(pl.organ, 0.8);
  ctx.beginPath(); oval(ctx, 0, 0.9, 1.25 * pulse, 1.75 * pulse, 0); ctx.fill();
  ctx.fillStyle = amb.c(pl.egg, 0.75);
  ctx.beginPath();
  dot(ctx, -0.55, 1.6, 0.32); dot(ctx, 0.1, 2.0, 0.28); dot(ctx, 0.6, 1.45, 0.25); dot(ctx, -0.2, 1.05, 0.22);
  ctx.fill();
  ctx.fillStyle = amb.c(pl.nuc, 0.9);
  ctx.beginPath(); dot(ctx, 0, 0.35, 0.45 * pulse); ctx.fill();
  // spots
  const sp = bwSpots(c);
  ctx.fillStyle = amb.c(pl.spot, 0.6);
  ctx.beginPath();
  for (let i = 0; i < sp.length; i += 3) dot(ctx, sp[i], sp[i + 1], sp[i + 2]);
  ctx.fill();
  // crown + lip scallops (one colour)
  ctx.fillStyle = amb.c(pl.lip, 0.88);
  ctx.beginPath();
  for (let k = -1; k <= 1; k++) oval(ctx, k * 0.7, -4.3 + Math.abs(k) * 0.25, 0.32, 0.75, k * 0.5);
  for (let k = -2; k <= 2; k++) { const x = k * 0.75, y = 3.15 - Math.abs(k) * 0.12; ctx.moveTo(x + 0.4, y); ctx.arc(x, y, 0.4, 0, PI); }
  ctx.fill();
  // dotted rim (fine linework)
  ctx.fillStyle = amb.c(pl.rim, 0.6);
  ctx.beginPath();
  for (let k = 0; k < 9; k++) {
    const a = -PI * 0.85 + k * 0.21;
    sq(ctx, Math.cos(a) * 2.55, -0.6 + Math.sin(a) * 3.0, 0.08);
  }
  ctx.fill();
  if (c.inf > 0) infectLocal(ctx, c, amb, 0.6, -3.7, 1.2, 0.8);
  ctx.restore();
}
function bellwispGlow(ctx, c, world) {
  const s = c.scale * world.U;
  const k = 0.15 + world.night * 0.75;
  drawGlow(ctx, c.genome.glow, c.x, c.y + 0.9 * s, 4.5 * s, k * (0.4 + (c.energy || 0) * 0.6));
  if (world.night > 0.2) drawGlow(ctx, c.genome.glow, c.x, c.y + (3 + (c.genome.len || 12)) * s, 1.4 * s, world.night * 0.5);
}

// ============================================================ RIBBONFIN
function rfPal(g, el) {
  const c1 = fade(g.c1, el);
  return {
    body: c1,
    belly: mixHex(c1, P.cream, 0.5),
    back: mixHex(c1, g.c2, 0.45),
    fin: fade(g.c2, el),
    finDk: mixHex(g.c2, P.ink, 0.35),
    ray: mixHex(g.c2, g.c3, 0.5),
    line: g.c3,
    rib: fade(g.c2, el),
    ribLt: mixHex(c1, P.cream, 0.3),
  };
}
function ribbonfinDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, rfPal);
  const s = c.scale * world.U;
  const t = c.swim || 0;
  const inAir = c.state === 'jump';
  const a = inAir ? 1 : 0.86;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.ang || 0);
  ctx.scale(s * c.dir, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // ribbon tail as a twisting filled band
  const L = g.ribbon || 8;
  const N = 12;
  for (let k = 0; k <= N; k++) {
    const q = k / N;
    const x = -2 - q * L, y = Math.sin(t * 2.2 - q * 5) * q * 1.6;
    const w = (0.65 - q * 0.4) * (0.35 + 0.65 * Math.abs(Math.cos(t * 1.6 - q * 4)));
    XA[k] = x; YA[k] = y - w; XB[k] = x; YB[k] = y + w;
  }
  ctx.fillStyle = amb.c(pl.rib, a * 0.85);
  ctx.beginPath();
  ctx.moveTo(XA[0], YA[0]);
  for (let k = 1; k <= N; k++) ctx.lineTo(XA[k], YA[k]);
  for (let k = N; k >= 0; k--) ctx.lineTo(XB[k], YB[k]);
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.ribLt, a * 0.7);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  ctx.moveTo(XA[0], (YA[0] + YB[0]) / 2);
  for (let k = 1; k <= N; k++) ctx.lineTo(XA[k], (YA[k] + YB[k]) / 2);
  // hatching across the ribbon
  for (let k = 1; k < N; k += 1) { ctx.moveTo(XA[k], YA[k]); ctx.lineTo(XB[k] - 0.15, YB[k]); }
  ctx.stroke();
  // dorsal sail and ventral fin
  const fl = Math.sin(t * 3) * 0.2;
  ctx.fillStyle = amb.c(pl.fin, a * 0.75);
  ctx.beginPath();
  ctx.moveTo(1.8, -0.9);
  ctx.quadraticCurveTo(0.6, -2.6 - fl, -1.4, -2.3 + fl);
  ctx.quadraticCurveTo(-1.9, -1.2, -2.2, -0.4);
  ctx.moveTo(0.6, 0.8);
  ctx.quadraticCurveTo(-0.4, 2.0 + fl, -1.5, 1.6);
  ctx.lineTo(-1.6, 0.5);
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.ray, a * 0.6);
  ctx.lineWidth = 0.09;
  ctx.beginPath();
  const nf = g.frills || 5;
  for (let k = 0; k < nf; k++) {
    const q = k / (nf - 1 || 1);
    const x0 = lerp(1.5, -2.0, q);
    ctx.moveTo(x0, -0.9 + q * 0.4);
    ctx.lineTo(lerp(0.9, -1.5, q), lerp(-2.4, -2.25, q) - Math.sin(q * PI) * 0.25 - fl * (1 - q));
  }
  ctx.stroke();
  // body
  ctx.fillStyle = amb.c(pl.body, a);
  ctx.beginPath();
  ctx.moveTo(3.3, 0.05);
  ctx.bezierCurveTo(2.7, -1.4, 0.4, -1.55, -2.3, -0.45);
  ctx.lineTo(-2.3, 0.45);
  ctx.bezierCurveTo(0.4, 1.5, 2.6, 1.2, 3.3, 0.05);
  ctx.fill();
  // back saddle + belly
  ctx.fillStyle = amb.c(pl.back, a);
  ctx.beginPath();
  ctx.moveTo(3.0, -0.4);
  ctx.bezierCurveTo(2.3, -1.3, 0.4, -1.45, -2.3, -0.45);
  ctx.lineTo(-2.3, -0.15);
  ctx.bezierCurveTo(0, -0.55, 1.8, -0.45, 3.0, -0.4);
  ctx.fill();
  ctx.fillStyle = amb.c(pl.belly, a * 0.85);
  ctx.beginPath();
  ctx.moveTo(2.9, 0.4);
  ctx.bezierCurveTo(2.0, 1.15, 0.3, 1.25, -2.2, 0.42);
  ctx.bezierCurveTo(0.2, 0.6, 1.8, 0.55, 2.9, 0.4);
  ctx.fill();
  // frills along the flank (genome-driven), gill slits, dotted lateral line
  ctx.fillStyle = amb.c(pl.fin, a * 0.9);
  ctx.beginPath();
  for (let k = 0; k < nf; k++) {
    const x = 1.2 - k * (3.2 / nf);
    const h = 0.42 + Math.sin(t * 3 + k) * 0.15;
    oval(ctx, x, 0.75 - Math.abs(x) * 0.05, 0.22, h, -0.5);
  }
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.line, 0.5 * a);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) { const x = 2.0 - k * 0.28; ctx.moveTo(x, -0.55); ctx.quadraticCurveTo(x - 0.2, 0, x, 0.5); }
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.line, 0.6 * a);
  ctx.beginPath();
  for (let k = 0; k < 8; k++) sq(ctx, 1.3 - k * 0.45, 0.05 - k * 0.012, 0.07);
  ctx.fill();
  // eye
  const tr = c._trance > 0;
  ctx.fillStyle = amb.c(P.cream, a);
  ctx.beginPath(); dot(ctx, 2.45, -0.3, 0.34); ctx.fill();
  ctx.fillStyle = amb.c(P.ink, a);
  ctx.beginPath(); dot(ctx, 2.55, -0.3, tr ? 0.27 : 0.17); ctx.fill();
  if (c.inf > 0) infectLocal(ctx, c, amb, 0, -1.0, 1.2, 0.7);
  ctx.restore();
}
function ribbonfinGlow(ctx, c, world) {
  if (world.night < 0.1) return;
  const s = c.scale * world.U;
  drawGlow(ctx, c.genome.glow, c.x, c.y, 3.5 * s, world.night * 0.5);
  const L = (c.genome.ribbon || 8) * s;
  drawGlow(ctx, c.genome.glow, c.x - c.dir * (2 * s + L * 0.6), c.y, 1.6 * s, world.night * 0.35);
}

// ============================================================ STILTSTRIDER
function ssPal(g, el) {
  const c1 = fade(g.c1, el);
  return {
    body: c1,
    stripe: fade(g.c2, el),
    belly: g.c3,
    leg: g.c2,
    legFar: mixHex(g.c2, P.ink, 0.38),
    knee: g.c3,
    pad: mixHex(g.c2, P.ink, 0.2),
    tuft: g.c4 || P.coral,
    stud: g.c4 || P.coral,
    neckLine: mixHex(g.c2, c1, 0.3),
    cup: g.c4 || P.coral,
    cupDk: mixHex(g.c4 || P.coral, P.ink, 0.35),
    throat: mixHex(P.ink, g.c2, 0.25),
    eyes: g.c3,
    hatch: mixHex(c1, P.ink, 0.35),
  };
}
const SS_H3 = new Float32Array([-2.6, 0, 2.6]);
const SS_H2 = new Float32Array([-2.4, 2.4]);
// compute leg i into scratch slot j: hip(XA,YA) knee(XB,YB) foot(XA[j+32], YA[j+32])
function ssLeg(j, hx, ph, rest, bodyY) {
  const stride = 2.0 * (1 - rest);
  const fx = hx + Math.sin(ph) * stride - rest * hx * 0.2;
  const lift = Math.max(0, Math.cos(ph)) * 1.1 * (1 - rest);
  const fy = -lift;
  const hy = bodyY + 1.4;
  const mx = (hx + fx) / 2, my = (hy + fy) / 2;
  XA[j] = hx; YA[j] = hy;
  XB[j] = mx - 1.1 - rest * 2.2; YB[j] = my - 0.4 - rest * 1.0;
  XA[j + 32] = fx; YA[j + 32] = fy;
}
function ssLegs(ctx, amb, pl, hips, n, gait, rest, bodyY, far) {
  for (let i = 0; i < n; i++) ssLeg(i, hips[i] + (far ? 0.4 : 0), gait * PI + i * 1.3 + (far ? PI : 0), rest, bodyY);
  const col = far ? pl.legFar : pl.leg;
  // thigh (thick)
  ctx.strokeStyle = amb.c(col);
  ctx.lineWidth = far ? 0.7 : 0.85;
  ctx.beginPath();
  for (let i = 0; i < n; i++) { ctx.moveTo(XA[i], YA[i]); ctx.lineTo(XB[i], YB[i]); }
  ctx.stroke();
  // shank (thin) with a little hooked toe
  ctx.lineWidth = far ? 0.42 : 0.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const fx = XA[i + 32], fy = YA[i + 32];
    ctx.moveTo(XB[i], YB[i]); ctx.lineTo(fx, fy - 0.2);
  }
  ctx.stroke();
  ctx.fillStyle = amb.c(far ? pl.legFar : pl.pad);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const fx = XA[i + 32], fy = YA[i + 32];
    ctx.moveTo(fx - 0.4, fy);
    ctx.quadraticCurveTo(fx, fy - 0.75, fx + 0.85, fy);
    ctx.closePath();
  }
  ctx.fill();
  ctx.fillStyle = amb.c(pl.knee, far ? 0.6 : 0.95);
  ctx.beginPath();
  for (let i = 0; i < n; i++) dot(ctx, XB[i], YB[i], 0.34);
  ctx.fill();
}
function stiltstriderDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, ssPal);
  const s = c.scale * world.U;
  const rest = c.rest || 0;
  const legH = g.leg * (1 - rest * 0.62);
  const bob = Math.abs(Math.sin((c.gait || 0) * PI)) * 0.35 * (1 - rest);
  const bodyY = -legH - bob;
  c._bodyY = bodyY;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(s * c.dir, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const n = g.legs === 6 ? 3 : 2;
  const hips = n === 3 ? SS_H3 : SS_H2;
  ssLegs(ctx, amb, pl, hips, n, c.gait || 0, rest, bodyY, true);
  // tail tuft
  ctx.strokeStyle = amb.c(pl.tuft, 0.9);
  ctx.lineWidth = 0.28;
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const sw = Math.sin(world.t * 1.2 + k) * 0.4;
    ctx.moveTo(-4.8, bodyY - 0.3); ctx.quadraticCurveTo(-6, bodyY + 0.4 + k * 0.35, -6.1 + sw - k * 0.15, bodyY + 1.8 + k * 0.45);
  }
  ctx.stroke();
  // body
  ctx.fillStyle = amb.c(pl.body);
  ctx.beginPath();
  ctx.moveTo(-5, bodyY + 0.3);
  ctx.bezierCurveTo(-5.2, bodyY - 2.6, -1.8, bodyY - 3.6, 0.6, bodyY - 3.1);
  ctx.bezierCurveTo(3.2, bodyY - 2.8, 5.2, bodyY - 1.6, 5.0, bodyY + 0.2);
  ctx.bezierCurveTo(4.6, bodyY + 2.6, -4.4, bodyY + 3.2, -5, bodyY + 0.3);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = amb.c(pl.stripe, 0.85);
  ctx.beginPath();
  const ns = g.stripes || 4;
  for (let k = 0; k < ns; k++) {
    const x = -4 + (k + 0.5) * (8 / ns);
    ctx.moveTo(x - 0.3, bodyY - 3.6);
    ctx.quadraticCurveTo(x + 0.9, bodyY, x - 0.2, bodyY + 3.4);
    ctx.lineTo(x + 0.45, bodyY + 3.4);
    ctx.quadraticCurveTo(x + 1.5, bodyY, x + 0.35, bodyY - 3.6);
  }
  ctx.fill();
  ctx.fillStyle = amb.c(pl.belly, 0.6);
  ctx.beginPath(); oval(ctx, 0.3, bodyY + 2.1, 4.4, 1.3, 0); ctx.fill();
  ctx.restore();
  // belly fringe hatching + dorsal studs
  ctx.strokeStyle = amb.c(pl.hatch, 0.55);
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  for (let k = 0; k < 11; k++) {
    const x = -3.8 + k * 0.75;
    const y = bodyY + 1.95 + Math.sin((k / 10) * PI) * 0.75 - 0.4;
    ctx.moveTo(x, y); ctx.lineTo(x - 0.15, y + 0.5);
  }
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.stud);
  ctx.beginPath();
  for (let k = 0; k < 5; k++) dot(ctx, -3.0 + k * 1.35, bodyY - 3.05 + Math.abs(k - 2) * 0.22 + (k === 2 ? -0.1 : 0), 0.3 + (k === 2 ? 0.1 : 0));
  ctx.fill();
  // neck + head (reach-to-food IK)
  let hx = 4.6 + g.neck * 0.45, hy = bodyY - g.neck * (0.95 - rest * 0.7);
  if (c.reach) {
    const lx = (c.reach[0] - c.x) / s * c.dir;
    const ly = (c.reach[1] - c.y) / s;
    const d = Math.hypot(lx - 4, ly - bodyY);
    const maxR = g.neck * 1.25;
    const k = d > maxR ? maxR / d : 1;
    hx = lerp(hx, 4 + (lx - 4) * k - 0.6, 0.85);
    hy = lerp(hy, bodyY + (ly - bodyY) * k + 0.4, 0.85);
  }
  hy += Math.sin(world.t * 0.8 + (c.phase || 0)) * 0.3;
  c._hx = lerp(c._hx ?? hx, hx, 0.15); c._hy = lerp(c._hy ?? hy, hy, 0.15);
  hx = c._hx; hy = c._hy;
  const cx = 5.6, cy = bodyY - 2.5;
  ctx.strokeStyle = amb.c(pl.body);
  ctx.lineWidth = 1.15;
  ctx.beginPath(); ctx.moveTo(3.6, bodyY - 1.4); ctx.quadraticCurveTo(cx, cy, hx, hy); ctx.stroke();
  // neck rings
  ctx.strokeStyle = amb.c(pl.neckLine, 0.75);
  ctx.lineWidth = 0.14;
  ctx.beginPath();
  for (let k = 1; k < 7; k++) {
    const q = k / 7, iq = 1 - q;
    const x = iq * iq * 3.6 + 2 * iq * q * cx + q * q * hx;
    const y = iq * iq * (bodyY - 1.4) + 2 * iq * q * cy + q * q * hy;
    const tx = 2 * iq * (cx - 3.6) + 2 * q * (hx - cx), ty = 2 * iq * (cy - bodyY + 1.4) + 2 * q * (hy - cy);
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl * 0.5, ny = tx / tl * 0.5;
    ctx.moveTo(x - nx, y - ny); ctx.lineTo(x + nx, y + ny);
  }
  ctx.stroke();
  // cup head
  const ang = Math.atan2(hy - cy, hx - cx);
  const open = c.headOpen ?? 0.3;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(ang);
  ctx.fillStyle = amb.c(pl.cup);
  ctx.beginPath();
  ctx.moveTo(-0.7, -0.6);
  ctx.quadraticCurveTo(1.2, -0.75, 2.4, -1.25 - open * 1.1);
  ctx.lineTo(2.55, 1.25 + open * 1.1);
  ctx.quadraticCurveTo(1.2, 0.75, -0.7, 0.6);
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.cupDk, 0.7);
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  ctx.moveTo(0, -0.55); ctx.quadraticCurveTo(1.4, -0.6, 2.1, -1.0 - open);
  ctx.moveTo(0, 0.55); ctx.quadraticCurveTo(1.4, 0.6, 2.2, 1.0 + open);
  ctx.moveTo(0.3, 0); ctx.lineTo(2.0, 0);
  ctx.stroke();
  const ry = 1.25 + open * 1.1;
  ctx.fillStyle = amb.c(pl.throat);
  ctx.beginPath(); oval(ctx, 2.45, 0, 0.45 + open * 0.35, ry, 0); ctx.fill();
  ctx.strokeStyle = amb.c(pl.belly);
  ctx.lineWidth = 0.22;
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.eyes);
  ctx.beginPath();
  const ne = g.eyes || 5;
  const er = c._trance > 0 ? 0.24 : 0.17;
  for (let k = 0; k < ne; k++) {
    const a = (k / ne) * TAU;
    dot(ctx, 2.45 + Math.cos(a) * 0.15, Math.sin(a) * ry * 0.72, er);
  }
  ctx.fill();
  ctx.restore();
  ssLegs(ctx, amb, pl, hips, n, c.gait || 0, rest, bodyY, false);
  if (c.inf > 0) infectLocal(ctx, c, amb, -1.2, bodyY - 2.9, 2.2, 1.3);
  ctx.restore();
  const hd = c._head || (c._head = [0, 0]);
  hd[0] = c.x + hx * s * c.dir; hd[1] = c.y + hy * s;
}
function stiltstriderGlow(ctx, c, world) {
  if (world.night < 0.1 || !c._head) return;
  const s = c.scale * world.U;
  drawGlow(ctx, c.genome.eye, c._head[0] + c.dir * 2 * s, c._head[1], 3 * s, world.night * (0.25 + (1 - (c.rest || 0)) * 0.4));
}

// ============================================================ MINDBLOOM
function mbPal(g, el) {
  const c1 = fade(g.c1, el);
  return {
    mantle: c1,
    mantleDk: mixHex(c1, g.c3, 0.35),
    rib: mixHex(c1, g.c3, 0.55),
    rimDot: mixHex(g.c2, P.cream, 0.3),
    arm: c1,
    armAlt: mixHex(c1, g.c3, 0.3),
    sucker: g.c2,
    tether: g.c3,
    r0: g.c2, r1: P.ink, r2: c1, r3: g.c3, r4: P.cream,
    striate: mixHex(g.c2, P.ink, 0.5),
    lid: mixHex(c1, g.c3, 0.2),
  };
}
function mbRing(pl, k) { switch (k % 5) { case 0: return pl.r0; case 1: return pl.r1; case 2: return pl.r2; case 3: return pl.r3; default: return pl.r4; } }
function mindbloomDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, mbPal);
  const s = c.scale * world.U;
  const t = world.t;
  const ph = c.phase || 0;
  // tendril to the glass ceiling (world space)
  const ax = (c.ax ?? 0.2) * world.W;
  ctx.strokeStyle = amb.c(pl.tether, 0.8);
  ctx.lineWidth = Math.max(1, 0.5 * s);
  ctx.beginPath();
  ctx.moveTo(ax, 0);
  ctx.quadraticCurveTo(ax + Math.sin(t * 0.3 + ph) * 6 * world.U, ((world.topInset || 0) + c.y) * 0.5, c.x, c.y - 3.5 * s);
  ctx.stroke();
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // arms: two colours, two paths; suckers recorded to scratch
  const n = g.arms || 6;
  let nb = 0;
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = amb.c(pass ? pl.arm : pl.armAlt, 0.9);
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    for (let i = pass; i < n; i += 2) {
      const bx = (i - (n - 1) / 2) * (7 / (n - 1));
      ctx.moveTo(bx, 2.4);
      let x = bx, y = 2.4;
      const L = 7 + (i % 3) * 1.6;
      for (let k = 1; k <= 7; k++) {
        const q = k / 7;
        x = bx * (1 + q * 0.25) + Math.sin(t * 0.9 + i * 1.1 + k * 0.8) * q * 1.4;
        y = 2.4 + q * L;
        ctx.lineTo(x, y);
        if (k >= 2 && nb < 60) { XA[nb] = x + 0.32; YA[nb] = y; WA[nb] = k === 7 ? 0.4 : 0.14 * (1.2 - q * 0.6); nb++; }
      }
    }
    ctx.stroke();
  }
  ctx.fillStyle = amb.c(pl.sucker, 0.85);
  ctx.beginPath();
  for (let i = 0; i < nb; i++) dot(ctx, XA[i], YA[i], WA[i]);
  ctx.fill();
  // mantle
  const pk = c.pulseK || 0;
  const sw = 1 + pk * 0.08;
  ctx.scale(sw, sw);
  ctx.fillStyle = amb.c(pl.mantle);
  ctx.beginPath();
  ctx.moveTo(-5, 2.2);
  ctx.bezierCurveTo(-5.6, -3.5, -2.5, -5.2, 0, -5.2);
  ctx.bezierCurveTo(2.5, -5.2, 5.6, -3.5, 5, 2.2);
  for (let k = 4; k >= -4; k--) ctx.quadraticCurveTo(k * 1.2 + 0.6, 3.5, k * 1.2 - 0.1 + (k === -4 ? -0.9 : 0), 2.3);
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.mantleDk, 0.6);
  ctx.lineWidth = 0.2;
  ctx.stroke();
  // radial ribs + dotted rim
  ctx.strokeStyle = amb.c(pl.rib, 0.45);
  ctx.lineWidth = 0.14;
  ctx.beginPath();
  for (let k = 0; k < 9; k++) {
    const a = PI + 0.2 + k * ((PI - 0.4) / 8);
    ctx.moveTo(Math.cos(a) * 3.8, -1 + Math.sin(a) * 3.8);
    ctx.lineTo(Math.cos(a) * 4.9, -0.6 + Math.sin(a) * 4.5);
  }
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.rimDot, 0.9);
  ctx.beginPath();
  for (let k = -4; k <= 4; k++) dot(ctx, k * 1.2 + 0.55, 2.85, 0.16);
  ctx.fill();
  // eye: concentric rings
  const ex = (c.lookX || 0) * 0.6, ey = -1 + (c.lookY || 0) * 0.4;
  const R = g.rings || 3;
  for (let k = 0; k < R; k++) {
    const r = 3.4 * (1 - k / (R + 0.5));
    ctx.fillStyle = amb.c(mbRing(pl, k));
    ctx.beginPath(); dot(ctx, ex * (k / R), ey + (k / R) * 0.2, r); ctx.fill();
  }
  // iris striations around the pupil
  ctx.strokeStyle = amb.c(pl.striate, 0.55);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  const r1 = 3.4 * (1 - (R - 1) / (R + 0.5));
  for (let k = 0; k < 12; k++) {
    const a = k * (TAU / 12);
    ctx.moveTo(ex + Math.cos(a) * r1 * 0.45, ey + 0.2 + Math.sin(a) * r1 * 0.45);
    ctx.lineTo(ex + Math.cos(a) * r1 * 0.95, ey + 0.2 + Math.sin(a) * r1 * 0.95);
  }
  ctx.stroke();
  const blink = (Math.sin(t * 0.37 + ph) > 0.985) ? 0.1 : 1;
  const dil = pk > 0.3 ? 1.6 : 1;
  ctx.fillStyle = amb.c(P.ink);
  ctx.beginPath(); oval(ctx, ex, ey + 0.2, 0.3 * dil, 1.1 * blink, 0); ctx.fill();
  ctx.fillStyle = amb.c(P.cream, 0.9);
  ctx.fillRect(ex - 1.0, ey - 0.9, 0.35, 0.35);
  if (blink < 1) {
    ctx.fillStyle = amb.c(pl.lid);
    ctx.beginPath(); oval(ctx, 0, ey, 3.5, 2.8, 0); ctx.fill();
  }
  if (c.inf > 0) infectLocal(ctx, c, amb, -2.5, -4.4, 1.5, 1);
  ctx.restore();
}
function mindbloomGlow(ctx, c, world) {
  const s = c.scale * world.U;
  const k = 0.2 + world.night * 0.4 + (c.pulseK || 0) * 0.6;
  drawGlow(ctx, c.genome.glow, c.x, c.y - s, 9 * s, Math.min(1, k));
}

// ============================================================ HOOKJAW
// Low, long ground stalker: armoured segment chain, spidery many-jointed
// legs whose knees ride above the back, a hinged hook-tipped lower jaw.
function hjPal(g, el) {
  const c1 = fade(g.c1, el);
  const eye = g.eye || g.glow || P.glowAmber;
  return {
    body: c1,
    plate: mixHex(c1, g.c3, 0.5),
    plateLt: mixHex(c1, P.cream, 0.35),
    belly: fade(g.c2, el),
    bellyDk: mixHex(g.c2, g.c3, 0.4),
    swell: mixHex(g.c2, P.coral, 0.45),
    hatch: mixHex(g.c3, P.ink, 0.3),
    leg: mixHex(g.c3, c1, 0.25),
    legFar: mixHex(g.c3, P.ink, 0.5),
    joint: fade(g.c2, el),
    bone: mixHex(P.bone, g.c2, 0.3),
    mouth: mixHex(P.rust, P.ink, 0.55),
    gum: mixHex(P.coral, P.plum, 0.3),
    eye,
    eyeDk: P.ink,
    spine: mixHex(P.bone, g.c3, 0.35),
  };
}
const HJ_RY = new Float32Array([0.7, 0.95, 1.12, 1.18, 1.08, 0.92]);
// leg i of 5: hip on the body side, knee 1 high above the back, knee 2, foot
function hjLeg(ctx, x, bodyY, i, p, stride, crouch, pk, k) {
  const spread = (i - 2) * 0.55 + pk * (i < 2 ? -1.2 : 1.0);
  const sw = Math.sin(p) * stride;
  const lift = Math.max(0, Math.cos(p)) * 0.6 * (stride > 0.05 ? 1 : 0);
  const kneeH = 2.3 + crouch * 0.8 - pk * 0.8;
  const fx = x + spread * 1.8 + sw + (i - 2) * 0.3;
  ctx.moveTo(x, bodyY + 0.2);
  ctx.lineTo(x + spread * 0.5 + sw * 0.2, bodyY - kneeH * k);
  ctx.lineTo(x + spread * 1.4 + sw * 0.7, bodyY + 0.9 - lift * 0.4);
  ctx.lineTo(fx, -lift);
  XA[i] = x + spread * 0.5 + sw * 0.2; YA[i] = bodyY - kneeH * k;
}
function hookjawDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, hjPal);
  const s = c.scale * world.U;
  const t = world.t;
  const st = c.state;
  const gait = c.gait || 0;
  const pk = st === 'pounce' ? Math.max(0.6, c.pounceK || 0) : (c.pounceK || 0);
  const crouch = st === 'stalk' ? 1 : 0;
  const dig = st === 'digest' ? 1 : 0;
  const eat = st === 'eat';
  const jaw = clamp(c.jawOpen ?? (eat ? 0.5 + 0.5 * Math.sin(t * 7) : st === 'stalk' ? 0.2 : 0.05), 0, 1);
  const stretch = 1 + pk * 0.28;
  const bodyY = -2.5 + crouch * 0.85 - pk * 0.35 + (dig ? 0.3 : 0);
  const moving = st === 'walk' || st === 'stalk';
  const stride = moving ? (crouch ? 0.5 : 0.85) : 0;
  const tr = c._trance > 0 ? 1 : 0;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(s * c.dir, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // segment centres
  for (let i = 0; i < 6; i++) {
    XB[i] = (-5.2 + i * 1.85) * stretch;
    YB[i] = bodyY + Math.sin(gait * 2 + i * 0.9) * 0.08 * (moving ? 1 : 0) - (i === 5 ? 0.15 : 0);
    WA[i] = HJ_RY[i] + (dig && (i === 2 || i === 3) ? 0.6 : dig && (i === 1 || i === 4) ? 0.25 : 0);
  }
  // far legs
  ctx.strokeStyle = amb.c(pl.legFar);
  ctx.lineWidth = 0.26;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) hjLeg(ctx, XB[i] + 0.9 * stretch + 0.3, YB[i], i, gait + i * 1.25 + PI, stride, crouch, pk, 0.85);
  ctx.stroke();
  // tail: tapering, curled, barbed
  const tw = Math.sin(t * 1.4 + (c.phase || 0)) * 0.3 * (1 - pk);
  const N = 8;
  for (let k = 0; k <= N; k++) {
    const q = k / N;
    const x = XB[0] - 0.6 - q * 4.6 * (1 + pk * 0.2);
    const y = bodyY - 0.1 - q * q * (1.8 - pk * 1.4) + Math.sin(q * 3 + t * 1.4) * tw;
    const w = 0.62 * (1 - q * 0.8);
    XA[20 + k] = x; YA[20 + k] = y; WA[20 + k] = w;
  }
  ctx.fillStyle = amb.c(pl.body);
  ctx.beginPath();
  ctx.moveTo(XA[20], YA[20] - WA[20]);
  for (let k = 1; k <= N; k++) ctx.lineTo(XA[20 + k], YA[20 + k] - WA[20 + k]);
  const tx = XA[20 + N], ty = YA[20 + N];
  ctx.quadraticCurveTo(tx - 0.9, ty - 0.6, tx - 0.5, ty - 1.3);   // barb
  ctx.quadraticCurveTo(tx - 0.4, ty - 0.3, tx + 0.2, ty + 0.2);
  for (let k = N; k >= 0; k--) ctx.lineTo(XA[20 + k], YA[20 + k] + WA[20 + k]);
  ctx.fill();
  // body segments
  ctx.fillStyle = amb.c(pl.body);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) oval(ctx, XB[i], YB[i], 1.3 * stretch * (i === 5 ? 0.95 : 1), WA[i], 0);
  ctx.fill();
  // swollen translucent belly while digesting / plain belly otherwise
  ctx.fillStyle = amb.c(dig ? pl.swell : pl.belly, dig ? 0.85 : 0.9);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ry = WA[i];
    ctx.moveTo(XB[i] - 1.2 * stretch, YB[i] + ry * 0.2);
    ctx.ellipse(XB[i], YB[i] + ry * 0.2, 1.2 * stretch, ry * 0.78, 0, PI, 0, true);
  }
  ctx.fill();
  if (dig) {
    // a shadowy meal inside
    ctx.fillStyle = amb.c(pl.bellyDk, 0.55);
    ctx.beginPath(); oval(ctx, (XB[2] + XB[3]) / 2, YB[2] + 0.45, 1.6, 0.65, 0.1); ctx.fill();
  }
  // dorsal plates
  ctx.fillStyle = amb.c(pl.plate);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ry = WA[i];
    const x = XB[i] + 0.15, y = YB[i] - ry * 0.1;
    ctx.moveTo(x - 1.25 * stretch, y);
    ctx.ellipse(x, y, 1.25 * stretch, ry * 0.95, 0, PI, TAU);
    ctx.quadraticCurveTo(x, y - ry * 0.35, x - 1.25 * stretch, y);
  }
  ctx.fill();
  // plate hatching + rim highlights
  ctx.strokeStyle = amb.c(pl.hatch, 0.65);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ry = WA[i];
    for (let k = -2; k <= 2; k++) {
      const x = XB[i] + 0.15 + k * 0.38 * stretch;
      ctx.moveTo(x, YB[i] - ry * 0.25);
      ctx.lineTo(x + 0.12, YB[i] - ry * 0.75 + Math.abs(k) * 0.12);
    }
  }
  ctx.stroke();
  ctx.strokeStyle = amb.c(pl.plateLt, 0.7);
  ctx.lineWidth = 0.13;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ry = WA[i];
    ctx.moveTo(XB[i] + 1.0 * stretch, YB[i] - ry * 0.45);
    ctx.quadraticCurveTo(XB[i] + 0.7 * stretch, YB[i] - ry * 1.02, XB[i] - 0.2, YB[i] - ry * 1.02);
  }
  ctx.stroke();
  // hooked dorsal spines
  ctx.fillStyle = amb.c(pl.spine);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const x = XB[i] - 0.2, y = YB[i] - WA[i] * 1.0;
    const h = 0.55 + (i === 2 || i === 3 ? 0.2 : 0);
    ctx.moveTo(x - 0.25, y + 0.15);
    ctx.quadraticCurveTo(x - 0.2, y - h, x - 0.7, y - h * 1.05);
    ctx.quadraticCurveTo(x + 0.1, y - h * 0.6, x + 0.3, y + 0.12);
  }
  ctx.fill();

  // head
  const eatDip = eat ? Math.sin(t * 7) * 0.25 + 0.4 : 0;
  const hx = XB[5] + 1.1 * stretch, hy = YB[5] + eatDip + crouch * 0.25;
  // mouth interior
  const ja = jaw * 0.85;
  const cj = Math.cos(ja), sj = Math.sin(ja);
  if (jaw > 0.04) {
    ctx.fillStyle = amb.c(pl.mouth);
    ctx.beginPath();
    ctx.moveTo(hx + 0.2, hy + 0.2);
    ctx.lineTo(hx + 3.0, hy - 0.05);
    ctx.lineTo(hx + 0.2 + 2.8 * cj, hy + 0.2 + 2.8 * sj);
    ctx.fill();
  }
  // lower jaw: hinged blade with an upturned hook
  ctx.save();
  ctx.translate(hx + 0.2, hy + 0.25);
  ctx.rotate(ja);
  ctx.fillStyle = amb.c(pl.bone);
  ctx.beginPath();
  ctx.moveTo(-0.3, -0.3);
  ctx.lineTo(2.6, -0.15);
  ctx.quadraticCurveTo(3.4, -0.2, 3.35, -1.05);   // hook up
  ctx.quadraticCurveTo(3.7, 0.2, 2.6, 0.45);
  ctx.quadraticCurveTo(1.2, 0.75, -0.3, 0.45);
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.bone);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  for (let k = 0; k < 6; k++) { const x = 0.3 + k * 0.42; ctx.moveTo(x, -0.18); ctx.lineTo(x + 0.12, -0.55 - (k & 1) * 0.12); }
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.gum, 0.8);
  ctx.beginPath(); ctx.rect(0, 0.08, 2.5, 0.12); ctx.fill();
  ctx.restore();
  // skull + upper hooked fang
  ctx.fillStyle = amb.c(pl.plate);
  ctx.beginPath();
  ctx.moveTo(hx - 0.9, hy - 0.95);
  ctx.quadraticCurveTo(hx + 0.6, hy - 1.75, hx + 2.3, hy - 0.85);
  ctx.quadraticCurveTo(hx + 3.2, hy - 0.5, hx + 3.35, hy + 0.35);   // down-curved beak hook
  ctx.quadraticCurveTo(hx + 2.8, hy - 0.05, hx + 2.2, hy + 0.05);
  ctx.lineTo(hx + 0.1, hy + 0.35);
  ctx.quadraticCurveTo(hx - 0.8, hy + 0.5, hx - 0.9, hy - 0.95);
  ctx.fill();
  ctx.fillStyle = amb.c(pl.bone);
  ctx.beginPath();
  ctx.moveTo(hx + 2.5, hy - 0.62);
  ctx.quadraticCurveTo(hx + 3.15, hy - 0.4, hx + 3.35, hy + 0.35);
  ctx.quadraticCurveTo(hx + 2.95, hy - 0.05, hx + 2.35, hy - 0.05);
  // upper teeth
  for (let k = 0; k < 4; k++) { const x = hx + 0.5 + k * 0.45; ctx.moveTo(x, hy + 0.1); ctx.lineTo(x + 0.15, hy + 0.5); ctx.lineTo(x + 0.3, hy + 0.06); }
  ctx.fill();
  // cheek seam + eyes
  ctx.strokeStyle = amb.c(pl.hatch, 0.7);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  ctx.moveTo(hx - 0.5, hy - 0.2); ctx.quadraticCurveTo(hx + 0.6, hy - 0.6, hx + 1.9, hy - 0.4);
  ctx.stroke();
  const er = tr ? 1.4 : 1;
  ctx.fillStyle = amb.c(pl.eyeDk);
  ctx.beginPath();
  dot(ctx, hx + 0.35, hy - 1.05, 0.22 * er); dot(ctx, hx + 0.9, hy - 1.18, 0.28 * er); dot(ctx, hx + 1.45, hy - 1.02, 0.2 * er);
  ctx.fill();
  ctx.fillStyle = amb.c(pl.eye);
  ctx.beginPath();
  sq(ctx, hx + 0.42, hy - 1.12, 0.07); sq(ctx, hx + 0.98, hy - 1.27, 0.09); sq(ctx, hx + 1.5, hy - 1.08, 0.06);
  ctx.fill();
  // near legs + joints
  ctx.strokeStyle = amb.c(pl.leg);
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) hjLeg(ctx, XB[i] + 0.9 * stretch, YB[i] + 0.1, i, gait + i * 1.25, stride, crouch, pk, 1);
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.joint);
  ctx.beginPath();
  for (let i = 0; i < 5; i++) dot(ctx, XA[i], YA[i], 0.17);
  ctx.fill();
  if (c.inf > 0) infectLocal(ctx, c, amb, -1.0, bodyY - 1.05, 2.4, 1);
  c._jaw = hx; // local head x for glow placement
  ctx.restore();
}
function hookjawGlow(ctx, c, world) {
  const s = c.scale * world.U;
  const n = world.night;
  const hx = c._jaw ?? 5.3;
  const st = c.state;
  const crouch = st === 'stalk' ? 1 : 0;
  const pk = st === 'pounce' ? Math.max(0.6, c.pounceK || 0) : (c.pounceK || 0);
  const bodyY = -2.5 + crouch * 0.85 - pk * 0.35;
  const eye = c.genome.eye || c.genome.glow || P.glowAmber;
  if (n > 0.1) drawGlow(ctx, eye, c.x + c.dir * (hx + 0.9) * s, c.y + (bodyY - 1.2) * s, 1.5 * s, n * (st === 'stalk' || st === 'pounce' ? 0.9 : 0.55));
  if (st === 'digest') drawGlow(ctx, P.glowAmber, c.x - c.dir * 0.6 * s, c.y + (bodyY + 0.6) * s, 4 * s, 0.15 + n * 0.35);
}

// ============================================================ LANCEWING
// Needle-bodied aerial diver: long blade wings, translucent with dark spars,
// trailing filaments. Rotates to its velocity as it folds into a dive.
function lwPal(g, el) {
  const c1 = fade(g.c1, el);
  const glow = g.glow || g.eye || P.glowCyan;
  return {
    body: c1,
    bodyDk: mixHex(c1, g.c3, 0.45),
    band: fade(g.c2, el),
    mem: mixHex(g.c2, c1, 0.25),
    memFar: mixHex(g.c2, g.c3, 0.35),
    spar: g.c3,
    vein: mixHex(g.c3, g.c2, 0.4),
    tipSpot: mixHex(g.c3, P.ink, 0.3),
    beak: mixHex(P.bone, c1, 0.25),
    fil: mixHex(g.c2, g.c3, 0.3),
    eye: glow,
    swell: mixHex(g.c2, P.coral, 0.5),
  };
}
function lwWing(ctx, f, fold, side, mode) {
  // side +1 upper/near, -1 lower/far
  const spread = (0.12 + f * 1.3) * (1 - fold);
  const a = PI + side * (spread + 0.1 + fold * 0.06);
  const L = 5.6 - fold * 0.6;
  const dx = Math.cos(a), dy = Math.sin(a), nx = -dy * side, ny = dx * side;
  const w = 1.3 * (0.55 + 0.45 * Math.max(f, fold));
  const bx = 0.9, by = -0.1;
  const tx = bx + dx * L, ty = by + dy * L;
  if (mode === 0) {
    // narrow scythe blade: leading edge straight, trailing edge bellied
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + dx * L * 0.6 - nx * 0.15, by + dy * L * 0.6 - ny * 0.15, tx - nx * 0.1, ty - ny * 0.1);
    ctx.quadraticCurveTo(tx - dx * 0.2 + nx * w * 0.5, ty - dy * 0.2 + ny * w * 0.5, bx + dx * L * 0.65 + nx * w, by + dy * L * 0.65 + ny * w);
    ctx.quadraticCurveTo(bx + dx * L * 0.2 + nx * w * 1.3, by + dy * L * 0.2 + ny * w * 1.3, bx - 0.8, by + 0.15);
  } else if (mode === 1) {
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + dx * L * 0.6 - nx * 0.15, by + dy * L * 0.6 - ny * 0.15, tx - nx * 0.1, ty - ny * 0.1);
  } else if (mode === 2) {
    for (let k = 1; k < 7; k++) {
      const q = k / 7;
      const px = bx + dx * L * q, py = by + dy * L * q;
      const ww = w * (q < 0.65 ? 1.15 * (0.6 + q * 0.6) : (1 - q) * 2.4);
      ctx.moveTo(px, py); ctx.lineTo(px + nx * ww * 0.85 - dx * 0.25, py + ny * ww * 0.85 - dy * 0.25);
    }
  } else {
    dot(ctx, tx - dx * 0.7 + nx * 0.3, ty - dy * 0.7 + ny * 0.3, 0.26);
  }
}
function lancewingDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, lwPal);
  const s = c.scale * world.U;
  const U = world.U;
  const t = world.t;
  const st = c.state;
  const fold = clamp(c.fold ?? (st === 'dive' ? 1 : 0), 0, 1);
  const ft = c.flapT || 0;
  const soar = st === 'soar' || st === 'digest';
  const f = (soar ? 0.35 + 0.25 * Math.sin(ft * 0.5) : 0.15 + 0.85 * Math.abs(Math.sin(ft))) * (1 - fold);
  const vx = c.vx || 0, vy = c.vy || 0;
  const tilt = clamp(vy / (20 * U), -0.5, 0.5) * c.dir;
  const full = (vx || vy) ? Math.atan2(vy, vx * c.dir) * c.dir : 0;
  const rot = lerp(tilt, full, fold);
  const dig = st === 'digest' ? 1 : 0;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(rot);
  ctx.scale(s * c.dir, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // trailing filaments
  ctx.strokeStyle = amb.c(pl.fil, 0.75);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const L = 5.5 + k * 1.3 + fold * 1.5;
    ctx.moveTo(-3.6, 0.05 * k);
    for (let j = 1; j <= 5; j++) {
      const q = j / 5;
      ctx.lineTo(-3.6 - q * L, Math.sin(t * 3 + k * 1.7 - q * 4) * q * (0.9 - fold * 0.6) + (k - 1) * q * 0.6);
    }
    XA[k] = -3.6 - L; YA[k] = Math.sin(t * 3 + k * 1.7 - 4) * (0.9 - fold * 0.6) + (k - 1) * 0.6;
  }
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.band);
  ctx.beginPath();
  for (let k = 0; k < 3; k++) dot(ctx, XA[k], YA[k], 0.2);
  ctx.fill();
  // far wing
  ctx.fillStyle = amb.c(pl.memFar, 0.5);
  ctx.beginPath(); lwWing(ctx, f, fold, -1, 0); ctx.fill();
  ctx.strokeStyle = amb.c(pl.spar, 0.6);
  ctx.lineWidth = 0.14;
  ctx.beginPath(); lwWing(ctx, f, fold, -1, 1); ctx.stroke();
  // body: lance with a needle rostrum
  ctx.fillStyle = amb.c(pl.body);
  ctx.beginPath();
  ctx.moveTo(6.4, -0.05);                          // needle tip
  ctx.lineTo(3.0, -0.32);
  ctx.quadraticCurveTo(2.2, -0.85, 1.0, -0.62);    // head crest
  ctx.quadraticCurveTo(-0.4, -0.5 - dig * 0.5, -1.6, -0.35 - dig * 0.3);
  ctx.quadraticCurveTo(-3.0, -0.18, -3.9, 0.02);
  ctx.quadraticCurveTo(-3.0, 0.25, -1.6, 0.4 + dig * 0.4);
  ctx.quadraticCurveTo(-0.4, 0.6 + dig * 0.7, 1.0, 0.5);
  ctx.quadraticCurveTo(2.4, 0.45, 3.0, 0.2);
  ctx.closePath();
  ctx.fill();
  if (dig) {
    ctx.fillStyle = amb.c(pl.swell, 0.8);
    ctx.beginPath(); oval(ctx, -0.6, 0.05, 1.2, 0.55, 0); ctx.fill();
  }
  // banding + dark dorsal line
  ctx.fillStyle = amb.c(pl.bodyDk);
  ctx.beginPath();
  ctx.moveTo(3.0, -0.32); ctx.quadraticCurveTo(2.2, -0.85, 1.0, -0.62);
  ctx.quadraticCurveTo(-0.4, -0.5, -1.6, -0.35); ctx.quadraticCurveTo(-3.0, -0.18, -3.9, 0.02);
  ctx.quadraticCurveTo(-2.0, -0.12, 1.0, -0.3); ctx.quadraticCurveTo(2.2, -0.4, 3.0, -0.32);
  for (let k = 0; k < 5; k++) ctx.rect(-1.2 - k * 0.55, -0.25 + k * 0.03, 0.16, 0.5 - k * 0.06);
  ctx.fill();
  ctx.fillStyle = amb.c(pl.beak);
  ctx.beginPath();
  ctx.moveTo(6.4, -0.05); ctx.lineTo(3.4, -0.25); ctx.lineTo(3.4, 0.12); ctx.closePath();
  ctx.fill();
  // eye
  ctx.fillStyle = amb.c(P.ink);
  ctx.beginPath(); dot(ctx, 2.15, -0.25, c._trance > 0 ? 0.36 : 0.28); ctx.fill();
  ctx.fillStyle = amb.c(pl.eye);
  ctx.fillRect(2.2, -0.36, 0.1, 0.1);
  // near wing on top
  ctx.fillStyle = amb.c(pl.mem, 0.62);
  ctx.beginPath(); lwWing(ctx, f, fold, 1, 0); ctx.fill();
  ctx.strokeStyle = amb.c(pl.vein, 0.5);
  ctx.lineWidth = 0.07;
  ctx.beginPath(); lwWing(ctx, f, fold, 1, 2); ctx.stroke();
  ctx.strokeStyle = amb.c(pl.spar);
  ctx.lineWidth = 0.15;
  ctx.beginPath(); lwWing(ctx, f, fold, 1, 1); ctx.stroke();
  ctx.fillStyle = amb.c(pl.tipSpot);
  ctx.beginPath(); lwWing(ctx, f, fold, 1, 3); ctx.fill();
  if (c.inf > 0) infectLocal(ctx, c, amb, -0.8, -0.45, 0.9, 0.55);
  c._rot = rot;
  ctx.restore();
}
function lancewingGlow(ctx, c, world) {
  const s = c.scale * world.U;
  const n = world.night;
  const glow = c.genome.glow || c.genome.eye || P.glowCyan;
  const r = c._rot || 0;
  const cs = Math.cos(r), sn = Math.sin(r);
  if (n > 0.1) {
    // eye glint + filament tips
    const ex = 2.15 * c.dir * s, ey = -0.25 * s;
    drawGlow(ctx, glow, c.x + ex * cs - ey * sn, c.y + ex * sn + ey * cs, 1.3 * s, n * 0.7);
    const tx = -10 * c.dir;
    drawGlow(ctx, glow, c.x + tx * s * cs, c.y + tx * s * sn, 1.4 * s, n * 0.4);
  }
  if (c.state === 'digest') drawGlow(ctx, P.glowAmber, c.x - c.dir * 0.6 * s * cs, c.y - c.dir * 0.6 * s * sn, 2.5 * s, 0.12 + n * 0.3);
}

// ============================================================ MIREEEL
// Sinuous pond ambusher with a frilled underbite and a dangling lure.
function mePal(g, el) {
  const c1 = fade(g.c1, el);
  const glow = g.glow || g.eye || P.glowLime;
  return {
    body: c1,
    back: mixHex(c1, g.c3, 0.5),
    belly: mixHex(fade(g.c2, el), P.cream, 0.25),
    fin: mixHex(g.c2, c1, 0.3),
    finRay: mixHex(g.c3, g.c2, 0.3),
    frill: fade(g.c2, el),
    frillDk: mixHex(g.c2, g.c3, 0.45),
    spot: mixHex(g.c3, P.ink, 0.2),
    line: mixHex(P.cream, g.c2, 0.3),
    mouth: mixHex(P.plum, P.ink, 0.5),
    tooth: P.bone,
    eyeW: mixHex(P.cream, P.mint, 0.25),
    lure: glow,
    lureStem: mixHex(c1, g.c3, 0.3),
  };
}
const ME_N = 14;
function mireeelDraw(ctx, c, world, amb) {
  const g = c.genome;
  const pl = palOf(c, mePal);
  const s = c.scale * world.U;
  const t = c.swim || 0;
  const wt = world.t;
  const st = c.state;
  const strike = st === 'strike' ? 1 : 0;
  const jaw = clamp(c.jawOpen ?? (strike ? 1 : st === 'eat' ? 0.4 + 0.4 * Math.sin(wt * 6) : 0.1), 0, 1);
  const a = 0.85;
  const amp = strike ? 0.25 : 1;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.ang || 0);
  ctx.scale(s * c.dir, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // spine (head at +x) and width profile
  for (let k = 0; k <= ME_N; k++) {
    const q = k / ME_N;                       // 0 head .. 1 tail
    const x = 3.0 - q * (14 + strike * 1.5);
    const y = Math.sin(t * 2.4 - q * 6.5) * (0.15 + q * 1.3) * amp;
    const w = q < 0.12 ? 0.95 + q * 2 : (1.2 * (1 - q) + 0.08) * (1 - q * 0.25);
    XA[k] = x; YA[k] = y; WA[k] = w;
  }
  // dorsal + ventral fin ribbons (behind body)
  ctx.fillStyle = amb.c(pl.fin, a * 0.7);
  ctx.beginPath();
  ctx.moveTo(XA[4], YA[4] - WA[4]);
  for (let k = 4; k <= ME_N; k++) ctx.lineTo(XA[k], YA[k] - WA[k] - 0.55 * Math.sin((k - 3) / (ME_N - 3) * PI) - (k === ME_N ? 0.5 : 0));
  ctx.lineTo(XA[ME_N] - 0.6, YA[ME_N]);
  for (let k = ME_N; k >= 7; k--) ctx.lineTo(XA[k], YA[k] + WA[k] + 0.45 * Math.sin((k - 6) / (ME_N - 6) * PI) + (k === ME_N ? 0.5 : 0));
  ctx.lineTo(XA[7], YA[7]);
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.finRay, a * 0.55);
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  for (let k = 5; k <= ME_N; k++) {
    ctx.moveTo(XA[k], YA[k] - WA[k]);
    ctx.lineTo(XA[k] - 0.25, YA[k] - WA[k] - 0.5 * Math.sin((k - 3) / (ME_N - 3) * PI) - (k === ME_N ? 0.45 : 0));
  }
  ctx.stroke();
  // body
  ctx.fillStyle = amb.c(pl.body, a);
  ctx.beginPath();
  ctx.moveTo(XA[0], YA[0] - WA[0]);
  for (let k = 1; k <= ME_N; k++) ctx.lineTo(XA[k], YA[k] - WA[k]);
  for (let k = ME_N; k >= 0; k--) ctx.lineTo(XA[k], YA[k] + WA[k]);
  ctx.fill();
  // dark back band
  ctx.fillStyle = amb.c(pl.back, a);
  ctx.beginPath();
  ctx.moveTo(XA[0], YA[0] - WA[0]);
  for (let k = 1; k <= ME_N; k++) ctx.lineTo(XA[k], YA[k] - WA[k]);
  for (let k = ME_N; k >= 0; k--) ctx.lineTo(XA[k], YA[k] - WA[k] * 0.25);
  ctx.fill();
  // pale belly
  ctx.fillStyle = amb.c(pl.belly, a * 0.9);
  ctx.beginPath();
  ctx.moveTo(XA[0], YA[0] + WA[0] * 0.3);
  for (let k = 1; k <= ME_N - 3; k++) ctx.lineTo(XA[k], YA[k] + WA[k] * 0.4);
  for (let k = ME_N - 3; k >= 0; k--) ctx.lineTo(XA[k], YA[k] + WA[k]);
  ctx.fill();
  // spots on the back + dotted lateral line
  ctx.fillStyle = amb.c(pl.spot, a);
  ctx.beginPath();
  for (let k = 2; k < ME_N - 1; k++) dot(ctx, XA[k] - 0.3, YA[k] - WA[k] * 0.62, 0.13 + WA[k] * 0.1);
  ctx.fill();
  ctx.fillStyle = amb.c(pl.line, a * 0.85);
  ctx.beginPath();
  for (let k = 1; k < ME_N - 1; k++) { sq(ctx, XA[k], YA[k] - WA[k] * 0.05, 0.07); sq(ctx, (XA[k] + XA[k + 1]) / 2, (YA[k] + YA[k + 1]) / 2 - WA[k] * 0.05, 0.05); }
  ctx.fill();
  // head: frilled underbite
  const hx = XA[0], hy = YA[0];
  const ja = jaw * 0.75;
  const cj = Math.cos(ja), sj = Math.sin(ja);
  // mouth cavity
  if (jaw > 0.05) {
    ctx.fillStyle = amb.c(pl.mouth, a);
    ctx.beginPath();
    ctx.moveTo(hx - 0.6, hy + 0.15);
    ctx.lineTo(hx + 2.1, hy - 0.2);
    ctx.lineTo(hx - 0.6 + 2.8 * cj, hy + 0.15 + 2.8 * sj);
    ctx.fill();
  }
  // gill frill fan around the throat
  ctx.fillStyle = amb.c(pl.frill, a * 0.9);
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const an = 0.6 + k * 0.38 + ja * 0.4;
    const r = 1.4 + (k & 1) * 0.35 + Math.sin(wt * 3 + k) * 0.1;
    const bx = hx - 0.9, by = hy + 0.4;
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + Math.cos(an - 0.2) * r * 1.1, by + Math.sin(an - 0.2) * r * 1.1, bx + Math.cos(an) * r, by + Math.sin(an) * r);
    ctx.quadraticCurveTo(bx + Math.cos(an + 0.25) * r * 0.7, by + Math.sin(an + 0.25) * r * 0.7, bx, by);
  }
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.frillDk, a * 0.7);
  ctx.lineWidth = 0.07;
  ctx.stroke();
  // lower jaw
  ctx.save();
  ctx.translate(hx - 0.6, hy + 0.2);
  ctx.rotate(ja);
  ctx.fillStyle = amb.c(pl.belly, a);
  ctx.beginPath();
  ctx.moveTo(0, -0.2); ctx.lineTo(3.0, -0.25); ctx.quadraticCurveTo(3.25, 0.1, 2.8, 0.3);
  ctx.quadraticCurveTo(1.2, 0.75, 0, 0.6);
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.tooth, a);
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  for (let k = 0; k < 7; k++) { const x = 0.4 + k * 0.38; ctx.moveTo(x, -0.2); ctx.lineTo(x + 0.05, -0.55 - (k & 1) * 0.15); }
  ctx.stroke();
  ctx.restore();
  // upper head
  ctx.fillStyle = amb.c(pl.back, a);
  ctx.beginPath();
  ctx.moveTo(hx - 0.8, hy - 1.0);
  ctx.quadraticCurveTo(hx + 1.0, hy - 1.05, hx + 2.3, hy - 0.35);
  ctx.lineTo(hx + 2.1, hy - 0.05);
  ctx.lineTo(hx - 0.6, hy + 0.2);
  ctx.fill();
  ctx.strokeStyle = amb.c(pl.tooth, a);
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  for (let k = 0; k < 6; k++) { const x = hx - 0.2 + k * 0.38; ctx.moveTo(x, hy + 0.08 - k * 0.04); ctx.lineTo(x + 0.06, hy + 0.42 - k * 0.04); }
  ctx.stroke();
  // milky eye
  const tr = c._trance > 0;
  ctx.fillStyle = amb.c(pl.eyeW, a);
  ctx.beginPath(); dot(ctx, hx + 0.55, hy - 0.55, 0.3); ctx.fill();
  ctx.fillStyle = amb.c(P.ink, a);
  ctx.beginPath(); oval(ctx, hx + 0.6, hy - 0.55, tr ? 0.2 : 0.07, 0.22, 0); ctx.fill();
  // lure: filament arcing over the snout and dangling
  const sway = Math.sin(wt * 1.3 + (c.phase || 0)) * 0.6;
  const lx = hx + 3.4 + sway * 0.5 - strike * 1.2, ly = hy + 0.6 + Math.abs(sway) * 0.3 - strike * 1.5;
  ctx.strokeStyle = amb.c(pl.lureStem, a);
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  ctx.moveTo(hx + 0.2, hy - 0.95);
  ctx.bezierCurveTo(hx + 1.0, hy - 3.6, hx + 3.6 + sway, hy - 3.2, lx, ly - 0.35);
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.lure);
  ctx.beginPath(); oval(ctx, lx, ly, 0.28, 0.38, 0); ctx.fill();
  ctx.fillStyle = amb.c(pl.lureStem, a);
  ctx.beginPath(); sq(ctx, lx, ly - 0.42, 0.1); ctx.fill();
  c._lure = lx; c._lureY = ly;
  if (c.inf > 0) infectLocal(ctx, c, amb, -3, YA[4] - WA[4], 2.0, 0.8);
  ctx.restore();
}
function mireeelGlow(ctx, c, world) {
  const s = c.scale * world.U;
  const glow = c.genome.glow || c.genome.eye || P.glowLime;
  const r = c.ang || 0, cs = Math.cos(r), sn = Math.sin(r);
  const lx = (c._lure ?? 6.4) * c.dir, ly = c._lureY ?? 0.6;
  const x = c.x + (lx * cs - ly * sn) * s, y = c.y + (lx * sn + ly * cs) * s;
  const pulse = 0.75 + 0.25 * Math.sin(world.t * 2.2 + (c.phase || 0));
  drawGlow(ctx, glow, x, y, 2.6 * s, (0.3 + world.night * 0.6) * pulse);
  if (world.night > 0.15) drawGlow(ctx, glow, x, y, 0.9 * s, world.night * 0.9);
}

// ============================================================ PLANTS
function wq(p) { return Math.round((p.wither || 0) * 10) / 10; }
function plantPal(p, build) {
  const w = wq(p);
  let pl = p._pal;
  if (!pl || pl._w !== w || pl._g !== p.genome) { pl = p._pal = build(p.genome, w); pl._w = w; pl._g = p.genome; }
  return pl;
}
function wc(hex, w) { return w > 0 ? mixHex(hex, P.ochre, w * 0.7) : hex; }
function swayOf(p, world, k) {
  const t = world.t * (1 - world.night * 0.4);
  return (Math.sin(t * 0.7 + p.x * 0.013) * 0.6 + Math.sin(t * 1.9 + p.x * 0.051) * 0.25 + (world.gust || 0) * Math.sin(t * 3 + p.x * 0.02)) * k;
}

// ------------------------------------------------------------ SNAPLURE
function slPal(g, w) {
  const c1 = wc(g.c1 || P.olive, w), c2 = wc(g.c2 || P.coral, w), c3 = g.c3 || P.bone;
  return {
    stem: c1,
    stemDk: mixHex(c1, P.ink, 0.35),
    leaf: mixHex(c1, P.moss, 0.3),
    outer: c1,
    outerLt: mixHex(c1, P.cream, 0.3),
    inner: c2,
    innerDk: mixHex(c2, P.plum, 0.45),
    gland: mixHex(c2, P.cream, 0.5),
    tooth: wc(c3, w),
    bulge: mixHex(c1, c2, 0.4),
    vein: mixHex(c1, P.ink, 0.5),
    lure: g.glow || P.glowAmber,
    lureStem: mixHex(c2, c1, 0.5),
  };
}
function slLobe(ctx, side, open, R, W) {
  // lobe in trap space: hinge at origin, axis up (-y); side -1 left, +1 right
  const a = -PI / 2 + side * open;
  const dx = Math.cos(a), dy = Math.sin(a), nx = -dy * side, ny = dx * side;
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(nx * W * 1.1, ny * W * 1.1, dx * R + nx * W, dy * R + ny * W, dx * R, dy * R);
  ctx.quadraticCurveTo(dx * R * 0.5 - nx * W * 0.2, dy * R * 0.5 - ny * W * 0.2, 0, 0);
}
function slTeeth(ctx, side, open, R, W, n, L) {
  const a = -PI / 2 + side * open;
  const dx = Math.cos(a), dy = Math.sin(a), nx = -dy * side, ny = dx * side;
  // teeth along the inner rim (the straight edge), pointing inward / up
  for (let k = 1; k <= n; k++) {
    const q = 0.25 + (k / n) * 0.78;
    const px = dx * R * q - nx * W * 0.05 * Math.sin(q * PI), py = dy * R * q - ny * W * 0.05 * Math.sin(q * PI);
    ctx.moveTo(px, py);
    ctx.lineTo(px - nx * L + dx * 0.25, py - ny * L + dy * 0.25);
  }
}
function snaplureDraw(ctx, p, world, amb) {
  const U = world.U, g = p.genome;
  const pl = plantPal(p, slPal);
  const w = wq(p);
  const fade = w > 0.5 ? 0.7 : 1;
  const h = p.height || 6;
  const gr = p.growth ?? 1;
  ctx.save();
  ctx.translate(p.x, world.groundY(p.x));
  ctx.scale(U, U);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // basal rosette
  ctx.fillStyle = amb.c(pl.leaf, fade);
  ctx.beginPath();
  blade(ctx, 0, 0, -PI * 0.92, 2.6 * (0.5 + gr * 0.5), 0.55, 0.8);
  blade(ctx, 0, 0, -PI * 0.08, 2.4 * (0.5 + gr * 0.5), 0.5, 0.8);
  blade(ctx, 0, 0, -PI * 0.75, 1.6 * gr, 0.4, 0.8);
  ctx.fill();
  // stalk
  const sw = swayOf(p, world, 0.08) - w * 0.4;
  const top = h * 0.72;
  const tx = Math.sin(sw) * top, ty = -Math.cos(sw) * top;
  ctx.strokeStyle = amb.c(pl.stem, fade);
  ctx.lineWidth = 0.55;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-0.6, ty * 0.4, tx * 0.3 + 0.8, ty * 0.75, tx, ty);
  ctx.stroke();
  ctx.strokeStyle = amb.c(pl.stemDk, 0.6 * fade);
  ctx.lineWidth = 0.12;
  ctx.beginPath();
  for (let k = 1; k < 6; k++) {
    const q = k / 6, iq = 1 - q;
    const x = 3 * iq * iq * q * -0.6 + 3 * iq * q * q * (tx * 0.3 + 0.8) + q * q * q * tx;
    const y = 3 * iq * iq * q * ty * 0.4 + 3 * iq * q * q * ty * 0.75 + q * q * q * ty;
    ctx.moveTo(x - 0.3, y); ctx.lineTo(x + 0.3, y - 0.15);
  }
  ctx.stroke();
  // trap state
  const snap = p.snapT > 0 ? 1 - p.snapT / 0.6 : 0;
  const closing = p.snapT > 0 ? smooth(Math.min(1, snap * 4)) : 0;
  const shut = Math.max(p.closed || 0, closing);
  const shudder = p.snapT > 0 ? Math.sin(snap * 40) * 0.06 * (1 - snap) : 0;
  const open = lerp(0.78, 0.06, shut) + shudder + w * 0.2;
  const R = (1.6 + gr * 1.6) * (h > 0 ? 1 : 1);
  const W = R * (0.48 + (p.closed || 0) * 0.18);
  ctx.save();
  ctx.translate(tx, ty);
  ctx.rotate(sw * 0.6 + 0.12 + w * 0.6);
  // outer lobe surfaces
  ctx.fillStyle = amb.c((p.closed || 0) > 0.5 ? pl.bulge : pl.outer, fade);
  ctx.beginPath();
  slLobe(ctx, -1, open, R, W); slLobe(ctx, 1, open, R, W);
  ctx.fill();
  // inner flesh visible when open
  if (shut < 0.85) {
    const io = open * 0.92;
    ctx.fillStyle = amb.c(pl.inner, fade);
    ctx.beginPath();
    slLobe(ctx, -1, io, R * 0.9, W * (0.55 - shut * 0.4)); slLobe(ctx, 1, io, R * 0.9, W * (0.55 - shut * 0.4));
    ctx.fill();
    // glands
    ctx.fillStyle = amb.c(pl.gland, 0.85 * fade);
    ctx.beginPath();
    for (let side = -1; side <= 1; side += 2) {
      const a = -PI / 2 + side * io * 0.8;
      for (let k = 1; k <= 3; k++) sq(ctx, Math.cos(a) * R * 0.25 * k, Math.sin(a) * R * 0.25 * k, 0.1);
    }
    ctx.fill();
  }
  // veins on the outer surface (hatching)
  ctx.strokeStyle = amb.c(pl.vein, 0.5 * fade);
  ctx.lineWidth = 0.09;
  ctx.beginPath();
  for (let side = -1; side <= 1; side += 2) {
    const a = -PI / 2 + side * open;
    const dx = Math.cos(a), dy = Math.sin(a), nx = -dy * side, ny = dx * side;
    for (let k = 1; k <= 4; k++) {
      const q = k / 5;
      ctx.moveTo(dx * R * q * 0.9, dy * R * q * 0.9);
      ctx.lineTo(dx * R * q + nx * W * 0.75 * Math.sin(q * PI + 0.3), dy * R * q + ny * W * 0.75 * Math.sin(q * PI + 0.3));
    }
  }
  ctx.stroke();
  // rim teeth (interlock when shut)
  ctx.strokeStyle = amb.c(pl.tooth, fade);
  ctx.lineWidth = 0.13;
  ctx.beginPath();
  slTeeth(ctx, -1, open, R, W, 6, 0.75 - shut * 0.15);
  slTeeth(ctx, 1, open, R, W, 6, 0.75 - shut * 0.15);
  ctx.stroke();
  // lure: fake nectar bead on a curled filament
  if (shut < 0.5 && gr > 0.35) {
    const lsw = Math.sin(world.t * 1.6 + p.x) * 0.25;
    ctx.strokeStyle = amb.c(pl.lureStem, fade);
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(0, -0.2);
    ctx.quadraticCurveTo(0.6 + lsw, -R * 0.8, lsw * 1.5, -R * 1.05);
    ctx.stroke();
    ctx.fillStyle = amb.c(pl.lure, 0.95 * fade);
    ctx.beginPath(); oval(ctx, lsw * 1.5, -R * 1.05 + 0.25, 0.28, 0.36, 0); ctx.fill();
  }
  ctx.restore();
  p._lure = shut < 0.5 && gr > 0.35 ? 1 : 0;
  p._tx = tx; p._ty = ty; p._R = R; p._rot = sw * 0.6 + 0.12 + w * 0.6;
  ctx.restore();
}
function snaplureGlow(ctx, p, world) {
  const n = world.night;
  if (n < 0.05 || !p._lure) return;
  const U = world.U;
  const gy = world.groundY(p.x);
  const r = p._rot || 0, R = p._R || 3;
  const lx = Math.sin(r) * R * 0.85, ly = -Math.cos(r) * R * 0.85;
  const x = p.x + ((p._tx || 0) + lx) * U, y = gy + ((p._ty || 0) + ly) * U;
  const k = n * (1 - (p.wither || 0)) * (0.75 + 0.25 * Math.sin(world.t * 1.8 + p.x));
  drawGlow(ctx, p.genome.glow || P.glowAmber, x, y, 3.5 * U, k * 0.7);
  drawGlow(ctx, p.genome.glow || P.glowAmber, x, y, 1.0 * U, k);
}

// ------------------------------------------------------------ DEWVEIL
function dvPal(g, w) {
  const c1 = wc(g.c1 || P.lilac, w);
  return {
    pad: wc(g.c2 || P.mauve, w),
    padDk: mixHex(g.c2 || P.mauve, P.ink, 0.35),
    strand: c1,
    strandLt: mixHex(c1, P.cream, 0.5),
    dew: mixHex(P.cream, g.glow || P.glowCyan, 0.3),
    lump: mixHex(g.c3 || P.bone, P.cream, 0.2),
    lumpDk: mixHex(g.c3 || P.bone, P.ink, 0.3),
    wrap: mixHex(c1, P.cream, 0.3),
  };
}
function dvGeo(p) {
  let a = p._dvG;
  if (a) return a;
  const g = p.genome, n = Math.max(3, Math.min(16, g.n | 0 || 10));
  const r = mulberry32(g.seed || 11);
  a = p._dvG = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    a[i * 4] = (i / (n - 1)) * 2 - 1 + (r() - 0.5) * 0.12; // x frac across width
    a[i * 4 + 1] = 0.55 + r() * 0.45;                       // length frac
    a[i * 4 + 2] = r() * TAU;                               // sway phase
    a[i * 4 + 3] = r();                                     // dew offset
  }
  return a;
}
// strand point i at q (0 top .. 1 bottom) -> XA[0], YA[0]
function dvPoint(G, i, q, hw, L, t, gust, tight, caught, lumpY) {
  const fx = G[i * 4], len = L * G[i * 4 + 1] * (1 - tight * 0.15);
  const x0 = fx * hw;
  const sw = (Math.sin(t * 0.6 + G[i * 4 + 2]) * 0.8 + gust * 2.2) * q * q * (1 - tight * 0.8);
  // gather toward the centre when tight or around a caught lump
  const gather = Math.max(tight * 0.55, caught * 0.6 * Math.max(0, 1 - Math.abs(q * len - lumpY) / (L * 0.5)));
  XA[0] = lerp(x0, x0 * 0.25, gather * q) + sw;
  YA[0] = q * len;
}
function dewveilDraw(ctx, p, world, amb) {
  const U = world.U, g = p.genome;
  const pl = plantPal(p, dvPal);
  const G = dvGeo(p);
  const n = G.length / 4;
  const w = wq(p);
  const fade = w > 0.5 ? 0.6 : 1;
  const gr = p.growth ?? 1;
  const hw = (g.w || 4) * (0.5 + 0.5 * gr);
  const L = (p.height || 14) * (0.3 + 0.7 * gr);
  const t = world.t;
  const gust = world.gust || 0;
  const tight = p.closed || 0;
  const caught = p.caught || 0;
  const lumpY = L * 0.62;
  ctx.save();
  ctx.translate(p.x, world.topInset || 0);
  ctx.scale(U, U);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // strands: one path
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    dvPoint(G, i, 0, hw, L, t, gust, tight, caught, lumpY);
    ctx.moveTo(XA[0], 0.4);
    for (let k = 1; k <= 6; k++) { dvPoint(G, i, k / 6, hw, L, t, gust, tight, caught, lumpY); ctx.lineTo(XA[0], YA[0]); }
  }
  ctx.strokeStyle = amb.c(pl.strand, 0.55 * fade);
  ctx.lineWidth = 0.14;
  ctx.stroke();
  // cross-threads (sparse webbing) on the upper part
  ctx.strokeStyle = amb.c(pl.strandLt, 0.3 * fade);
  ctx.lineWidth = 0.07;
  ctx.beginPath();
  for (let i = 0; i < n - 1; i++) {
    const q = 0.2 + ((i * 7) % 5) * 0.08;
    dvPoint(G, i, q, hw, L, t, gust, tight, caught, lumpY);
    const x1 = XA[0], y1 = YA[0];
    dvPoint(G, i + 1, q + 0.06, hw, L, t, gust, tight, caught, lumpY);
    ctx.moveTo(x1, y1); ctx.lineTo(XA[0], YA[0]);
  }
  ctx.stroke();
  // dew beads
  ctx.fillStyle = amb.c(pl.dew, 0.9 * fade);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const o = G[i * 4 + 3];
    for (let k = 0; k < 3; k++) {
      const q = 0.25 + ((o + k * 0.29) % 1) * 0.72;
      dvPoint(G, i, q, hw, L, t, gust, tight, caught, lumpY);
      const r = k === 2 ? 0.16 : 0.1;
      ctx.rect(XA[0] - r, YA[0] - r, r * 2, r * 2);
    }
    dvPoint(G, i, 1, hw, L, t, gust, tight, caught, lumpY);
    ctx.rect(XA[0] - 0.2, YA[0] - 0.1, 0.4, 0.42);
  }
  ctx.fill();
  // holdfast pad on the glass
  ctx.fillStyle = amb.c(pl.pad, fade);
  ctx.beginPath();
  ctx.moveTo(-hw - 1.2, 0);
  ctx.quadraticCurveTo(-hw * 0.6, 1.9, 0, 1.5);
  ctx.quadraticCurveTo(hw * 0.6, 1.9, hw + 1.2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = amb.c(pl.padDk, 0.8 * fade);
  ctx.beginPath();
  for (let i = 0; i < n; i++) dot(ctx, G[i * 4] * hw, 0.95 + (1 - Math.abs(G[i * 4])) * 0.4, 0.17);
  ctx.fill();
  // cocooned catch
  if (caught > 0.02) {
    const lx = Math.sin(t * 0.6) * 0.4 * (1 - tight) + gust * 1.2, ly = lumpY;
    const rx = 1.2 + caught * 0.8, ry = 1.6 + caught * 1.0;
    ctx.fillStyle = amb.c(pl.lump, 0.9);
    ctx.beginPath(); oval(ctx, lx, ly, rx, ry, 0.1); ctx.fill();
    ctx.strokeStyle = amb.c(pl.wrap, 0.85);
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const y = ly - ry * 0.8 + k * ry * 0.32;
      const ww = rx * Math.sqrt(Math.max(0, 1 - ((y - ly) / ry) ** 2));
      ctx.moveTo(lx - ww, y - 0.15); ctx.quadraticCurveTo(lx, y + 0.35, lx + ww, y + 0.1);
    }
    ctx.stroke();
    ctx.fillStyle = amb.c(pl.lumpDk, 0.6);
    ctx.beginPath(); dot(ctx, lx + rx * 0.3, ly - ry * 0.25, 0.25); dot(ctx, lx - rx * 0.25, ly + ry * 0.3, 0.18); ctx.fill();
  }
  ctx.restore();
}
function dewveilGlow(ctx, p, world) {
  const n = world.night;
  if (n < 0.05 || (p.growth ?? 1) < 0.3) return;
  const U = world.U;
  const L = (p.height || 14) * (0.3 + 0.7 * (p.growth ?? 1));
  const glow = p.genome.glow || P.glowCyan;
  const k = n * (1 - (p.wither || 0));
  drawGlow(ctx, glow, p.x, (world.topInset || 0) + L * 0.55 * U, (p.genome.w || 4) * 1.3 * U, k * 0.22);
  if ((p.caught || 0) > 0.05) drawGlow(ctx, glow, p.x, (world.topInset || 0) + L * 0.62 * U, 2.5 * U, k * 0.45 * p.caught);
}

// ------------------------------------------------------------ GLOOMCAP
function gcPal(g, w) {
  const c1 = wc(g.c1 || P.bone, w);
  return {
    stalk: c1,
    stalkDk: mixHex(c1, P.ink, 0.25),
    cap: wc(g.c2 || P.mauve, w),
    capLt: mixHex(g.c2 || P.mauve, P.cream, 0.35),
    gill: mixHex(g.c3 || P.plum, P.ink, 0.3),
    spore: mixHex(P.chartreuse, P.cream, 0.4),
    rot: mixHex(P.olive, P.ink, 0.4),
  };
}
function gcGeo(p) {
  let a = p._gcG;
  if (a) return a;
  const r = mulberry32(p.genome.seed || 5);
  const n = 5 + Math.floor(r() * 3);
  a = p._gcG = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) {
    a[i * 5] = (r() - 0.5) * 3.4;          // base x
    a[i * 5 + 1] = 3 + r() * 6;            // height
    a[i * 5 + 2] = (r() - 0.5) * 1.6;      // lean
    a[i * 5 + 3] = 0.7 + r() * 0.8;        // cap radius
    a[i * 5 + 4] = r() * TAU;
  }
  return a;
}
function gloomcapDraw(ctx, p, world, amb) {
  const U = world.U;
  const pl = plantPal(p, gcPal);
  const G = gcGeo(p);
  const n = G.length / 5;
  const gr = p.growth ?? 1;
  const w = p.wither || 0;
  const fade = w > 0.5 ? 0.65 : 1;
  const t = world.t;
  ctx.save();
  ctx.translate(p.x, world.groundY(p.x));
  ctx.scale(U, U);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // rot patch on the ground
  ctx.fillStyle = amb.c(pl.rot, 0.55);
  ctx.beginPath(); ctx.ellipse(0, 0.1, 2.8 + gr, 0.55, 0, 0, TAU); ctx.fill();
  // stalks
  for (let i = 0; i < n; i++) {
    const hh = G[i * 5 + 1] * (0.25 + 0.75 * gr) * (1 - w * 0.4);
    const sw = Math.sin(t * 0.5 + G[i * 5 + 4]) * 0.12 * hh * 0.1 + (world.gust || 0) * 0.2;
    const lean = G[i * 5 + 2] + w * 1.5 * Math.sign(G[i * 5 + 2] || 1);
    XA[i] = G[i * 5] + lean + sw; YA[i] = -hh;
  }
  ctx.strokeStyle = amb.c(pl.stalk, fade);
  ctx.lineWidth = 0.28;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const bx = G[i * 5];
    ctx.moveTo(bx, 0.2);
    ctx.quadraticCurveTo(bx, YA[i] * 0.55, XA[i], YA[i]);
  }
  ctx.stroke();
  ctx.strokeStyle = amb.c(pl.stalkDk, 0.6 * fade);
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const bx = G[i * 5];
    for (let k = 1; k < 4; k++) { const q = k / 4, x = lerp(bx, XA[i], q * q), y = YA[i] * q; ctx.moveTo(x - 0.18, y); ctx.lineTo(x + 0.18, y - 0.1); }
  }
  ctx.stroke();
  // drooping bell caps
  ctx.fillStyle = amb.c(pl.cap, fade);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const r = G[i * 5 + 3] * (0.4 + 0.6 * gr);
    const x = XA[i], y = YA[i];
    const tilt = (G[i * 5 + 2]) * 0.25;
    ctx.moveTo(x - r + tilt, y + r * 0.95);
    ctx.quadraticCurveTo(x - r * 1.05, y - r * 0.9, x, y - r * 0.55);
    ctx.quadraticCurveTo(x + r * 1.05, y - r * 0.9, x + r + tilt, y + r * 0.95);
    ctx.quadraticCurveTo(x + tilt * 0.5, y + r * 0.45, x - r + tilt, y + r * 0.95);
  }
  ctx.fill();
  // gills under the bell + highlight
  ctx.strokeStyle = amb.c(pl.gill, 0.75 * fade);
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const r = G[i * 5 + 3] * (0.4 + 0.6 * gr);
    const x = XA[i], y = YA[i];
    const tilt = (G[i * 5 + 2]) * 0.25;
    for (let k = -2; k <= 2; k++) { ctx.moveTo(x + k * r * 0.18, y + r * 0.05); ctx.lineTo(x + k * r * 0.38 + tilt, y + r * 0.82); }
  }
  ctx.stroke();
  ctx.fillStyle = amb.c(pl.capLt, 0.8 * fade);
  ctx.beginPath();
  for (let i = 0; i < n; i++) { const r = G[i * 5 + 3] * (0.4 + 0.6 * gr); sq(ctx, XA[i] - r * 0.35, YA[i] - r * 0.35, 0.12); sq(ctx, XA[i] - r * 0.05, YA[i] - r * 0.5, 0.09); }
  ctx.fill();
  // spore haze drifting up
  if (gr > 0.5) {
    ctx.fillStyle = amb.c(pl.spore, 0.55 * fade);
    ctx.beginPath();
    for (let k = 0; k < 9; k++) {
      const ph = (t * 0.12 + k * 0.137) % 1;
      const x = XA[k % n] + Math.sin(t * 0.7 + k * 2.1) * 0.9 + (world.gust || 0) * ph * 3;
      sq(ctx, x, YA[k % n] + 0.5 - ph * 7, 0.1 + (k % 3) * 0.04);
    }
    ctx.fill();
  }
  ctx.restore();
}
function gloomcapGlow(ctx, p, world) {
  const n = world.night;
  if (n < 0.05 || (p.growth ?? 1) < 0.3) return;
  const U = world.U;
  const gy = world.groundY(p.x);
  drawGlow(ctx, P.glowLime, p.x, gy - 5 * U, 6 * U, n * 0.16 * (1 - (p.wither || 0)));
}

// ============================================================ exports
export const ART = {
  scuttler: { draw: scuttlerDraw, glow: scuttlerGlow },
  petalmoth: { draw: petalmothDraw, glow: petalmothGlow },
  bellwisp: { draw: bellwispDraw, glow: bellwispGlow },
  ribbonfin: { draw: ribbonfinDraw, glow: ribbonfinGlow },
  stiltstrider: { draw: stiltstriderDraw, glow: stiltstriderGlow },
  mindbloom: { draw: mindbloomDraw, glow: mindbloomGlow },
  hookjaw: { draw: hookjawDraw, glow: hookjawGlow },
  lancewing: { draw: lancewingDraw, glow: lancewingGlow },
  mireeel: { draw: mireeelDraw, glow: mireeelGlow },
};
export const FLORA_ART = {
  snaplure: { draw: snaplureDraw, glow: snaplureGlow },
  dewveil: { draw: dewveilDraw, glow: dewveilGlow },
  gloomcap: { draw: gloomcapDraw, glow: gloomcapGlow },
};
