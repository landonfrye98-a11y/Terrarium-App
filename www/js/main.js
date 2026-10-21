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
import { Reminders } from './remind.js';
import { setArt } from './fauna.js';
import { setFloraArt } from './flora.js';
import { SkyFx } from './skyfx.js';
import { Ambient, TAU, rr, dist2, lerp, smooth, drawGlow } from './util.js';
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
  reminders: false, remindLead: 'ontime', autoSpawn: true,
};
const MAX_ZOOM = 4;
const NO_CAM = { z: 1, x: 0, y: 0 };
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
    this.skyfx = new SkyFx();
    // camera: screen = (world - (x, y)) * z. camT is where it's heading.
    this.cam = { z: 1, x: 0, y: 0 };
    this.camT = { z: 1, x: 0, y: 0 };
    this.follow = null;
    this.focusLabel = null;
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
    this.world.taskOnly = !this.settings.autoSpawn;
    this.measure();
    this.world.layout(this.W, this.H, this.topInset);
    this.garden = new TaskGarden(this.world, save?.garden);
    let away = null;
    if (save?.world) {
      try {
        this.world.restore(save.world);
        this.garden.updateWeeds(); // the hours away happen under today's weeds
        away = this.world.catchUp((Date.now() - (save.savedAt || Date.now())) / 1000);
      } catch (e) {
        console.error('Could not restore the glass, starting fresh', e);
        this.world = new World();
        this.world.taskOnly = !this.settings.autoSpawn;
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
    this.scenery.cam = this.cam;
    this.clock = new Clock(this.world, this.settings);
    this.ui = new UI(this);
    this.resize();
    this.bindWorldEvents();
    this.bindInput();
    this.bindLifecycle();
    this.reminders = new Reminders(this, plugin('LocalNotifications'));
    this.garden.onChange(() => this.reminders.sync(this.garden.tasks));
    this.applyAll();
    this.reminders.catchUp(this.garden.tasks, save?.savedAt);
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
    Object.assign(this.cam, NO_CAM); Object.assign(this.camT, NO_CAM); this.follow = null;
    this.scenery.resize(this.W, this.H, dpr);
    this.garden._slotKey = null;
    this.scenery.update(true);
    this.lastBgT = this.world.t;
    this.render();
  }

  // ------------------------------------------------------------ camera
  clampCam(c) {
    c.z = Math.max(1, Math.min(MAX_ZOOM, c.z));
    c.x = Math.max(0, Math.min(this.W - this.W / c.z, c.x));
    c.y = Math.max(0, Math.min(this.H - this.H / c.z, c.y));
    return c;
  }
  setCam(z, x, y, instant) {
    const t = this.camT;
    t.z = z; t.x = x; t.y = y;
    this.clampCam(t);
    if (instant) Object.assign(this.cam, t);
  }
  // zoom keeping the world point under (sx, sy) fixed on screen
  zoomAt(sx, sy, nz, instant) {
    const t = this.camT;
    const wx = t.x + sx / t.z, wy = t.y + sy / t.z;
    nz = Math.max(1, Math.min(MAX_ZOOM, nz));
    this.setCam(nz, wx - sx / nz, wy - sy / nz, instant);
  }
  resetZoom() { this.follow = null; this.setCam(1, 0, 0); }
  updateCamera(dt) {
    const c = this.cam, t = this.camT;
    const f = this.follow;
    if (f) {
      if (f.dead || this.selected !== f || t.z <= 1.01) this.follow = null;
      else { t.x = f.x - this.W / (2 * t.z); t.y = f.y - 3 * this.world.U - this.H / (2 * t.z); this.clampCam(t); }
    }
    if (c.z !== t.z || c.x !== t.x || c.y !== t.y) {
      const k = 1 - Math.exp(-dt * (f ? 4 : 9));
      c.z += (t.z - c.z) * k; c.x += (t.x - c.x) * k; c.y += (t.y - c.y) * k;
      if (Math.abs(c.z - t.z) < 1e-3 && Math.abs(c.x - t.x) < 0.05 && Math.abs(c.y - t.y) < 0.05) Object.assign(c, t);
    }
    const zoomed = t.z > 1.01 || c.z > 1.01;
    if (zoomed !== this._zoomUi) { this._zoomUi = zoomed; document.getElementById('zoom-reset').hidden = !zoomed; }
  }
  // paint a cached layer from the current camera; returns that camera
  paintLayer(layer, paint) {
    const lc = layer.getContext('2d'), cam = this.cam, k = this.dpr * cam.z;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, layer.width, layer.height);
    lc.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    paint(lc);
    return { z: cam.z, x: cam.x, y: cam.y };
  }
  // a cached layer is crisp only at the zoom it was painted at
  rezoomed(lc) { return !!lc && Math.abs(lc.z / this.cam.z - 1) > 0.04; }
  // draw a layer painted from camera lc as seen from the current camera
  composite(ctx, img, lc, fill) {
    lc = lc || NO_CAM;
    const cam = this.cam, d = this.dpr;
    if (lc.z === cam.z && lc.x === cam.x && lc.y === cam.y) { ctx.drawImage(img, 0, 0); return; }
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }
    const s = cam.z / lc.z;
    ctx.drawImage(img, (lc.x - cam.x) * cam.z * d, (lc.y - cam.y) * cam.z * d, img.width * s, img.height * s);
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
    this.skyfx.update(dt, this.world, this.focusLabel, this.clock.font);
    this.updateCamera(dt);
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
    this.focusTick();
    if (w._sortDirty) { w.fauna.sort((a, b) => LAYER[a.kind] - LAYER[b.kind]); w._sortDirty = false; }
    const worse = this.garden.tick();
    if (worse) this.weedNotice(worse);
    this.updateBadge();
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
    const d = this.dpr, cam = this.cam, k = d * cam.z;
    // the landscape is redrawn from the camera at most ~20x/s while it
    // moves; in between, the last image is slid and scaled to match
    const bc = this.scenery.bgCam || NO_CAM;
    if ((bc.z !== cam.z || bc.x !== cam.x || bc.y !== cam.y) && performance.now() - (this.bgAt || 0) > 50) {
      this.scenery.renderBg();
      this.bgAt = performance.now();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.composite(ctx, this.scenery.bg, this.scenery.bgCam, s.skyTop);
    ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    amb.set(s.tint, s.amt, w.night);

    const perf = PERF[this.settings.perf];
    for (const v of w.visitors) v.draw(ctx, w);
    this.skyfx.draw(ctx, w, amb);
    if (perf.plants) {
      if (w.t - this.plantT >= 1 / perf.plants || w.t < this.plantT || this.rezoomed(this.plantCam)) {
        this.plantT = w.t;
        this.plantCam = this.paintLayer(this.plantLayer, (lc) => this.drawPlants(lc, amb));
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.composite(ctx, this.plantLayer, this.plantCam);
      ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    } else this.drawPlants(ctx, amb);
    this.drawItems(ctx, amb);
    for (const e of w.eggs) e.draw(ctx, w, amb);
    for (const c of w.fauna) c.draw(ctx, w, amb);
    if (w.fx.length) this.drawKills(ctx, amb);
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
      if (w.t - this.clockT >= 1 / perf.clock || w.t < this.clockT || this.clock.stale || this.rezoomed(this.clockCam)) {
        this.clockT = w.t;
        this.clockCam = this.paintLayer(this.clockLayer, (lc) => this.clock.draw(lc, amb, this.focusInfo(), this.garden.doneToday.length));
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.composite(ctx, this.clockLayer, this.clockCam);
      ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    } else this.clock.draw(ctx, amb, this.focusInfo(), this.garden.doneToday.length);
    this.clock.drawSeconds(ctx);
    this.drawSelection(ctx);
    // the glass itself doesn't zoom
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.drawImage(this.scenery.fg, 0, 0, W, H);
    if (this.settings.dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${this.settings.dim})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // A kill: the prey is pulled into the predator's mouth and dissolves, with a
  // strike flash and a few claw marks where it was taken.
  drawKills(ctx, amb) {
    const w = this.world, U = w.U;
    for (const f of w.fx) {
      const a = w.t - f.t0;
      if (a > 1.4 || a < 0) continue;
      if (a < 0.9 && f.prey) {
        const k = smooth(a / 0.9);
        const px = lerp(f.x, f.mx, k), py = lerp(f.y, f.my, k);
        const sc = 1 - k * 0.75;
        ctx.save();
        ctx.globalAlpha = Math.pow(1 - a / 0.9, 1.4);
        ctx.translate(px, py); ctx.scale(sc, sc); ctx.translate(-f.prey.x, -f.prey.y);
        try { f.prey.draw(ctx, w, amb); } catch { /* a drawing glitch must not stop the frame */ }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      // claw marks, quick in, slow out: a dark edge under a pale stroke so
      // they read on any background
      if (a < 0.9) {
        const k = a < 0.1 ? a / 0.1 : 1 - (a - 0.1) / 0.8;
        const r = 6.5 * U, d = f.dir || 1;
        ctx.lineCap = 'round';
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass ? amb.c(P.cream, 0.95 * k) : amb.c(P.ink, 0.45 * k);
          ctx.lineWidth = Math.max(pass ? 1.6 : 3.2, U * (pass ? 0.5 : 0.95));
          ctx.beginPath();
          for (let i = -1; i <= 1; i++) {
            const ox = f.x + i * 1.9 * U, oy = f.y + i * 0.7 * U;
            const reach = 0.35 + 0.65 * Math.min(1, a / 0.1);
            ctx.moveTo(ox - d * r * 0.5, oy - r * 0.55);
            ctx.quadraticCurveTo(ox + d * r * 0.15 * reach, oy - r * 0.1, ox + d * r * (0.35 * reach - 0.15 * (1 - reach)), oy + r * (0.5 * reach));
          }
          ctx.stroke();
        }
      }
      // strike flash
      if (a < 0.5) {
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(ctx, f.glow, f.x, f.y, (6 + a * 24) * U, (1 - a / 0.5) * 0.9);
        drawGlow(ctx, P.cream, f.x, f.y, (3 + a * 8) * U, (1 - a / 0.5) * 0.6);
        ctx.globalCompositeOperation = 'source-over';
      }
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

  // the cloud's words, and a small comet for every five focused minutes
  focusTick() {
    const g = this.garden, t = g.active;
    if (!t) { this.focusLabel = null; this.cometMark = null; return; }
    const el = g.elapsed(t), target = g.targetMs(t);
    const left = Math.ceil((target - el) / 60000);
    const title = t.title.length > 28 ? t.title.slice(0, 27) + '…' : t.title;
    this.focusLabel = el >= target ? `${title} · in bloom` : `${title} · ${left} min left`;
    const mark = Math.floor(el / 300000);
    if (this.cometMark == null || this.cometTask !== t.id) { this.cometMark = mark; this.cometTask = t.id; return; }
    if (mark > this.cometMark) {
      this.cometMark = mark;
      if (el < target - 30000) this.skyfx.comet(this.world, false);
    }
  }

  // the focus timer reached its target (called by the UI)
  focusReached() {
    this.skyfx.comet(this.world, true);
    this.audio.focusChime();
    this.haptic([30, 80, 30, 80, 60]);
  }

  // a neglected task's weed got worse
  weedNotice(t) {
    const st = this.garden.stage(t);
    const msg = [null,
      `“${t.title}” is overdue. Something thorny is pushing out of its pod.`,
      `The weeds on “${t.title}” are spreading. The soil around it is souring and nothing will sprout there.`,
      `“${t.title}” has gone feral. Its brambles are choking the plants nearby and scratching the creatures that pass.`,
      `Blight! Spores are drifting off “${t.title}”. Creatures near it can catch the gloomcap fungus.`][st];
    if (!msg) return;
    this.world.log(msg, 'weed');
    if (this.running) { this.ui.toast(msg, st >= 3, 6500); this.haptic(st >= 3 ? [20, 60, 20] : 10); }
    this.ui.renderTasks();
  }

  // the red number on the home-screen icon: overdue tasks only
  updateBadge() {
    const n = this.garden.overdueCount;
    if (n === this.badgeN) return;
    this.badgeN = n;
    try {
      if (n) navigator.setAppBadge?.(n)?.catch?.(() => {});
      else navigator.clearAppBadge?.()?.catch?.(() => {});
    } catch {}
    this.ui.renderTasks();
  }

  completeTask(id) {
    const res = this.garden.complete(id);
    if (!res) return;
    this.ui.hideTaskCard(id);
    this.audio.chime();
    this.haptic([12, 60, 18]);
    if (res.creature) this.ui.toast(`“${res.task.title}” bloomed into ${res.creature.name}, a ${SPECIES[res.creature.kind].name}.`, true, 6000);
    else this.ui.toast(`“${res.task.title}” bloomed. The glass is full, so it fed the soil.`, true, 5000);
    this.save();
  }

  // you point a predator (or trap) at its prey
  orderHunt(pred) {
    const r = this.world.orderHunt(pred);
    if (r.ok) {
      this.haptic([10, 40, 20]);
      const prey = r.prey.name ? `${r.prey.name} the ${SPECIES[r.prey.kind].name.toLowerCase()}` : `a ${SPECIES[r.prey.species].name.toLowerCase()} egg`;
      this.ui.toast(`${pred.name || 'The ' + SPECIES[pred.kind].name.toLowerCase()} is going after ${prey}.`, false, 4000);
    }
    return r;
  }

  select(obj) {
    this.selected = obj;
    // the first time, say that creatures can be carried
    if (obj && this.world.canCarry(obj)) {
      let seen = false;
      try { seen = localStorage.getItem('glasswild.carryHint') === '1'; localStorage.setItem('glasswild.carryHint', '1'); } catch {}
      if (!seen) setTimeout(() => this.ui.toast('Tip: press and drag a selected creature to carry it somewhere else.', false, 5000), 700);
    }
    if (this.camT.z > 1.2 && obj && obj.genome && obj.scale) this.follow = obj;
    this.ui.showInspector(obj);
  }

  // ------------------------------------------------------------ input
  // one finger taps (and pans when zoomed); two fingers pinch; the mouse
  // wheel zooms; a double tap zooms in (following a creature if it hits one)
  bindInput() {
    const cv = this.canvas, pts = new Map();
    let down = null, pinch = null, panned = false, grab = null;
    // the selected creature can be picked up: press on it and drag, or hold
    const toWorld = (sx, sy) => { const c = this.cam; return { x: c.x + sx / c.z, y: c.y + sy / c.z }; };
    const onSelected = (sx, sy) => {
      const c = this.selected, w = this.world;
      if (!w.canCarry(c) || !w.fauna.includes(c) || this.ui.openSheet) return false;
      const p = toWorld(sx, sy);
      const U = w.U, k = c.scale;
      const r = Math.max(c.hitR * U * k * 1.7, 26 / this.cam.z);
      return Math.hypot(p.x - c.x, p.y - (c.y - c.hitDY * U * k)) < r;
    };
    const lift = () => {
      if (!grab || grab.lifted) return;
      const w = this.world, c = grab.c;
      const saved = w.grab(c);
      grab.lifted = true;
      document.body.classList.add('carrying');
      this.follow = null;
      this.gesturing = true;
      this.haptic(saved ? [15, 30, 15] : 15);
      if (saved) this.ui.toast(`You snatched ${c.name} away from ${saved.name || 'the ' + SPECIES[saved.kind].name.toLowerCase()}!`, false, 3500);
      w.particles.burst(c.x, c.y, 6, { type: 'spark', color: c.genome.c1, glow: c.genome.glow, speed: 7 * w.U, life: 0.7, g: -2 * w.U });
      if (this.settings.tapSounds) this.audio.voice(c.kind, c.genome.seed, 0);
    };
    const release = () => {
      if (!grab) return;
      clearTimeout(grab.timer);
      if (grab.lifted) { this.world.drop(grab.c); this.haptic(6); this.gesturing = false; document.body.classList.remove('carrying'); }
      grab = null;
    };
    const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };
    cv.addEventListener('pointerdown', (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now() }; panned = false;
        if (onSelected(e.clientX, e.clientY)) {
          const p = toWorld(e.clientX, e.clientY), c = this.selected;
          grab = { c, dx: c.x - p.x, dy: c.y - p.y, lifted: false, timer: setTimeout(lift, 220) };
        }
      } else if (pts.size === 2) {
        release();
        const g = two();
        pinch = { ...g, z: this.camT.z, cx: this.camT.x, cy: this.camT.y };
        down = null; this.follow = null; this.gesturing = true;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (pinch && pts.size >= 2) {
        const g = two();
        const nz = Math.max(1, Math.min(MAX_ZOOM, pinch.z * g.d / pinch.d));
        const wx = pinch.cx + pinch.mx / pinch.z, wy = pinch.cy + pinch.my / pinch.z;
        this.setCam(nz, wx - g.mx / nz, wy - g.my / nz, true);
      } else if (grab && pts.size === 1) {
        if (!grab.lifted && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) lift();
        if (grab.lifted) {
          const p = toWorld(e.clientX, e.clientY);
          this.world.carry(grab.c, p.x + grab.dx, p.y + grab.dy);
          panned = true; // not a tap
        }
      } else if (down && pts.size === 1 && this.camT.z > 1.01) {
        if (panned || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) {
          panned = true; this.follow = null; this.gesturing = true;
          const t = this.camT;
          this.setCam(t.z, t.x - (e.clientX - down.lx) / t.z, t.y - (e.clientY - down.ly) / t.z, true);
        }
        down.lx = e.clientX; down.ly = e.clientY;
      }
    });
    const end = (e, cancel) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size) return;
      if (grab) { const was = grab.lifted; release(); if (was) { down = null; return; } }
      this.gesturing = false;
      if (down && !panned && !cancel && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12 && performance.now() - down.t < 600) this.tap(e.clientX, e.clientY);
      down = null;
    };
    cv.addEventListener('pointerup', (e) => end(e, false));
    cv.addEventListener('pointercancel', (e) => end(e, true));
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.follow = null; this.zoomAt(e.clientX, e.clientY, this.camT.z * Math.exp(-e.deltaY * 0.0015), true); }, { passive: false });
    document.getElementById('zoom-reset').addEventListener('click', () => this.resetZoom());
    window.addEventListener('resize', () => { clearTimeout(this.rz); this.rz = setTimeout(() => this.resize(), 120); });
  }

  doubleTap(sx, sy) {
    if (this.camT.z > 1.3) { this.resetZoom(); return; }
    const cam = this.camT;
    const hit = this.world.pick(cam.x + sx / cam.z, cam.y + sy / cam.z);
    this.zoomAt(sx, sy, 2.5);
    if (hit && hit.type === 'fauna') { this.select(hit.obj); this.follow = hit.obj; }
  }

  tap(sx, sy) {
    const w = this.world, U = w.U;
    if (this.ui.openSheet) { this.ui.close(); return; }
    const now = performance.now(), lt = this.lastTap;
    if (lt && now - lt.t < 320 && Math.hypot(sx - lt.x, sy - lt.y) < 36) { this.lastTap = null; this.doubleTap(sx, sy); return; }
    this.lastTap = { t: now, x: sx, y: sy };
    const cam = this.cam, x = cam.x + sx / cam.z, y = cam.y + sy / cam.z;
    w.pickZ = cam.z;
    w.lastTouch = { x, y };
    clearTimeout(this.touchT);
    this.touchT = setTimeout(() => (w.lastTouch = null), 6000);
    // creatures win over everything else
    const hit = w.pick(x, y);
    if (hit && hit.type === 'fauna') {
      this.select(hit.obj);
      this.haptic(5);
      // a tapped creature answers in its own instrument
      if (this.settings.tapSounds) this.audio.voice(hit.obj.kind, hit.obj.genome.seed, Math.max(-0.8, Math.min(0.8, x / w.W * 2 - 1)));
      return;
    }
    const task = this.garden.hit(x, y);
    if (task) {
      this.haptic(5);
      this.ui.showTaskCard(task);
      return;
    }
    if (hit) { this.select(hit.obj); this.haptic(5); return; }
    if (this.ui.inspecting) this.ui.hideInspector();
    if (this.ui.cardTask) this.ui.hideTaskCard();
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
    this.reminders.catchUp(this.garden.tasks, this.hiddenAt);
    this.hiddenAt = 0;
    if (gone > 20) {
      this.garden.updateWeeds();
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
    if (this.leaving) return;
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
      case 'reminders':
        if (s.reminders && !boot) {
          this.reminders.permit().then((ok) => {
            if (!ok) { this.setSetting('reminders', false); this.ui.renderSettings(); this.ui.toast('Notifications are blocked for Glasswild. Allow them in your phone’s settings to get reminders.', false, 6000); return; }
            this.reminders.sync(this.garden.tasks);
            this.ui.toast(this.native ? 'Reminders are on. You’ll get one when a task is due.' : 'Reminders are on. In the browser they arrive while Glasswild is open; the Android app can remind you when it’s closed.', false, 6000);
          });
        } else this.reminders.sync(this.garden.tasks);
        break;
      case 'remindLead': this.reminders.sync(this.garden.tasks); break;
      case 'autoSpawn': this.world.taskOnly = !s.autoSpawn; if (!boot) this.ui.toast(s.autoSpawn ? 'Automatic spawning is on. The glass will grow and breed on its own again.' : 'Automatic spawning is off. Every new creature and plant now comes from a task you finish.', false, 6000); break;
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
  // both replace the save and reload; the autosave that fires as the page
  // unloads must not write the old glass back over it
  importData(d) {
    if (!d || !d.world || !Array.isArray(d.world.fauna)) throw new Error('bad file');
    this.leaving = true;
    this.stop();
    store.set(SAVE_KEY, d);
    location.reload();
  }
  resetWorld() {
    this.leaving = true;
    this.stop();
    store.del(SAVE_KEY);
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
