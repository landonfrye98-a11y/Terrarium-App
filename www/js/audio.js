// Glasswild soundscape: an optional, generative score driven by the ecosystem.
// Off by default. A slow three-voice pad follows a chord progression whose mode
// tracks the time of day; each species "sings" on a small shared voice bank
// with its own timbre, and what the creatures do (births, kills, pollination,
// splashes...) shapes which voices sound and how often.
//
// Battery first:
//  - the whole node graph is built ONCE (lazily) in ensure(); notes never
//    create nodes, they only automate a pooled voice's frequency and envelope;
//  - all scheduling happens in tick() (~1 Hz) with a ~1.2 s lookahead on the
//    audio clock; nothing runs per animation frame;
//  - the context is suspended whenever sound is off, the app is hidden, or the
//    room has gone quiet for a long while (auto-rest).

const ROOT = 146.83; // D3
const LOOKAHEAD = 1.2; // seconds of events scheduled per tick
const STEP = 0.25; // beat grid
const POOL = 8;

const MODES = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};
// chord roots as scale degrees (0-based); each chord is a stacked-third triad
const PROG = {
  lydian: [0, 1, 4, 0, 2, 1],
  dorian: [0, 3, 0, 6, 4, 3],
  aeolian: [0, 5, 2, 6, 0, 3],
  phrygian: [0, 1, 0, 5, 0, 6],
};
const modeFor = (h) => (h >= 5 && h < 8 ? 'lydian' : h >= 8 && h < 18 ? 'dorian' : h >= 18 && h < 21 ? 'aeolian' : 'phrygian');

// timbres. h = sine-series harmonics of the main osc; ratio/pAmt/pDecay = the
// partial osc (inharmonic shimmer, wooden knock, breath beating...)
const SPECS = {
  petalmoth: { h: [1, 0, 0.12, 0, 0.04], ratio: 2.756, pAmt: 0.5, pDecay: 0.25, att: 0.004, dur: 2.2, gain: 0.05, oct: 2, pan: 0.7, shape: 'perc' },
  stiltstrider: { h: [1, 0, 0.11, 0, 0.04, 0, 0.02], ratio: 3.93, pAmt: 0.6, pDecay: 0.04, att: 0.003, dur: 0.32, gain: 0.085, oct: -1, pan: 0.4, shape: 'perc' },
  ribbonfin: { h: [1, 0.08], ratio: 2.0, pAmt: 0.25, pDecay: 0.08, att: 0.002, dur: 0.45, gain: 0.055, oct: 1, pan: 0.6, drop: 1.45, dropT: 0.07, shape: 'perc' },
  scuttler: { h: [1, 0, 0, 0.2, 0, 0.05], ratio: 3.99, pAmt: 0.4, pDecay: 0.03, att: 0.002, dur: 0.22, gain: 0.045, oct: 1, pan: 0.5, shape: 'perc' },
  bellwisp: { h: [1, 0.06, 0.02], ratio: 1.004, pAmt: 0.6, pDecay: 0, att: 1.2, dur: 2.6, gain: 0.035, oct: 1, pan: 0.6, shape: 'swell' },
  predator: { h: [1, 0.6, 0.35, 0.2, 0.12, 0.06], ratio: 2.013, pAmt: 0.3, pDecay: 0, att: 0.5, dur: 3.2, gain: 0.065, oct: -1, pan: 0.2, shape: 'swell' },
  bell: { h: [1, 0, 0.25, 0, 0.08], ratio: 2.4, pAmt: 0.35, pDecay: 0.6, att: 0.005, dur: 3.0, gain: 0.06, oct: 2, pan: 0.3, shape: 'perc' },
};
const KIND_SPEC = { petalmoth: 'petalmoth', stiltstrider: 'stiltstrider', ribbonfin: 'ribbonfin', scuttler: 'scuttler', bellwisp: 'bellwisp', hookjaw: 'predator', lancewing: 'predator', mireeel: 'predator' };
const KIND_WEIGHT = { petalmoth: 1, stiltstrider: 0.8, ribbonfin: 0.8, scuttler: 0.6, bellwisp: 1, hookjaw: 0.25, lancewing: 0.25, mireeel: 0.25 };
const KIND_OCT = { lancewing: 0 };
const PREDATORS = new Set(['hookjaw', 'lancewing', 'mireeel']);
const DEFAULT_POP = { petalmoth: 3, bellwisp: 2, scuttler: 2, ribbonfin: 1 };
const ACT_KEYS = ['births', 'deaths', 'pollinations', 'hunts', 'kills', 'pulses', 'splashes', 'hatches'];

const rnd = Math.random;
const fit = (f, lo) => { if (!(f > 0)) return lo; while (f < lo) f *= 2; while (f >= lo * 2) f /= 2; return f; };
const semi = (mode, d) => mode[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);

export class Soundscape {
  // opts.context: inject a (e.g. Offline) AudioContext — used by tests only.
  constructor(opts = {}) {
    this.ctx = null;
    this._inject = opts.context || null;
    this.offline = false;
    this.failed = false;
    this.on = false;
    this.hidden = false;
    this.resting = false;
    this.volume = 0.6;
    this.restMs = 10 * 60 * 1000;
    this.lastActMs = Date.now();
    this.activity = 0;
    this.mode = 'dorian';
    this.progIdx = 0;
    this.chordDeg = 0;
    this.nextChord = 0;
    this.sched = 0;
    this.nextSlot = 0;
    this.swellUntil = 0;
    this.lastPulse = -99;
    this.lastDeg = {};
    this.focus = false;
    this.night = 0;
    this._last = {};
    this._alertUntil = 0;
    this._offTimer = 0;
    this._restTimer = 0;
    this._retryAt = 0;
  }

  // ------------------------------------------------------------ graph (once)
  ensure() {
    if (this.ctx || this.failed) return !!this.ctx;
    try {
      let ctx = this._inject;
      if (ctx) this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
      else {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) { this.failed = true; return false; }
        try { ctx = new AC({ latencyHint: 'playback', sampleRate: 24000 }); } catch { ctx = null; }
        if (!ctx) { try { ctx = new AC({ latencyHint: 'playback' }); } catch { ctx = new AC(); } }
      }
      this._build(ctx);
      this.ctx = ctx;
      return true;
    } catch (e) {
      this.failed = true;
      this.ctx = null;
      return false;
    }
  }

  _build(ctx) {
    const t = ctx.currentTime;
    // master chain: mix -> compressor -> master -> out
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6;
    comp.attack.value = 0.005; comp.release.value = 0.25;
    comp.connect(this.master);
    const mix = ctx.createGain();
    mix.connect(comp);

    // one shared room
    const conv = ctx.createConvolver();
    conv.buffer = this._impulse(ctx, 1.6);
    const revOut = ctx.createGain(); revOut.gain.value = 0.45;
    conv.connect(revOut); revOut.connect(mix);
    const revSend = ctx.createGain(); revSend.gain.value = 0.4;
    revSend.connect(conv);

    // pad: 3 oscillators -> lowpass -> padGain
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.7;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    this.padFilter.connect(this.padGain);
    this.padGain.connect(mix); this.padGain.connect(revSend);
    const padWave = this._wave(ctx, [1, 0.5, 0.3, 0.2, 0.12, 0.08, 0.05]);
    this.pad = [];
    [[ROOT / 2, 0.1, -4], [ROOT * 1.19, 0.07, 3], [ROOT * 1.5, 0.07, -2]].forEach(([f, g, det]) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(padWave); o.frequency.value = f; o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og); og.connect(this.padFilter); o.start(t);
      this.pad.push(o);
    });
    // a very slow breath on the pad's brightness and level
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.031;
    this.lfoF = ctx.createGain(); this.lfoF.gain.value = 160;
    const lfoA = ctx.createGain(); lfoA.gain.value = 0.08;
    lfo.connect(this.lfoF); this.lfoF.connect(this.padFilter.frequency);
    lfo.connect(lfoA); lfoA.connect(this.padGain.gain);
    lfo.start(t);

    // species voices on a shared pool
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 1;
    this.voiceBus.connect(mix); this.voiceBus.connect(revSend);
    this.waves = {};
    for (const k in SPECS) this.waves[k] = this._wave(ctx, SPECS[k].h);
    const hasPan = typeof ctx.createStereoPanner === 'function';
    this.voices = [];
    for (let i = 0; i < POOL; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(this.waves.bell);
      osc.frequency.value = ROOT;
      const part = ctx.createOscillator();
      part.frequency.value = ROOT * 2;
      const pg = ctx.createGain(); pg.gain.value = 0;
      const env = ctx.createGain(); env.gain.value = 0;
      const pan = hasPan ? ctx.createStereoPanner() : null;
      osc.connect(env); part.connect(pg); pg.connect(env);
      if (pan) { env.connect(pan); pan.connect(this.voiceBus); } else env.connect(this.voiceBus);
      osc.start(t); part.start(t);
      this.voices.push({ osc, part, pg, env, pan, end: 0, wave: 'bell' });
    }
  }

  _wave(ctx, h) {
    const n = h.length + 1;
    const real = new Float32Array(n), imag = new Float32Array(n);
    for (let i = 0; i < h.length; i++) imag[i + 1] = h[i];
    return ctx.createPeriodicWave(real, imag);
  }

  // stereo noise with an exponential tail that darkens as it decays
  _impulse(ctx, secs) {
    const sr = ctx.sampleRate, len = Math.floor(sr * secs);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const x = i / len;
        const a = 0.85 - 0.75 * x; // lowpass coefficient falls -> darker tail
        lp += a * (rnd() * 2 - 1 - lp);
        const fadeIn = Math.min(1, i / (sr * 0.006));
        d[i] = lp * Math.exp(-x * 5.5) * fadeIn;
      }
    }
    return buf;
  }

  // ------------------------------------------------------------ helpers
  _running() { return !!this.ctx && (this.offline || this.ctx.state === 'running'); }
  _live() { return this.on && !this.hidden && !this.resting && this._running(); }
  _level() { return Math.max(0, Math.min(1, this.volume)) * 0.7; }

  // setTargetAtTime only when the target actually changes (keeps automation lists short)
  _glide(param, key, v, tc) {
    const last = this._last[key];
    if (last !== undefined && Math.abs(last - v) <= 1e-3 * Math.max(1, Math.abs(v))) return;
    this._last[key] = v;
    param.setTargetAtTime(v, this.ctx.currentTime, tc);
  }

  _ctxResume() {
    try { const p = this.ctx && !this.offline && this.ctx.resume(); return p && p.catch ? p.catch(() => {}) : Promise.resolve(); } catch { return Promise.resolve(); }
  }
  _ctxSuspend() {
    try { const p = this.ctx && !this.offline && this.ctx.state === 'running' && this.ctx.suspend(); return p && p.catch ? p.catch(() => {}) : Promise.resolve(); } catch { return Promise.resolve(); }
  }

  _fadeIn(tc = 1.5) {
    const now = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.setTargetAtTime(this._level(), now, tc);
    this._last = {}; // force pad/filter/bus targets to be re-applied
    this.padGain.gain.cancelScheduledValues(now);
    this.padGain.gain.setTargetAtTime(0.5, now, 2);
    this._last.padG = 0.5;
    this.sched = this.nextSlot = now + 0.1;
  }

  _fadeOut(tc = 0.25) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, g = this.master.gain;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.setTargetAtTime(0, now, tc);
  }

  _freq(d, oct) {
    return ROOT * Math.pow(2, semi(MODES[this.mode], d) / 12 + oct);
  }

  // pick a scale degree: chord tones half the time, otherwise a small step
  _degree(key) {
    let d = this.lastDeg[key];
    if (d === undefined || rnd() < 0.5) d = this.chordDeg + [0, 2, 4][(rnd() * 3) | 0];
    else d += [-2, -1, 1, 2][(rnd() * 4) | 0];
    if (d < 0) d += 7; if (d > 9) d -= 7;
    this.lastDeg[key] = d;
    return d;
  }

  // play one note on a pooled voice. No nodes are created.
  _note(specName, freq, when, gain = 1, opts = {}) {
    const ctx = this.ctx, sp = SPECS[specName];
    if (!ctx || !sp || !(freq > 0)) return;
    const now = ctx.currentTime;
    let t = Math.max(when, now + 0.02);
    // voice: prefer a free one already holding this timbre, else the one that ends soonest
    let v = null, best = Infinity;
    for (const c of this.voices) {
      const score = c.end <= t - 0.02 ? (c.wave === specName ? -2 : -1) : c.end;
      if (score < best) { best = score; v = c; }
    }
    const att = opts.att ?? sp.att, dur = opts.dur ?? sp.dur;
    const peak = sp.gain * gain;
    const eg = v.env.gain;
    if (v.end > t) { // steal: hold where it is, then a quick fade
      if (eg.cancelAndHoldAtTime) eg.cancelAndHoldAtTime(t); else eg.cancelScheduledValues(t);
      eg.setTargetAtTime(0, t, 0.008);
      t += 0.035;
    } else eg.cancelScheduledValues(t);
    if (v.wave !== specName) { v.osc.setPeriodicWave(this.waves[specName]); v.wave = specName; }
    const f0 = freq * (sp.drop || 1);
    for (const [o, r] of [[v.osc, 1], [v.part, sp.ratio]]) {
      o.frequency.cancelScheduledValues(t);
      o.frequency.setValueAtTime(f0 * r, t);
      if (sp.drop) o.frequency.exponentialRampToValueAtTime(freq * r, t + sp.dropT);
    }
    const pg = v.pg.gain;
    pg.cancelScheduledValues(t);
    pg.setValueAtTime(sp.pAmt, t);
    if (sp.pDecay) pg.exponentialRampToValueAtTime(sp.pAmt * 0.01 + 1e-4, t + sp.pDecay);
    eg.setValueAtTime(0, t);
    eg.linearRampToValueAtTime(peak, t + att);
    if (sp.shape === 'swell') eg.linearRampToValueAtTime(0, t + att + dur);
    else { eg.exponentialRampToValueAtTime(Math.max(1e-4, peak * 0.004), t + att + dur); eg.setValueAtTime(0, t + att + dur + 0.01); }
    if (v.pan) v.pan.pan.setValueAtTime(opts.pan ?? (rnd() * 2 - 1) * sp.pan, t);
    v.end = t + att + dur + 0.02;
  }

  // reserve a slot on the density grid; returns start time or -1 if the window is full
  _slot(len = 0) {
    const now = this.ctx.currentTime;
    let s = Math.max(this.nextSlot, now + 0.06);
    s = Math.ceil(s / STEP - 1e-6) * STEP;
    if (s > now + LOOKAHEAD + 0.4) return -1;
    this.nextSlot = s + len + this.gap;
    return s;
  }

  // ------------------------------------------------------------ public API
  async setOn(on) {
    on = !!on;
    if (!on) {
      this.on = false;
      if (!this.ctx) return;
      this._fadeOut(0.25);
      clearTimeout(this._offTimer);
      this._offTimer = setTimeout(() => {
        if (!this.on && Date.now() >= this._alertUntil) this._ctxSuspend();
      }, 1200);
      return;
    }
    if (!this.ensure()) return;
    this.on = true;
    this.resting = false;
    this.lastActMs = Date.now();
    clearTimeout(this._offTimer); clearTimeout(this._restTimer);
    if (this.hidden) return; // resume() will start it
    const p = this._ctxResume(); // called synchronously inside the user gesture
    try { this._fadeIn(1.5); } catch {}
    await p;
    if (this.on && !this.hidden) try { this._fadeIn(1.5); } catch {}
  }

  setVolume(v) {
    v = Number(v);
    this.volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : this.volume;
    if (this.ctx && this._live()) {
      try { this.master.gain.setTargetAtTime(this._level(), this.ctx.currentTime, 0.2); } catch {}
    }
  }

  suspend() {
    this.hidden = true;
    return this._ctxSuspend();
  }

  resume() {
    this.hidden = false;
    if (!this.ctx || !this.on || this.resting) return Promise.resolve();
    const p = this._ctxResume();
    try { this._fadeIn(0.8); } catch {}
    return p;
  }

  // called ~once a second from the main loop
  tick(world, state) {
    try { this._tick(world || {}, state || {}); } catch (e) { /* never break the sim */ }
  }

  _tick(world, state) {
    // read and zero the activity counters, whatever our state
    const act = world.act;
    const ev = {};
    let evTotal = 0;
    for (const k of ACT_KEYS) {
      const n = act && act[k] > 0 ? Math.min(50, act[k] | 0) : 0;
      ev[k] = n; evTotal += n;
      if (act && k in act) act[k] = 0;
    }
    const idleMs = Number(state.idleMs) || 0;
    if (evTotal > 0) this.lastActMs = Date.now();
    if (!this.on || !this.ctx || this.hidden) return;

    // auto-rest after a long quiet stretch with nobody around
    const quiet = idleMs > this.restMs && Date.now() - this.lastActMs > this.restMs;
    if (this.resting) {
      if (quiet) return;
      this.resting = false;
      clearTimeout(this._restTimer);
      this._ctxResume().then(() => { if (this._live()) this._fadeIn(2); });
      return;
    }
    if (quiet) {
      this.resting = true;
      this._fadeOut(1.2);
      clearTimeout(this._restTimer);
      this._restTimer = setTimeout(() => { if (this.resting && Date.now() >= this._alertUntil) this._ctxSuspend(); }, 5000);
      return;
    }
    if (!this._running()) {
      // e.g. iOS 'interrupted': retry now and then
      const n = Date.now();
      if (n > this._retryAt) { this._retryAt = n + 5000; this._ctxResume().then(() => { if (this._live()) this._fadeIn(1); }); }
      return;
    }

    const ctx = this.ctx, now = ctx.currentTime;
    const hour = Number.isFinite(world.hour) ? world.hour : 12;
    const night = Math.max(0, Math.min(1, Number(world.night) || 0));
    const focus = !!state.focus;
    const hunting = (Number(state.hunting) || 0) > 0;
    this.night = night; this.focus = focus;

    // activity: smoothed weighted events per second
    const w = ev.births + ev.deaths + ev.hatches + 0.5 * (ev.pollinations + ev.splashes) + ev.hunts + 2 * ev.kills + ev.pulses;
    this.activity = this.activity * 0.8 + Math.min(20, w) * 0.2;

    // harmony: chord changes every ~20-28 s; mode follows the hour
    if (now >= this.nextChord) {
      const m = modeFor(hour);
      if (m !== this.mode) { this.mode = m; this.progIdx = 0; } else this.progIdx++;
      const prog = PROG[this.mode];
      this.chordDeg = prog[this.progIdx % prog.length];
      this.nextChord = now + 20 + rnd() * 8;
    }
    const mode = MODES[this.mode];
    const lowF = night > 0.6 ? 55 : 65, midF = night > 0.6 ? 110 : 140;
    let pf;
    if (hunting) pf = [ROOT / 2, fit(ROOT * Math.pow(2, 1 / 12), midF), fit(ROOT * Math.pow(2, 7 / 12), midF)]; // sus b2
    else {
      const c = this.chordDeg;
      pf = [fit(ROOT * Math.pow(2, semi(mode, c) / 12), lowF), fit(ROOT * Math.pow(2, semi(mode, c + 2) / 12), midF), fit(ROOT * Math.pow(2, semi(mode, c + 4) / 12), midF)];
    }
    const tc = hunting ? 1.5 : 3;
    pf.forEach((f, i) => this._glide(this.pad[i].frequency, 'p' + i, f, tc));

    // colour: filter by time of day, closed for focus
    const base = this.mode === 'lydian' ? 1300 : this.mode === 'dorian' ? 1600 : this.mode === 'aeolian' ? 1000 : 650;
    const cutoff = focus ? 600 : base * (1 - 0.3 * night) + (hunting ? -200 : 0);
    if (now >= this.swellUntil) {
      this._glide(this.padFilter.frequency, 'cut', Math.max(350, cutoff), 4);
      this._glide(this.padGain.gain, 'padG', focus ? 0.42 : 0.55 - 0.1 * night, 4);
    }
    this._glide(this.lfoF.gain, 'lfoF', focus ? 70 : 160, 4);
    this._glide(this.voiceBus.gain, 'bus', (focus ? 0.5 : 1) * (1 - 0.25 * night), 2);

    // density
    let cap = night > 0.6 ? 1.5 : 3;
    if (focus) cap *= 0.4;
    this.gap = 1 / cap;
    const pop = world.pop && typeof world.pop === 'object' ? world.pop : DEFAULT_POP;
    let total = 0;
    for (const k in pop) total += Math.max(0, Number(pop[k]) || 0);
    let rate = (0.28 - 0.18 * night) + 0.12 * this.activity + 0.04 * Math.log1p(total);
    if (focus) rate *= 0.4;
    rate = Math.min(rate, cap);
    if (this.nextSlot < now) this.nextSlot = now;

    // ecosystem events first (they are reactions), capped per tick
    const octN = night > 0.6 ? -1 : 0;
    let budget = focus ? 2 : 4;
    const fire = (n, fn) => { for (let i = 0; i < Math.min(n, 2) && budget > 0; i++, budget--) fn(); };
    fire(ev.kills, () => { const s = this._slot(); if (s >= 0) this._note('predator', ROOT / 4 * Math.pow(2, 1 / 12), s, 1.1, { dur: 3.6 }); });
    fire(ev.births, () => {
      const s = this._slot(0.4); if (s < 0) return;
      const d = this.chordDeg;
      [0, 2, 4].forEach((k, i) => this._note('bell', this._freq(d + k, night > 0.6 ? 1 : 2), s + i * 0.15, 0.55 - i * 0.08));
    });
    if (ev.pulses && now - this.lastPulse > 6) { budget--; this.pulse(); }
    fire(ev.hunts, () => { const s = this._slot(); if (s >= 0) this._note('predator', this._freq(this.chordDeg, -1), s, 0.6); });
    fire(ev.pollinations, () => { const s = this._slot(); if (s >= 0) this._note('petalmoth', this._freq(this._degree('pm'), 2 + octN), s, 0.9); });
    fire(ev.splashes, () => {
      const s = this._slot(0.15); if (s < 0) return;
      const d = this._degree('rf');
      this._note('ribbonfin', this._freq(d, 1), s, 0.9);
      if (rnd() < 0.5) this._note('ribbonfin', this._freq(d + 2, 1), s + 0.13, 0.6);
    });
    fire(ev.hatches, () => {
      const s = this._slot(0.2); if (s < 0) return;
      const d = this._degree('sc');
      this._note('scuttler', this._freq(d, 1), s, 0.9); this._note('scuttler', this._freq(d + 1, 1), s + 0.12, 0.7);
    });
    fire(ev.deaths, () => { const s = this._slot(); if (s >= 0) this._note('bellwisp', this._freq(this.chordDeg + 4, octN), s, 0.6, { att: 0.8, dur: 2.4 }); });

    // ambient voices on the beat grid, weighted by population
    if (this.sched < now + 0.05) this.sched = Math.ceil((now + 0.05) / STEP) * STEP;
    const end = now + LOOKAHEAD;
    const kinds = [], weights = [];
    let wsum = 0;
    for (const k in KIND_SPEC) {
      let wk = Math.max(0, Number(pop[k]) || 0) * KIND_WEIGHT[k];
      if (PREDATORS.has(k)) wk *= hunting ? 3 : 1;
      if (k === 'bellwisp') wk *= 1 + 0.5 * night;
      if (k === 'petalmoth') wk *= 1 - 0.5 * night;
      if (wk > 0) { kinds.push(k); weights.push(wk); wsum += wk; }
    }
    for (; this.sched < end; this.sched += STEP) {
      const g = this.sched;
      if (g < this.nextSlot || wsum <= 0 || rnd() >= rate * STEP) continue;
      let r = rnd() * wsum, i = 0;
      while (i < kinds.length - 1 && (r -= weights[i]) > 0) i++;
      const k = kinds[i], spec = KIND_SPEC[k];
      const sp = SPECS[spec];
      let oct = (KIND_OCT[k] ?? sp.oct) + (spec === 'predator' || spec === 'stiltstrider' ? 0 : octN);
      const deg = spec === 'predator' ? this.chordDeg + (rnd() < 0.5 ? 0 : 4) : this._degree(k);
      this._note(spec, this._freq(deg, oct), g, 0.7 + rnd() * 0.3);
      if (spec === 'stiltstrider' && rnd() < 0.5) this._note(spec, this._freq(deg, oct), g + 0.5, 0.6); // a second step
      this.nextSlot = g + this.gap;
    }
  }

  // task finished: a rising arpeggio
  chime() {
    try {
      if (!this._live()) return;
      const t = this.ctx.currentTime + 0.03, d = this.chordDeg;
      [0, 2, 4, 7, 9].forEach((k, i) => this._note('bell', this._freq(d + k, 1), t + i * 0.11, 1.1 - i * 0.1, { pan: -0.4 + i * 0.2 }));
      this.nextSlot = Math.max(this.nextSlot, t + 0.8);
    } catch {}
  }

  // task planted: a soft low thunk
  plant() {
    try {
      if (!this._live()) return;
      const t = this.ctx.currentTime + 0.02;
      this._note('stiltstrider', ROOT / 2, t, 1.3, { dur: 0.6, pan: 0 });
      this.nextSlot = Math.max(this.nextSlot, t + 0.3);
    } catch {}
  }

  // mindbloom pulse: the pads swell into a choir
  pulse() {
    try {
      if (!this._live()) return;
      const ctx = this.ctx, now = ctx.currentTime;
      if (now - this.lastPulse < 6) return;
      this.lastPulse = now;
      const lvl = this._last.padG ?? 0.5, cut = this._last.cut ?? 900;
      const pg = this.padGain.gain, pf = this.padFilter.frequency;
      pg.setTargetAtTime(lvl * 2, now, 0.7); pg.setTargetAtTime(lvl, now + 3.5, 2.5);
      pf.setTargetAtTime(Math.min(cut + 900, 3000), now, 0.8); pf.setTargetAtTime(cut, now + 3.5, 3);
      this.swellUntil = now + 8;
      const d = this.chordDeg;
      this._note('bellwisp', this._freq(d + 4, 1), now + 0.3, 0.8, { att: 1.6, dur: 3, pan: -0.4 });
      this._note('bellwisp', this._freq(d + 7, 1), now + 0.9, 0.7, { att: 1.6, dur: 3, pan: 0.4 });
    } catch {}
  }

  // births are scored from world.act in tick(); kept for compatibility
  birth() {}

  // focus timer reached its target: a gentle 3-note bell, even with sound off
  async focusChime() {
    try {
      if (!this.ensure()) return;
      const ctx = this.ctx;
      this._alertUntil = Date.now() + 3600;
      const tok = (this._alertTok = (this._alertTok || 0) + 1);
      clearTimeout(this._offTimer);
      if (!this._running()) await this._ctxResume();
      if (!this._running()) return;
      const now = ctx.currentTime;
      const ambient = this._live();
      if (!ambient) {
        // ambient is silent: bring the master up but keep the pad shut
        const g = this.master.gain;
        g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(Math.max(this._level(), 0.25), now + 0.03);
        this.padGain.gain.cancelScheduledValues(now); this.padGain.gain.setValueAtTime(0, now);
        this.voiceBus.gain.cancelScheduledValues(now); this.voiceBus.gain.setValueAtTime(1, now);
        this._last = {};
      }
      const t = now + 0.06;
      [ROOT * 4, ROOT * 4 * Math.pow(2, 7 / 12), ROOT * 8].forEach((f, i) =>
        this._note('bell', f, t + i * 0.42, 1.2 - i * 0.15, { dur: 2.4, pan: -0.3 + i * 0.3 }));
      if (!ambient) {
        setTimeout(() => {
          if (this._live() || tok !== this._alertTok) return; // ambient took over, or a newer chime owns it
          this._fadeOut(0.1);
          setTimeout(() => { if (!this._live() && tok === this._alertTok) this._ctxSuspend(); }, 400);
        }, 3200);
      }
    } catch {}
  }
}
