// Glasswild: boot, render loop, input, persistence.
//
// Battery notes:
//  - Frames are paced with setTimeout -> requestAnimationFrame, so the CPU
//    sleeps between frames instead of waking at 60/120 Hz to skip them.
//  - The landscape is cached to an offscreen canvas and redrawn ~once a minute.
//  - Glows are pre-rendered sprites; no shadowBlur or filters per frame.
//  - Everything stops when the page is hidden; on return the sim catches up
//    in coarse steps instead of animating the gap.
import { World } from './world.js';
import { Scenery } from './scenery.js';
import { Clock } from './clock.js';
import { TaskGarden, dayKey } from './tasks.js';
import { Soundscape } from './audio.js';
import { UI } from './ui.js';
import { SPECIES } from './species.js';
import { setArt } from './fauna.js';
import { setFloraArt } from './flora.js';
import { Ambient, TAU, rr, dist2 } from './util.js';
import { P } from './palette.js';

const SAVE_KEY = 'glasswild.world.v1';
const SETTINGS_KEY = 'glasswild.settings.v1';
// fps: creatures & particles. plants/clock: how often those cached layers
// are repainted (0 = every frame). Plants sway slowly and the clock face only
// changes once a second, so they don't need the full frame rate.
const PERF = {
  saver: { fps: 12, dpr: 1, plants: 4, clock: 1 },
  balanced: { fps: 24, dpr: 1.5, plants: 10, clock: 2 },
  smooth: { fps: 60, dpr: 2, plants: 0, clock: 4 },
};
const DEFAULTS = {
  perf: 'balanced', awake: true, clockMode: 'analog', h24: false, showSeconds: true, smoothSeconds: true,
  labels: true, sky: 'real', dim: 0, autohide: true, sound: false, tapSounds: true, volume: 0.6, immersive: true, onboarded: false,
};
const LAYER = { ribbonfin: 0, mireeel: 0, scuttler: 1, hookjaw: 2, stiltstrider: 3, mindbloom: 4, bellwisp: 5, petalmoth: 6, lancewing: 7 };

const params = new URLSearchParams(location.search);
const Cap = window.Capacitor;
const native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plugin = (name) => (native ? Cap.Plugins?.[name] : null);

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

class App {
  constructor() {
    this.native = native;
    this.canvas = document.getElementById('scene');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.settings = { ...DEFAULTS, ...(store.get(SETTINGS_KEY) || {}) };
    if (params.has('perf')) this.settings.perf = params.get('perf');
    this.amb = new Ambient();
    this.audio = new Soundscape();
    this.selected = null;
    this.running = false;
    this.timer = 0;
    this.last = performance.now();
    this.lastBgT = -1e9;
    this.wakeLock = null;
    this.frames = 0;
    this.fpsT = performance.now();

    const fresh = params.has('fresh');
    const save = fresh ? null : store.get(SAVE_KEY);
    this.world = new World(save?.world?.seed);
    if (params.has('hour')) this.world.forceHour = parseFloat(params.get('hour'));
    this.world.skyMode = this.settings.sky;
    this.measure();
    this.world.layout(this.W, this.H, this.topInset);
    this.garden = new TaskGarden(this.world, save?.garden);
    let away = null;
    if (save?.world) {
      try {
        this.world.restore(save.world);
        away = this.world.catchUp((Date.now() - (save.savedAt || Date.now())) / 1000);
      } catch (e) {
        console.error('Could not restore the glass, starting fresh', e);
        this.world = new World();
        this.world.layout(this.W, this.H, this.topInset);
        this.garden = new TaskGarden(this.world, null);
        this.world.genesis();
      }
    } else {
      this.world.genesis();
    }
    if (params.has('done')) this.world.stats.tasksDone = parseInt(params.get('done'), 10);
    if (params.has('warp')) this.warp = parseFloat(params.get('warp'));
    this.world._booted = true;
    this.day = dayKey();
    this.garden.rollover();

    this.scenery = new Scenery(this.world);
    this.clock = new Clock(this.world, this.settings);
    this.ui = new UI(this);
    this.resize();
    this.bindWorldEvents();
    this.bindInput();
    this.bindLifecycle();
    this.applyAll();
    this.splash(away);
    this.start();
    setInterval(() => this.slowTick(), 1000);
    this.loadArt();
    this.registerSW();
  }

  // ------------------------------------------------------------ sizing
  measure() {
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    const probe = document.getElementById('inset-probe');
    this.topInset = probe ? probe.getBoundingClientRect().height : 0;
  }

  resize() {
    this.measure();
    const dpr = Math.min(window.devicePixelRatio || 1, PERF[this.settings.perf].dpr);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.plantLayer = this.makeLayer(this.plantLayer);
    this.clockLayer = this.makeLayer(this.clockLayer);
    this.plantT = this.clockT = -1e9;
    this.world.layout(this.W, this.H, this.topInset);
    this.scenery.resize(this.W, this.H, dpr);
    this.garden._slotKey = null;
    this.scenery.update(true);
    this.lastBgT = this.world.t;
    this.render();
  }

  makeLayer(c) {
    c = c || document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    return c;
  }

  // ------------------------------------------------------------ loop
  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.schedule();
  }
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
  }
  // Frame pacing: sleep in setTimeout, then let rAF align to vsync. After a few
  // minutes without a touch the glass "drowses" to a lower frame rate; the
  // creatures move slowly enough that it is hard to notice.
  get targetFps() {
    let fps = PERF[this.settings.perf].fps;
    if (this.ui?.openSheet) fps = Math.min(fps, 20);
    if (this.ui && performance.now() - this.ui.lastInput > 180000) fps = Math.min(fps, this.settings.perf === 'smooth' ? 30 : this.settings.perf === 'balanced' ? 15 : 10);
    return fps;
  }
  schedule() {
    if (!this.running) return;
    const spent = performance.now() - (this.frameStart || 0);
    const wait = 1000 / this.targetFps - spent - 6; // ~half a vsync for rAF to land
    this.timer = setTimeout(() => { this.raf = requestAnimationFrame((t) => this.frame(t)); }, Math.max(0, wait));
  }
  frame(now) {
    if (!this.running) return;
    this.frameStart = performance.now();
    const dt = Math.min(0.25, Math.max(0, now - this.last) / 1000);
    this.last = now;
    this.world.update(dt * (this.warp || 1));
    this.render();
    this.frames++;
    this.schedule();
  }

  slowTick() {
    const w = this.world;
    if (!this.running) return;
    if (w.t - this.lastBgT > 45 || this.skyDirty) {
      this.skyDirty = false;
      if (this.scenery.update()) this.syncThemeColor();
      this.lastBgT = w.t;
    }
    // sort draw order once a second
    if (w._sortDirty) { w.fauna.sort((a, b) => LAYER[a.kind] - LAYER[b.kind]); w._sortDirty = false; }
    this.garden.tick();
    if (dayKey() !== this.day) { this.day = dayKey(); this.garden.rollover(); }
    this.ui.tickTasks();
    if (this.ui.inspecting) this.ui.updateInspector(false);
    this.audio.tick(w, { focus: !!this.garden.active, hunting: w.hunting, idleMs: performance.now() - (this.ui.lastInput || 0) });
    if (w.t - (this.lastSave || 0) > 60) this.save();
    if (params.has('fps')) { const n = performance.now(); console.log('fps', (this.frames * 1000 / (n - this.fpsT)).toFixed(1)); this.frames = 0; this.fpsT = n; }
  }

  // ------------------------------------------------------------ render
  render() {
    const ctx = this.ctx, w = this.world, amb = this.amb, s = w.sky;
    const W = this.W, H = this.H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.scenery.bg, 0, 0, W, H);
    amb.set(s.tint, s.amt, w.night);

    const perf = PERF[this.settings.perf];
    for (const v of w.visitors) v.draw(ctx, w);
    if (perf.plants) {
      if (w.t - this.plantT >= 1 / perf.plants || w.t < this.plantT) {
        this.plantT = w.t;
        const lc = this.plantLayer.getContext('2d');
        lc.setTransform(1, 0, 0, 1, 0, 0);
        lc.clearRect(0, 0, this.plantLayer.width, this.plantLayer.height);
        lc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.drawPlants(lc, amb);
      }
      ctx.drawImage(this.plantLayer, 0, 0, W, H);
    } else this.drawPlants(ctx, amb);
    this.drawItems(ctx, amb);
    for (const e of w.eggs) e.draw(ctx, w, amb);
    for (const c of w.fauna) c.draw(ctx, w, amb);
    this.drawWater(ctx);

    // additive light pass
    ctx.globalCompositeOperation = 'lighter';
    for (const p of w.flora) p.drawGlow(ctx, w);
    for (const e of w.eggs) e.drawGlow(ctx, w);
    for (const c of w.fauna) c.drawGlow(ctx, w);
    this.garden.drawGlow(ctx);
    ctx.globalCompositeOperation = 'source-over';
    w.particles.draw(ctx, w.night);

    if (perf.clock) {
      if (w.t - this.clockT >= 1 / perf.clock || w.t < this.clockT || this.clock.stale) {
        this.clockT = w.t;
        const lc = this.clockLayer.getContext('2d');
        lc.setTransform(1, 0, 0, 1, 0, 0);
        lc.clearRect(0, 0, this.clockLayer.width, this.clockLayer.height);
        lc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.clock.draw(lc, amb, this.focusInfo(), this.garden.doneToday.length);
      }
      ctx.drawImage(this.clockLayer, 0, 0, W, H);
    } else this.clock.draw(ctx, amb, this.focusInfo(), this.garden.doneToday.length);
    this.clock.drawSeconds(ctx);
    this.drawSelection(ctx);
    ctx.drawImage(this.scenery.fg, 0, 0, W, H);
    if (this.settings.dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${this.settings.dim})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  drawPlants(ctx, amb) {
    const w = this.world;
    for (const p of w.flora) p.drawRoots(ctx, w, amb);
    for (const p of w.flora) p.draw(ctx, w, amb);
    // labels fade out with the rest of the controls when idle
    const want = this.settings.labels && !this.ui.idle ? 1 : 0;
    this.labelAlpha = this.labelAlpha == null ? want : this.labelAlpha + (want - this.labelAlpha) * 0.3;
    if (Math.abs(this.labelAlpha - want) < 0.02) this.labelAlpha = want;
    this.garden.draw(ctx, amb, this.labelAlpha, this.clock.font);
  }

  focusInfo() {
    const t = this.garden.active;
    if (!t || !this.ui?.idle) return null;
    return { title: t.title, elapsed: this.garden.elapsed(t) };
  }

  drawItems(ctx, amb) {
    const U = this.world.U;
    for (const it of this.world.items) {
      const rot = Math.min(1, it.age / (4 * 3600));
      if (it.type === 'fruit') {
        ctx.fillStyle = amb.c(it.color, 1 - rot * 0.4);
        ctx.beginPath(); ctx.arc(it.x, it.y, U * 1.3 * (1 - rot * 0.3), 0, TAU); ctx.fill();
        ctx.fillStyle = amb.c(P.cream, 0.5 * (1 - rot));
        ctx.beginPath(); ctx.arc(it.x - U * 0.4, it.y - U * 0.4, U * 0.3, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = amb.c(P.bone, 0.55 * (1 - rot * 0.6));
        ctx.beginPath(); ctx.ellipse(it.x, it.y + U * 0.3, U * 1.8 * (1 - rot * 0.4), U * 0.7, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = amb.c(it.color, 0.4 * (1 - rot));
        ctx.lineWidth = U * 0.25;
        ctx.beginPath(); ctx.moveTo(it.x - U, it.y); ctx.lineTo(it.x + U, it.y - U * 0.2); ctx.stroke();
      }
    }
  }

  drawWater(ctx) {
    const w = this.world, p = w.pond, U = w.U;
    // surface glint and ripples drawn over the fish so they look submerged
    ctx.fillStyle = `rgba(200,240,230,${0.06 + (1 - w.night) * 0.05})`;
    ctx.fillRect(p.x0, p.y, p.x1 - p.x0, U * 1.4);
    ctx.strokeStyle = 'rgba(239,228,204,0.5)';
    ctx.lineWidth = Math.max(1, U * 0.25);
    ctx.beginPath();
    const t = w.t;
    for (let x = p.x0; x <= p.x1; x += U * 2) {
      const y = p.y + Math.sin(t * 1.3 + x * 0.08) * U * 0.25;
      x === p.x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (const r of w.ripples) {
      const k = r.t / 3;
      ctx.strokeStyle = `rgba(239,228,204,${0.6 * (1 - k)})`;
      ctx.beginPath(); ctx.ellipse(r.x, p.y, U * (1 + k * 10), U * (0.3 + k * 1.2), 0, 0, TAU); ctx.stroke();
    }
  }

  drawSelection(ctx) {
    const o = this.selected;
    if (!o || o.dead || o.gone) return;
    const w = this.world, U = w.U;
    let x = o.x, y = o.y, r = 7 * U;
    if (o.genome && o.scale) { r = o.hitR * U * o.scale; y -= o.hitDY * U * o.scale; }
    else if (o.kind && o.growth != null) { const gy = w.groundY(o.x); y = gy - o.height * U * 0.5; r = Math.max(5 * U, o.height * U * 0.6); }
    else if (o.species) { y -= U; r = 4 * U; }
    ctx.strokeStyle = 'rgba(239,228,204,0.75)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 5]);
    ctx.lineDashOffset = -w.t * 12;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ------------------------------------------------------------ world events
  bindWorldEvents() {
    const w = this.world;
    w.on('discover', (k) => {
      if (SPECIES[k].kind === 'flora') this.ui.toast(`New growth in the glass: ${SPECIES[k].name}.`, true, 6000);
    });
    w.on('unlock', (k) => this.ui.toast(`Something new has arrived — the ${SPECIES[k].name}. See the journal.`, true, 7000));
    w.on('log', ({ kind, msg, offline }) => {
      if (offline) return;
      if (kind === 'mutation') this.ui.toast(msg, false, 5000);
      if (kind === 'visitor') this.ui.toast(msg.startsWith('A gloamwhale') ? 'Look up: a gloamwhale is passing.' : msg, msg.startsWith('A gloamwhale'), 6000);
      if (this.ui.openSheet === 'journal' && this.ui.tab === 'log') this.ui.renderLog();
    });
  }

  // the focus timer reached its target (called by the UI)
  focusReached() {
    this.audio.focusChime();
    this.haptic([30, 80, 30, 80, 60]);
  }

  completeTask(id) {
    const res = this.garden.complete(id);
    if (!res) return;
    this.audio.chime();
    this.haptic([12, 60, 18]);
    if (res.creature) this.ui.toast(`“${res.task.title}” bloomed into ${res.creature.name}, a ${SPECIES[res.creature.kind].name}.`, true, 6000);
    else this.ui.toast(`“${res.task.title}” bloomed. The glass is full, so it fed the soil.`, true, 5000);
    this.save();
  }

  select(obj) {
    this.selected = obj;
    this.ui.showInspector(obj);
  }

  // ------------------------------------------------------------ input
  bindInput() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      down = null;
      if (moved < 12 && dt < 600) this.tap(e.clientX, e.clientY);
    });
    window.addEventListener('resize', () => { clearTimeout(this.rz); this.rz = setTimeout(() => this.resize(), 120); });
  }

  tap(x, y) {
    const w = this.world, U = w.U;
    if (this.ui.openSheet) { this.ui.close(); return; }
    w.lastTouch = { x, y };
    clearTimeout(this.touchT);
    this.touchT = setTimeout(() => (w.lastTouch = null), 6000);
    const task = this.garden.hit(x, y);
    if (task) {
      this.ui.open('tasks');
      requestAnimationFrame(() => {
        const li = document.querySelector(`#sheet-tasks li[data-id="${task.id}"]`);
        if (li) { li.scrollIntoView({ block: 'center' }); li.animate([{ background: 'rgba(255,201,107,0.25)' }, { background: 'transparent' }], { duration: 1400 }); }
      });
      return;
    }
    const hit = w.pick(x, y);
    if (hit) {
      this.select(hit.obj);
      this.haptic(5);
      // a tapped creature answers in its own instrument
      if (hit.type === 'fauna' && this.settings.tapSounds) this.audio.voice(hit.obj.kind, hit.obj.genome.seed, Math.max(-0.8, Math.min(0.8, x / w.W * 2 - 1)));
      return;
    }
    if (this.ui.inspecting) this.ui.hideInspector();
    // a touch on the glass: a ripple of light, curious moths, a splash in the pond
    if (w.inPond(x) && y > w.pond.y - 2 * U && y < w.pondBottom(x)) {
      w.splash(x, w.pond.y, 0.6);
      for (const c of w.fauna) if (c.kind === 'ribbonfin' && c.state !== 'jump') { c.tx = x + rr(-3, 3) * U; c.ty = Math.max(w.pond.y + 2 * U, y); c.timer = 4; }
      return;
    }
    w.particles.emit({ type: 'ring', x, y, size: U, grow: 14 * U, life: 1, color: P.cream });
    for (const c of w.fauna) {
      if (c.kind !== 'petalmoth' || c.state === 'perch') continue;
      if (dist2(c.x, c.y, x, y) < (55 * U) ** 2) { c.target = null; c.perch = null; c.state = 'fly'; c.tx = x + rr(-5, 5) * U; c.ty = Math.min(y + rr(-5, 5) * U, w.groundY(x) - 3 * U); c.timer = 6; }
    }
  }

  haptic(pattern) {
    const H = plugin('Haptics');
    if (H) { H.impact?.({ style: Array.isArray(pattern) ? 'MEDIUM' : 'LIGHT' }).catch(() => {}); return; }
    try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ lifecycle
  bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.sleep();
      else this.wakeUp();
    });
    window.addEventListener('pagehide', () => this.save());
    window.addEventListener('focus', () => { if (!document.hidden && !this.running) this.wakeUp(); });
    const App = plugin('App');
    App?.addListener?.('appStateChange', ({ isActive }) => (isActive ? this.wakeUp() : this.sleep()));
  }

  sleep() {
    if (!this.running) return;
    this.hiddenAt = Date.now();
    this.save();
    this.stop();
    this.audio.suspend();
  }

  wakeUp() {
    if (this.running) return;
    const gone = this.hiddenAt ? (Date.now() - this.hiddenAt) / 1000 : 0;
    this.hiddenAt = 0;
    if (gone > 20) {
      const res = this.world.catchUp(gone);
      if (res && gone > 15 * 60) this.awayToast(res);
      this.garden.rollover();
    }
    this.skyDirty = true;
    this.world.updateSky();
    this.scenery.update(true);
    this.audio.resume();
    this.applyWake();
    this.start();
  }

  awayToast(res) {
    const bits = [];
    if (res.births) bits.push(`${res.births} born`);
    if (res.deaths) bits.push(`${res.deaths} passed`);
    if (res.kills) bits.push(`${res.kills} eaten`);
    const h = Math.floor(res.seconds / 3600), m = Math.round((res.seconds % 3600) / 60);
    const away = h ? `${h}h ${m}m` : `${m}m`;
    this.ui.toast(`You were away ${away}${bits.length ? ' · ' + bits.join(' · ') : ' · all quiet'}`, false, 5000);
  }

  save() {
    this.lastSave = this.world.t;
    store.set(SAVE_KEY, { v: 1, savedAt: Date.now(), world: this.world.serialize(), garden: this.garden.serialize() });
  }

  // ------------------------------------------------------------ settings
  setSetting(k, v) {
    this.settings[k] = v;
    store.set(SETTINGS_KEY, this.settings);
    this.apply(k);
  }
  applyAll() { for (const k of Object.keys(DEFAULTS)) this.apply(k, true); }
  apply(k, boot) {
    const s = this.settings;
    switch (k) {
      case 'perf': if (!boot) this.resize(); break;
      case 'awake': this.applyWake(); break;
      case 'sky': this.world.skyMode = s.sky; this.world.updateSky(); this.scenery.update(true); this.syncThemeColor(); break;
      case 'sound': if (!boot) this.audio.setOn(s.sound); else if (s.sound) this.pendingSound = true; break;
      case 'volume': this.audio.setVolume(s.volume); break;
      case 'autohide': this.ui.wake(); break;
      case 'immersive': {
        const SB = plugin('StatusBar');
        if (SB) { (s.immersive ? SB.hide() : SB.show()).catch(() => {}); SB.setOverlaysWebView?.({ overlay: true }).catch(() => {}); }
        break;
      }
    }
  }

  async applyWake() {
    const on = this.settings.awake;
    const KA = plugin('KeepAwake');
    if (KA) { (on ? KA.keepAwake() : KA.allowSleep()).catch(() => {}); return; }
    if (!('wakeLock' in navigator)) return;
    try {
      if (on && !this.wakeLock && document.visibilityState === 'visible') {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      } else if (!on && this.wakeLock) { await this.wakeLock.release(); this.wakeLock = null; }
    } catch { this.wakeLock = null; }
  }

  syncThemeColor() {
    const m = document.querySelector('meta[name=theme-color]');
    if (m) m.content = this.world.sky.skyTop;
  }

  // ------------------------------------------------------------ data
  exportData() {
    this.save();
    const blob = new Blob([localStorage.getItem(SAVE_KEY) || '{}'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `glasswild-${dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  importData(d) {
    if (!d || !d.world || !Array.isArray(d.world.fauna)) throw new Error('bad file');
    store.set(SAVE_KEY, d);
    location.reload();
  }
  resetWorld() {
    store.del(SAVE_KEY);
    this.stop();
    location.reload();
  }

  // ------------------------------------------------------------ first run
  splash(away) {
    const el = document.getElementById('splash');
    const tip = document.getElementById('splash-tip');
    const first = !this.settings.onboarded;
    tip.textContent = first
      ? 'Plant what you are working on as seeds. Tend them while you focus, finish them, and they bloom into the creatures that live here.'
      : '';
    const go = () => {
      el.classList.add('gone');
      setTimeout(() => el.remove(), 1300);
      if (first) this.setSetting('onboarded', true);
      if (this.pendingSound) { this.pendingSound = false; this.audio.setOn(true); }
      if (away && away.seconds > 15 * 60) this.awayToast(away);
    };
    if (first) { el.addEventListener('click', go, { once: true }); setTimeout(go, 9000); }
    else setTimeout(go, 700);
    // audio contexts may only start from a gesture
    if (this.settings.sound) window.addEventListener('pointerdown', () => { if (this.pendingSound) { this.pendingSound = false; this.audio.setOn(true); } }, { once: true });
  }

  // richer creature artwork lives in its own module; the app works without it
  loadArt() {
    import('./art.js').then((m) => {
      setArt(m.ART);
      setFloraArt(m.FLORA_ART);
      this.plantT = -1e9;
    }).catch(() => {});
  }

  registerSW() {
    if (native || !('serviceWorker' in navigator) || location.protocol === 'file:' || params.has('nosw')) return;
    // when a new version takes over, reload once so the page and its
    // scripts all come from the same version
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      this.save();
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      // check for a new version whenever the app comes back to the screen
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
}

window.glasswild = new App();
