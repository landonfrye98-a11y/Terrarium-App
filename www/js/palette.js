// Colors of Vesna-like light: chalky creams, sun-faded ochres, coral and
// salmon flesh tones, dusty teals and seafoams, mauve dusks, ink-violet nights.
import { hexToRgb, mixRgb, toHex, clamp } from './util.js';

export const P = {
  cream: '#efe4cc',
  bone: '#e3cfae',
  sand: '#dcb877',
  ochre: '#c9973f',
  amber: '#e0a24a',
  rust: '#b8613f',
  coral: '#e5775f',
  salmon: '#f0a38c',
  peach: '#f4c3a1',
  rose: '#d27f8d',
  mauve: '#9d7aa0',
  lilac: '#b9a3c9',
  plum: '#5e4466',
  teal: '#3f8f8a',
  deepteal: '#24575a',
  sea: '#6fb7a8',
  mint: '#a9d8bf',
  moss: '#7f9450',
  olive: '#5f6e3a',
  chartreuse: '#c4c95a',
  ink: '#2a2236',
  night: '#1b2236',
  glowCyan: '#8ff5e4',
  glowLime: '#dff57a',
  glowPink: '#ff8fc0',
  glowAmber: '#ffc96b',
  glowViolet: '#c6a2ff',
};

// Creature color families. Genomes draw from these so that every creature
// stays inside the palette even as it mutates.
export const FAMILIES = {
  warm: [P.coral, P.salmon, P.peach, P.rust, P.amber, P.rose],
  cool: [P.teal, P.sea, P.mint, P.deepteal, P.lilac],
  earth: [P.ochre, P.sand, P.bone, P.moss, P.olive, P.chartreuse],
  dusk: [P.mauve, P.plum, P.lilac, P.rose],
  glow: [P.glowCyan, P.glowLime, P.glowPink, P.glowAmber, P.glowViolet],
};

// Key frames across a 24h day (hour -> scene colors).
const KEYS = [
  { h: 0, skyTop: '#0d1226', skyMid: '#1a1f3e', skyBot: '#33305a', haze: '#3f3866', far: '#262746', far2: '#2e2d52', hillFar: '#23264a', hillNear: '#1c2638', ground: '#262c38', soil: '#1a1824', soil2: '#241e30', water: '#1b4352', planet: '#8a86b8', tint: '#2b3266', amt: 0.62, night: 1 },
  { h: 4.6, skyTop: '#0f1530', skyMid: '#1f2448', skyBot: '#3c3462', haze: '#4a3d6c', far: '#2a2a4c', far2: '#332f58', hillFar: '#262849', hillNear: '#1e293a', ground: '#282d3a', soil: '#1b1925', soil2: '#261f32', water: '#1d4555', planet: '#8f8abd', tint: '#2d3468', amt: 0.6, night: 1 },
  { h: 5.9, skyTop: '#3f4a82', skyMid: '#b77f99', skyBot: '#f1b996', haze: '#f0ae98', far: '#7a6890', far2: '#8f7698', hillFar: '#6e6488', hillNear: '#4f5f68', ground: '#5f6150', soil: '#352a33', soil2: '#46333d', water: '#5f8396', planet: '#f1d3c4', tint: '#e89a8e', amt: 0.24, night: 0.4 },
  { h: 7.4, skyTop: '#83bcbc', skyMid: '#d5dcc0', skyBot: '#f4dfb5', haze: '#f7e7c8', far: '#a3b19c', far2: '#b5bea4', hillFar: '#98ad92', hillNear: '#77946e', ground: '#a1955e', soil: '#5e4236', soil2: '#7a5541', water: '#6cb2aa', planet: '#f6ecda', tint: '#fff2dc', amt: 0.06, night: 0 },
  { h: 12.5, skyTop: '#76b9b8', skyMid: '#c3ddc9', skyBot: '#f0e2c0', haze: '#f5ecd3', far: '#9fb4a2', far2: '#b2c2ab', hillFar: '#93ad93', hillNear: '#6f9270', ground: '#a69a60', soil: '#5f4337', soil2: '#7d5843', water: '#66b3ad', planet: '#f7f0e0', tint: '#ffffff', amt: 0, night: 0 },
  { h: 16.4, skyTop: '#86b0ad', skyMid: '#e1cfa3', skyBot: '#f3c68c', haze: '#f5d6a6', far: '#b39f86', far2: '#c4ad8c', hillFar: '#b29b70', hillNear: '#878a58', ground: '#a88b56', soil: '#5e3f33', soil2: '#7b5038', water: '#6aa9a2', planet: '#fae7cc', tint: '#ffd9a8', amt: 0.12, night: 0 },
  { h: 18.6, skyTop: '#3d3a6f', skyMid: '#b25f7c', skyBot: '#f2916a', haze: '#ea8a72', far: '#6a4b70', far2: '#83587a', hillFar: '#5d4567', hillNear: '#43455c', ground: '#4f4a4c', soil: '#2e2231', soil2: '#3e2a38', water: '#5a6a8c', planet: '#f4b9a8', tint: '#c66a86', amt: 0.3, night: 0.45 },
  { h: 20.1, skyTop: '#171a38', skyMid: '#3a3266', skyBot: '#77486f', haze: '#6a4572', far: '#2f2b52', far2: '#3d335e', hillFar: '#2b2a4e', hillNear: '#202a3e', ground: '#2b2f3c', soil: '#1c1a27', soil2: '#271f33', water: '#234a5c', planet: '#a99ac9', tint: '#353a72', amt: 0.55, night: 0.88 },
  { h: 21.6, skyTop: '#0d1226', skyMid: '#1a1f3e', skyBot: '#33305a', haze: '#3f3866', far: '#262746', far2: '#2e2d52', hillFar: '#23264a', hillNear: '#1c2638', ground: '#262c38', soil: '#1a1824', soil2: '#241e30', water: '#1b4352', planet: '#8a86b8', tint: '#2b3266', amt: 0.62, night: 1 },
  { h: 24, skyTop: '#0d1226', skyMid: '#1a1f3e', skyBot: '#33305a', haze: '#3f3866', far: '#262746', far2: '#2e2d52', hillFar: '#23264a', hillNear: '#1c2638', ground: '#262c38', soil: '#1a1824', soil2: '#241e30', water: '#1b4352', planet: '#8a86b8', tint: '#2b3266', amt: 0.62, night: 1 },
];

const COLOR_KEYS = Object.keys(KEYS[0]).filter((k) => typeof KEYS[0][k] === 'string');

export function skyAt(hour) {
  hour = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = clamp((hour - a.h) / (b.h - a.h), 0, 1);
  const out = { hour };
  for (const k of COLOR_KEYS) out[k] = toHex(mixRgb(hexToRgb(a[k]), hexToRgb(b[k]), t));
  out.amt = a.amt + (b.amt - a.amt) * t;
  out.night = a.night + (b.night - a.night) * t;
  return out;
}

// Just the darkness level, without building any colour strings. The offline
// catch-up calls this thousands of times.
export function nightAt(hour) {
  hour = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = clamp((hour - a.h) / (b.h - a.h), 0, 1);
  return a.night + (b.night - a.night) * t;
}
