// The clock at the heart of the glass: an organism of its own. Hour hand is
// a stalk with a ripe bulb, minute hand a tendril, and the seconds are a
// glowing spore orbiting the ring. A nucleus-eye sits in the middle and blinks.
import { P } from './palette.js';
import { TAU, drawGlow, mixHex, hexToRgb, rgba, fmtDuration } from './util.js';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export class Clock {
  constructor(world, settings) {
    this.world = world;
    this.settings = settings;
    this.blinkUntil = 0;
    this.nextBlink = 4;
    this.drawnBlink = false;
    this.font = '"Avenir Next", "Futura", "Century Gothic", "Trebuchet MS", system-ui, sans-serif';
    // precomputed colour/font/text strings so the per-frame and cached-face
    // paths don't rebuild them (see _inkFor/_fontsFor/_textFor)
    this._secHex = null; this._secArc = ''; this._secBar = '';
    this._inkKey = null; this._ink = null;
    this._fontR = NaN; this._fonts = null;
    this._textKey = NaN; this._textH24 = null; this._text = null;
  }

  // ink colours depend only on the sky's top colour (+ night for two of them)
  _inkFor(skyTop, night) {
    let k = this._ink;
    if (skyTop !== this._inkKey || !k) {
      const ink = mixHex(P.cream, skyTop, 0.12);
      const inkRGB = hexToRgb(ink);
      k = this._ink = {
        ink,
        inkRGB,
        membraneRGB: hexToRgb(mixHex(skyTop, P.ink, 0.4)),
        ring: rgba(inkRGB, 0.38),
        ring2: rgba(inkRGB, 0.14),
        bead: rgba(inkRGB, 0.35),
        pod: rgba(inkRGB, 0.7),
        podMajor: rgba(hexToRgb(P.coral), 0.9),
        seed: rgba(hexToRgb(P.glowAmber), 0.85),
        date: rgba(inkRGB, 0.75),
        dateBoth: rgba(inkRGB, 0.7),
        focus: rgba(inkRGB, 0.85),
        focusTime: rgba(hexToRgb(P.glowAmber), 0.95),
        night: NaN, digital: null, membrane: '', shadow: '',
      };
      this._inkKey = skyTop;
    }
    const digital = this.settings.clockMode === 'digital';
    if (night !== k.night || digital !== k.digital) {
      k.night = night; k.digital = digital;
      k.membrane = rgba(k.membraneRGB, (digital ? 0.22 : 0.16) + night * 0.08);
      k.shadow = rgba(hexToRgb(P.ink), 0.3 + (1 - night) * 0.25);
    }
    return k;
  }

  _fontsFor(R) {
    if (R !== this._fontR || !this._fonts) {
      const f = this.font, fs = R * 0.62;
      this._fontR = R;
      this._fonts = {
        digital: `300 ${fs}px ${f}`,
        digitalDate: `500 ${R * 0.09}px ${f}`,
        both: `400 ${R * 0.15}px ${f}`,
        bothDate: `500 ${R * 0.065}px ${f}`,
        focus: `500 ${Math.max(11, R * 0.075)}px ${f}`,
        focusTime: `300 ${Math.max(14, R * 0.12)}px ${f}`,
      };
    }
    return this._fonts;
  }

  // time/date strings only change once a minute
  _textFor(now, h24) {
    const minuteKey = Math.floor(now.getTime() / 60000);
    if (minuteKey !== this._textKey || h24 !== this._textH24 || !this._text) {
      let hh = now.getHours();
      const ampm = hh >= 12 ? 'PM' : 'AM';
      if (!h24) hh = hh % 12 || 12;
      this._textKey = minuteKey; this._textH24 = h24;
      this._text = {
        time: `${h24 ? String(hh).padStart(2, '0') : hh}:${String(now.getMinutes()).padStart(2, '0')}`,
        digitalDate: spaced(`${DAYS[now.getDay()]} · ${now.getDate()} ${MONTHS[now.getMonth()]}${h24 ? '' : ' · ' + ampm}`),
        bothDate: spaced(`${DAYS[now.getDay()]} ${now.getDate()}${h24 ? '' : ' ' + ampm}`),
      };
    }
    return this._text;
  }

  get blinking() {
    const t = this.world.t;
    if (t > this.nextBlink) { this.blinkUntil = t + 0.2; this.nextBlink = t + 3 + Math.random() * 8; }
    return t < this.blinkUntil;
  }
  // the cached face only needs repainting mid-second when the eye blinks
  get stale() { return this.blinking !== this.drawnBlink; }

  // The seconds spore moves every frame; everything else is cached.
  drawSeconds(ctx) {
    if (!this.settings.showSeconds) return;
    const w = this.world;
    const { cx, cy, R } = w.clock;
    // local seconds == UTC seconds (zone offsets are whole minutes), so no Date object is needed
    const sec = (Date.now() % 60000) / 1000;
    if (this._secHex === null) {
      const c = hexToRgb(P.glowCyan);
      this._secHex = P.glowCyan; this._secBar = rgba(c, 0.7); this._secArc = rgba(c, 0.5);
    }
    if (this.settings.clockMode === 'digital') {
      const fs = R * 0.62;
      ctx.strokeStyle = this._secBar;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - R * 0.6, cy + fs * 0.55); ctx.lineTo(cx - R * 0.6 + R * 1.2 * sec / 60, cy + fs * 0.55); ctx.stroke();
      return;
    }
    const sa = sec / 60 * TAU - Math.PI / 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = this._secArc;
    ctx.lineWidth = Math.max(1, R * 0.012);
    ctx.beginPath(); ctx.arc(cx, cy, R, sa - 0.5, sa); ctx.stroke();
    const sx = cx + Math.cos(sa) * R, sy = cy + Math.sin(sa) * R;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, P.glowCyan, sx, sy, R * 0.09, 0.6 + w.night * 0.4);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = P.cream;
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(2, R * 0.022), 0, TAU); ctx.fill();
  }

  draw(ctx, amb, focus, doneToday) {
    const w = this.world;
    const { cx, cy, R } = w.clock;
    const s = w.sky;
    const now = new Date();
    const min = now.getMinutes() + now.getSeconds() / 60;
    const hr = (now.getHours() % 12) + min / 60;
    const mode = this.settings.clockMode;
    const night = w.night;
    const K = this._inkFor(s.skyTop, night);
    const ink = K.ink;

    const blinking = this.blinking;
    this.drawnBlink = blinking;

    ctx.save();
    ctx.lineCap = 'round';

    // membrane
    ctx.fillStyle = K.membrane;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.04, 0, TAU); ctx.fill();
    if (mode !== 'digital') {
      ctx.strokeStyle = K.ring;
      ctx.lineWidth = Math.max(1, R * 0.012);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
      ctx.strokeStyle = K.ring2;
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, 0, TAU); ctx.stroke();

      // minute beads + hour pods
      for (let i = 0; i < 60; i++) {
        const a = i / 60 * TAU - Math.PI / 2;
        const x = cx + Math.cos(a) * R * 0.93, y = cy + Math.sin(a) * R * 0.93;
        if (i % 5) {
          ctx.fillStyle = K.bead;
          ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
        } else {
          const major = i % 15 === 0;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(a + Math.PI / 2);
          ctx.fillStyle = major ? K.podMajor : K.pod;
          ctx.beginPath(); ctx.ellipse(0, major ? R * 0.015 : 0, R * (major ? 0.022 : 0.016), R * (major ? 0.05 : 0.026), 0, 0, TAU); ctx.fill();
          ctx.restore();
        }
      }

      // today's completed tasks orbit as small seeds inside the ring
      const n = doneToday;
      for (let i = 0; i < n; i++) {
        const a = w.t * 0.05 + i / Math.max(n, 1) * TAU;
        const x = cx + Math.cos(a) * R * 0.78, y = cy + Math.sin(a) * R * 0.78;
        ctx.fillStyle = K.seed;
        ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, R * 0.017), 0, TAU); ctx.fill();
        if (night > 0.1) { ctx.globalCompositeOperation = 'lighter'; drawGlow(ctx, P.glowAmber, x, y, R * 0.06, night * 0.6); ctx.globalCompositeOperation = 'source-over'; }
      }

      // hour stalk
      const ha = hr / 12 * TAU - Math.PI / 2;
      const hx = cx + Math.cos(ha) * R * 0.52, hy = cy + Math.sin(ha) * R * 0.52;
      ctx.strokeStyle = amb.c(P.deepteal, 0.95);
      ctx.lineWidth = Math.max(2, R * 0.045);
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(cx + Math.cos(ha + 0.25) * R * 0.3, cy + Math.sin(ha + 0.25) * R * 0.3, hx, hy);
      ctx.stroke();
      ctx.fillStyle = amb.c(P.coral);
      ctx.beginPath(); ctx.ellipse(hx, hy, R * 0.055, R * 0.075, ha + Math.PI / 2, 0, TAU); ctx.fill();
      ctx.fillStyle = amb.c(P.cream, 0.8);
      ctx.beginPath(); ctx.arc(hx - R * 0.015, hy - R * 0.02, R * 0.015, 0, TAU); ctx.fill();

      // minute tendril (with a slow living wobble)
      const ma = min / 60 * TAU - Math.PI / 2;
      const wob = Math.sin(w.t * 0.5) * 0.03;
      const mx = cx + Math.cos(ma) * R * 0.8, my = cy + Math.sin(ma) * R * 0.8;
      ctx.strokeStyle = amb.c(P.sea, 0.95);
      ctx.lineWidth = Math.max(1.4, R * 0.022);
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.bezierCurveTo(cx + Math.cos(ma - 0.2 + wob) * R * 0.3, cy + Math.sin(ma - 0.2 + wob) * R * 0.3, cx + Math.cos(ma + 0.12 - wob) * R * 0.6, cy + Math.sin(ma + 0.12 - wob) * R * 0.6, mx, my);
      ctx.stroke();
      ctx.save();
      ctx.translate(mx, my); ctx.rotate(ma);
      ctx.fillStyle = amb.c(P.mint);
      ctx.beginPath(); ctx.ellipse(R * 0.035, 0, R * 0.05, R * 0.022, 0, 0, TAU); ctx.fill();
      ctx.restore();

      // nucleus eye
      const er = R * 0.075;
      ctx.fillStyle = amb.c(P.bone);
      ctx.beginPath(); ctx.arc(cx, cy, er * 1.35, 0, TAU); ctx.fill();
      ctx.fillStyle = amb.c(P.rust);
      ctx.beginPath(); ctx.arc(cx, cy, er, 0, TAU); ctx.fill();
      const lid = blinking ? 0.12 : 1;
      ctx.fillStyle = P.ink;
      const look = w.lastTouch || w.focusPod;
      let lx = 0, ly = 0;
      if (look) { const d = Math.hypot(look.x - cx, look.y - cy) || 1; lx = (look.x - cx) / d * er * 0.35; ly = (look.y - cy) / d * er * 0.35; }
      ctx.beginPath(); ctx.ellipse(cx + lx, cy + ly, er * 0.35, er * 0.62 * lid, 0, 0, TAU); ctx.fill();
      if (lid > 0.5) { ctx.fillStyle = P.cream; ctx.beginPath(); ctx.arc(cx + lx - er * 0.15, cy + ly - er * 0.25, er * 0.12, 0, TAU); ctx.fill(); }
    }

    // text
    const h24 = this.settings.h24;
    const T = this._textFor(now, h24);
    const F = this._fontsFor(R);
    const timeStr = T.time;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const shadow = K.shadow;
    if (mode === 'digital') {
      const fs = R * 0.62;
      ctx.font = F.digital;
      ctx.fillStyle = shadow;
      ctx.fillText(timeStr, cx + 2, cy + 2);
      ctx.fillStyle = ink;
      ctx.fillText(timeStr, cx, cy);
      ctx.font = F.digitalDate;
      ctx.fillStyle = K.date;
      ctx.fillText(T.digitalDate, cx, cy - fs * 0.62);
    } else if (mode === 'both') {
      const y = cy + R * 0.38;
      ctx.font = F.both;
      ctx.fillStyle = shadow; ctx.fillText(timeStr, cx + 1, y + 1);
      ctx.fillStyle = ink; ctx.fillText(timeStr, cx, y);
      ctx.font = F.bothDate;
      ctx.fillStyle = K.dateBoth;
      ctx.fillText(T.bothDate, cx, cy - R * 0.36);
    }

    // focus readout below the clock
    if (focus) {
      const y = cy + R * 1.18 + (mode === 'digital' ? -R * 0.25 : 0);
      ctx.font = F.focus;
      ctx.fillStyle = K.focus;
      const title = focus.title.length > 34 ? focus.title.slice(0, 32) + '…' : focus.title;
      ctx.fillText(title, cx, y);
      ctx.font = F.focusTime;
      ctx.fillStyle = K.focusTime;
      ctx.fillText(fmtDuration(focus.elapsed), cx, y + Math.max(16, R * 0.13));
    }
    ctx.restore();
  }
}


function spaced(s) { return s.split("").join(String.fromCharCode(8202)); }
