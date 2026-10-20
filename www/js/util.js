// Small math, randomness and color helpers shared by the whole terrarium.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
export const rr = (a, b) => a + Math.random() * (b - a);
export const ri = (a, b) => Math.floor(rr(a, b + 1));
export const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];
export const chance = (ratePerSec, dt) => Math.random() < 1 - Math.exp(-ratePerSec * dt);
export const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

let _id = Date.now() % 100000;
export const uid = () => (++_id).toString(36);
export const bumpUid = (id) => {
  const n = parseInt(id, 36);
  if (n > _id) _id = n;
};

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hash01(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

// Smooth 1D value noise in [0,1].
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(i * 374761393 + seed * 668265263);
  const b = hash01((i + 1) * 374761393 + seed * 668265263);
  return lerp(a, b, smooth(f));
}

// Fractal noise in roughly [-1,1].
export function fbm(x, seed = 0, oct = 3) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += (noise1(x * f, seed + i * 17) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / norm;
}

// ---------- color ----------
const rgbMemo = new Map();
export function hexToRgb(hex) {
  let c = rgbMemo.get(hex);
  if (c) return c;
  const h = hex.replace('#', '');
  c = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  rgbMemo.set(hex, c);
  return c;
}
export const toHex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
export const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mixMemo = new Map();
export function mixHex(a, b, t) {
  const k = a + b + t;
  let v = mixMemo.get(k);
  if (v) return v;
  v = toHex(mixRgb(hexToRgb(a), hexToRgb(b), t));
  if (mixMemo.size > 3000) mixMemo.clear();
  mixMemo.set(k, v);
  return v;
}
export const rgba = ([r, g, b], a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

// Nudge a hex color's hue/lightness a little; used for genome variation.
export function jitterHex(hex, amt = 12, r = Math.random) {
  const [R, G, B] = hexToRgb(hex);
  const d = () => (r() * 2 - 1) * amt;
  return toHex([R + d(), G + d(), B + d()]);
}

// The ambient light shades every living thing. Colors are memoised per
// light state, so per-frame draw calls are just Map lookups.
export class Ambient {
  constructor() {
    this.tint = [255, 255, 255];
    this.amt = 0;
    this.night = 0;
    this.key = '';
    this.cache = new Map();
  }
  set(tintHex, amt, night) {
    const key = tintHex + Math.round(amt * 50) + '|' + Math.round(night * 50);
    if (key === this.key) return;
    this.key = key;
    this.tint = hexToRgb(tintHex);
    this.amt = amt;
    this.night = night;
    this.cache.clear();
  }
  // Shade a base color into the current light.
  c(hex, a = 1) {
    const k = hex + a;
    let s = this.cache.get(k);
    if (s) return s;
    const base = hexToRgb(hex);
    // multiply-ish blend toward the tint, keeps saturation in the dark
    const m = [base[0] * this.tint[0] / 255, base[1] * this.tint[1] / 255, base[2] * this.tint[2] / 255];
    s = rgba(mixRgb(base, m, this.amt), a);
    if (this.cache.size > 600) this.cache.clear();
    this.cache.set(k, s);
    return s;
  }
}

// Pre-rendered radial glow sprites (much cheaper than shadowBlur).
const glowCache = new Map();
export function glowSprite(hex) {
  let c = glowCache.get(hex);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const [r, gg, b] = hexToRgb(hex);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  grad.addColorStop(0.25, `rgba(${r},${gg},${b},0.55)`);
  grad.addColorStop(0.6, `rgba(${r},${gg},${b},0.12)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowCache.set(hex, c);
  return c;
}
export function drawGlow(ctx, hex, x, y, radius, alpha = 1) {
  if (alpha <= 0.01 || radius <= 0.5) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(glowSprite(hex), x - radius, y - radius, radius * 2, radius * 2);
  ctx.globalAlpha = 1;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtAge(sec) {
  if (sec < 90) return 'moments';
  const m = sec / 60;
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
