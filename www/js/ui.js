// DOM side of the app: dock, sheets, the task list, the field journal,
// settings, the creature inspector and toasts.
import { SPECIES, FAUNA_KINDS, PREDATORS } from './species.js';
import { CREATURES } from './fauna.js';
import { Plant } from './flora.js';
import { Ambient, escapeHtml, fmtAge, fmtDuration, mulberry32, hashStr, clamp } from './util.js';
import { dayKey } from './tasks.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const PERF_HINT = {
  saver: '12 frames a second at reduced resolution. Made for leaving on all day.',
  balanced: '24 frames a second. Smooth enough, gentle on the battery.',
  smooth: 'Up to 60 frames a second at full resolution. Prettiest, hungriest.',
};
const FLORA_ORDER = ['fanfern', 'bulbstalk', 'lanternlily', 'puffcap', 'tubebloom', 'coilspire', 'snaplure', 'dewveil', 'gloomcap'];
const RING_C = 2 * Math.PI * 15; // circumference of the focus-bar progress ring (r=15)

export class UI {
  constructor(app) {
    this.app = app;
    this.world = app.world;
    this.garden = app.garden;
    this.settings = app.settings;
    this.openSheet = null;
    this.idleTimer = 0;
    this.portraitAmb = new Ambient();
    this.portraitAmb.set('#ffffff', 0, 0);
    this.bindDock();
    this.bindSheets();
    this.bindTasks();
    this.bindJournal();
    this.bindSettings();
    this.bindInspector();
    this.garden.onChange(() => { this.renderTasks(); this.renderFocus(); });
    this.renderTasks();
    this.renderFocus();
    this.wake();
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => this.wake(), { passive: true });
  }

  // ------------------------------------------------------------ idle fade
  wake() {
    this.lastInput = performance.now();
    document.body.classList.remove('idle');
    clearTimeout(this.idleTimer);
    if (this.settings.autohide) this.idleTimer = setTimeout(() => { if (!this.openSheet) document.body.classList.add('idle'); }, 9000);
  }
  get idle() { return document.body.classList.contains('idle'); }

  // ------------------------------------------------------------ dock & sheets
  bindDock() {
    $$('#dock [data-open]').forEach((b) => b.addEventListener('click', () => this.open(b.dataset.open)));
    $('#focus-pause').addEventListener('click', () => { const t = this.garden.active; if (t) this.garden.pause(t.id); });
    $('#focus-done').addEventListener('click', () => { const t = this.garden.active; if (t) this.app.completeTask(t.id); });
  }

  bindSheets() {
    $('#scrim').addEventListener('click', () => this.close());
    $$('.sheet .close').forEach((b) => b.addEventListener('click', () => this.close()));
    // drag the grab handle down to dismiss
    $$('.sheet').forEach((sheet) => {
      const grab = $('.grab', sheet);
      let y0 = null;
      const move = (e) => { if (y0 == null) return; const dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translate(-50%, ${dy}px)`; };
      const up = (e) => {
        if (y0 == null) return;
        const dy = e.clientY - y0; y0 = null;
        sheet.style.transform = '';
        if (dy > 80) this.close();
      };
      grab.addEventListener('pointerdown', (e) => { y0 = e.clientY; grab.setPointerCapture(e.pointerId); });
      grab.addEventListener('pointermove', move);
      grab.addEventListener('pointerup', up);
      grab.addEventListener('pointercancel', up);
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.close(); this.hideInspector(); } });
  }

  open(name) {
    if (this.openSheet === name) return this.close();
    if (this.openSheet) this.close(true);
    this.hideInspector();
    const el = $(`#sheet-${name}`);
    el.hidden = false;
    el.classList.remove('closing');
    $('#scrim').hidden = false;
    this.openSheet = name;
    if (name === 'tasks') { this.renderTasks(); }
    if (name === 'journal') this.renderJournal();
    if (name === 'settings') this.renderSettings();
    this.wake();
  }

  close(instant) {
    const name = this.openSheet;
    if (!name) return;
    const el = $(`#sheet-${name}`);
    this.openSheet = null;
    $('#scrim').hidden = true;
    document.activeElement?.blur?.();
    if (instant) { el.hidden = true; return; }
    el.classList.add('closing');
    setTimeout(() => { if (this.openSheet !== name) { el.hidden = true; el.classList.remove('closing'); } }, 230);
    this.wake();
  }

  // ------------------------------------------------------------ tasks
  bindTasks() {
    $('#task-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('#task-input');
      const t = this.garden.add(inp.value);
      if (t) { inp.value = ''; this.app.audio.plant(); this.app.haptic(8); }
    });
    const onAct = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const id = b.closest('li').dataset.id;
      const act = b.dataset.act;
      if (act === 'start') { this.garden.start(id); this.app.haptic(6); }
      else if (act === 'pause') this.garden.pause(id);
      else if (act === 'tplus' || act === 'tminus') { this.garden.stepTarget(id, act === 'tplus' ? 1 : -1); this.app.haptic?.(4); }
      else if (act === 'done') { this.app.completeTask(id); }
      else if (act === 'del') {
        if (b.classList.contains('armed')) this.garden.remove(id);
        else { b.classList.add('armed'); b.setAttribute('aria-label', 'Tap again to compost'); setTimeout(() => b.classList.remove('armed'), 2500); }
      }
    };
    $('#task-list').addEventListener('click', onAct);
    // typed targets apply when you leave the box or press enter
    $('#task-list').addEventListener('change', (e) => {
      const inp = e.target.closest('input.tmin');
      if (!inp) return;
      const v = parseInt(inp.value, 10);
      if (v > 0) this.garden.setTarget(inp.dataset.tid, v);
      else this.renderTasks();
    });
    $('#task-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input.tmin')) e.target.blur(); });
    $('#focus-plus').addEventListener('click', () => { const t = this.garden.active; if (t) { this.garden.stepTarget(t.id, 1); this.app.haptic?.(4); } });
    $('#done-list').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-cid]');
      if (li) { const c = this.world.find(li.dataset.cid); if (c) { this.close(); this.app.select(c); } }
    });
  }

  renderTasks() {
    const g = this.garden;
    const pending = g.pending.sort((a, b) => (b.state === 'active') - (a.state === 'active') || a.created - b.created);
    const done = g.doneToday.sort((a, b) => b.completedAt - a.completedAt);
    const badge = $('#task-badge');
    badge.hidden = !pending.length;
    badge.textContent = pending.length;
    if (this.openSheet !== 'tasks') return;
    $('#growing-count').textContent = pending.length ? `· ${pending.length}` : '';
    $('#bloomed-count').textContent = done.length ? `· ${done.length}` : '';
    $('#task-hint').hidden = this.world.stats.tasksDone > 2 && pending.length > 0;
    const icon = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
    const PLAY = icon('<path d="M8 5.5v13l10-6.5z"/>');
    const PAUSE = icon('<path d="M8 6v12M16 6v12"/>');
    const DONE = icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
    const DEL = icon('<path d="M7 7l10 10M17 7L7 17"/>');
    $('#task-list').innerHTML = pending.length ? pending.map((t) => {
      const el = g.elapsed(t);
      const active = t.state === 'active';
      const ripe = el >= g.targetMs(t);
      const cls = [active && 'active', ripe && 'ripe'].filter(Boolean).join(' ');
      return `<li data-id="${t.id}" class="${cls}">
        <i class="pod" style="background:${t.c1}"></i>
        <div class="t"><b>${escapeHtml(t.title)}</b>
          <div class="meta"><span data-el="${t.id}">${this.taskStatus(t)}</span></div>
          <div class="stepper"><button data-act="tminus" aria-label="5 minutes less">−</button><input class="tmin" data-tid="${t.id}" type="number" inputmode="numeric" min="1" max="600" step="1" value="${t.targetMin}" aria-label="Focus target in minutes"><span class="unit">min</span><button data-act="tplus" aria-label="5 minutes more">+</button></div>
          ${active || el > 0 ? `<i class="prog"><i data-pg="${t.id}" style="width:${(g.progress(t) * 100).toFixed(1)}%"></i></i>` : ''}</div>
        <div class="acts">
          <button class="icon-btn" data-act="${active ? 'pause' : 'start'}" aria-label="${active ? 'Pause' : 'Start'}">${active ? PAUSE : PLAY}</button>
          <button class="icon-btn accent" data-act="done" aria-label="Finish">${DONE}</button>
          <button class="icon-btn del" data-act="del" aria-label="Compost">${DEL}</button>
        </div></li>`;
    }).join('') : '<li class="empty">No seeds yet. What are you working on?</li>';
    $('#done-list').innerHTML = done.length ? done.map((t) => {
      const c = t.creature;
      const alive = c && this.world.find(c.id);
      return `<li ${alive ? `data-cid="${c.id}"` : ''}>
        <i class="pod" style="background:${t.c1};border-radius:50%"></i>
        <div class="t"><b>${escapeHtml(t.title)}</b><span>${c ? `became ${escapeHtml(c.name)} the ${SPECIES[c.kind].name}${alive ? ' ›' : ''}` : 'fed the soil'}${t.focusMs > 60000 ? ' · ' + fmtDuration(t.focusMs) + ' tended' : ''}</span></div></li>`;
    }).join('') : '<li class="empty">Nothing yet today.</li>';
    const s = this.world.stats;
    $('#task-stats').textContent = s.tasksDone ? `${s.tasksDone} task${s.tasksDone === 1 ? '' : 's'} bloomed since this glass was sealed.${this.nextUnlockText()}` : this.nextUnlockText().trim();
  }

  nextUnlockText() {
    const done = this.world.stats.tasksDone;
    const next = Object.entries(SPECIES).filter(([, s]) => s.unlock > done).sort((a, b) => a[1].unlock - b[1].unlock)[0];
    if (!next) return ' Every known species has found the glass.';
    const n = next[1].unlock - done;
    return ` ${n} more and something new will arrive.`;
  }

  // "12:03 / 25:00" style status line for a task row
  taskStatus(t) {
    const g = this.garden;
    const el = g.elapsed(t);
    const of = `${fmtDuration(el)} / ${fmtDuration(g.targetMs(t))}`;
    if (t.state === 'active') return (el >= g.targetMs(t) ? 'in bloom · ' : 'growing · ') + of;
    return el > 0 ? 'resting · ' + of : 'a seed in the soil';
  }

  tickTasks() {
    const g = this.garden;
    const t = g.active;
    if (!t) return;
    const el = g.elapsed(t);
    if (el >= g.targetMs(t) && !t.chimed) {
      t.chimed = true;
      this.app.focusReached?.(t);
      this.toast(`“${t.title}” has reached ${t.targetMin} minutes. Finish it, or keep growing.`, true, 7000);
      g.changed(); // persists, and re-renders the list and focus bar
      return;
    }
    this.updateFocusTime(t);
    if (this.openSheet === 'tasks') {
      const s = $(`[data-el="${t.id}"]`);
      if (s) s.textContent = this.taskStatus(t);
      const pg = $(`[data-pg="${t.id}"]`);
      if (pg) pg.style.width = `${(g.progress(t) * 100).toFixed(1)}%`;
    }
  }

  updateFocusTime(t) {
    const g = this.garden;
    const el = g.elapsed(t);
    const ripe = el >= g.targetMs(t);
    $('#focus-now').textContent = fmtDuration(el);
    $('#focus-target').textContent = fmtDuration(g.targetMs(t));
    $('#focus-arc').style.strokeDashoffset = (RING_C * (1 - g.progress(t))).toFixed(2);
    $('#focus-bar').classList.toggle('ripe', ripe);
  }

  renderFocus() {
    const t = this.garden.active;
    const bar = $('#focus-bar');
    bar.hidden = !t;
    if (t) {
      $('#focus-title').textContent = t.title;
      const dot = bar.querySelector('.dot');
      dot.style.background = t.glow;
      dot.style.boxShadow = `0 0 10px ${t.glow}`;
      this.updateFocusTime(t);
    }
  }

  // ------------------------------------------------------------ journal
  bindJournal() {
    $$('#sheet-journal .tabs button').forEach((b) => b.addEventListener('click', () => {
      $$('#sheet-journal .tabs button').forEach((x) => x.classList.toggle('on', x === b));
      this.tab = b.dataset.tab;
      this.renderJournal();
    }));
    this.tab = 'species';
    $('#tab-living').addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const c = this.world.find(row.dataset.id);
      if (c) { this.close(); this.app.select(c); }
    });
  }

  renderJournal() {
    for (const k of ['species', 'living', 'log']) $(`#tab-${k}`).hidden = k !== this.tab;
    if (this.tab === 'species') this.renderSpecies();
    else if (this.tab === 'living') this.renderLiving();
    else this.renderLog();
  }

  renderSpecies() {
    const w = this.world;
    const disc = w.stats.discovered;
    const counts = {};
    for (const c of w.fauna) counts[c.kind] = (counts[c.kind] || 0) + 1;
    const fc = w.countFlora();
    const kinds = [...FAUNA_KINDS, 'gloamwhale', ...FLORA_ORDER].filter((k) => SPECIES[k]);
    const el = $('#tab-species');
    el.innerHTML = kinds.map((k) => {
      const s = SPECIES[k];
      const flora = s.kind === 'flora';
      const known = flora ? (fc[k] > 0 || disc[k] || s.unlock === 0) : !!disc[k];
      if (!known) {
        const left = s.unlock - w.stats.tasksDone;
        return `<div class="species locked"><canvas data-k="${k}" width="168" height="168"></canvas><div><h4>Unknown</h4><p class="latin">${left > 0 ? `Arrives after ${left} more finished task${left === 1 ? '' : 's'}` : 'Not yet seen'}</p><p>Something has been glimpsed at the edges of the glass.</p></div></div>`;
      }
      let meta;
      if (flora) meta = `${fc[k] || 0} growing`;
      else if (k === 'gloamwhale') meta = 'Visitor · passes overhead';
      else meta = `${counts[k] || 0} living · generation ${w.stats.maxGen[k] || 1} · eats ${s.diet.toLowerCase()}`;
      return `<div class="species"><canvas data-k="${k}" width="168" height="168"></canvas><div><h4>${s.name}</h4><p class="latin">${s.latin}</p><p>${s.notes}</p><p class="meta">${meta}</p></div></div>`;
    }).join('');
    $$('canvas[data-k]', el).forEach((cv) => this.portrait(cv, cv.dataset.k));
  }

  renderLiving() {
    const w = this.world;
    const order = (k) => FAUNA_KINDS.indexOf(k);
    const list = [...w.fauna].sort((a, b) => order(a.kind) - order(b.kind) || b.age - a.age);
    const eggs = w.eggs.length;
    $('#tab-living').innerHTML = (list.length ? list.map((c) => `
      <div class="living" data-id="${c.id}"><i style="background:${c.genome.c1}"></i>
        <div><b>${escapeHtml(c.name)}</b> <small style="color:var(--muted)">${SPECIES[c.kind].name}</small>
        <span>${c.stage} · ${fmtAge(c.age)} old · ${escapeHtml(c.origin)}</span></div><em>gen ${c.gen}</em></div>`).join('')
      : '<p class="hint">Nothing is alive in the glass right now. Give it time.</p>')
      + (eggs ? `<p class="hint">${eggs} egg${eggs === 1 ? '' : 's'}, cocoon${eggs === 1 ? '' : 's'} and spore${eggs === 1 ? '' : 's'} waiting to hatch.</p>` : '');
  }

  renderLog() {
    const logs = [...this.world.logs].reverse();
    let lastDay = '';
    const today = dayKey();
    const html = logs.map((l) => {
      const d = new Date(l.t);
      const k = dayKey(l.t);
      let head = '';
      if (k !== lastDay) {
        lastDay = k;
        head = `<li class="day">${k === today ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</li>`;
      }
      const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return `${head}<li><time>${time}</time><span class="k-${l.kind}">${escapeHtml(l.msg)}</span></li>`;
    }).join('');
    $('#tab-log').innerHTML = `<ul class="log">${html || '<li>Nothing has happened yet.</li>'}</ul>`;
  }

  // Draw a creature or plant into a small canvas using its real draw code.
  portrait(cv, kindOrObj) {
    const ctx = cv.getContext('2d');
    const S = cv.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const w = this.world;
    const kind = typeof kindOrObj === 'string' ? kindOrObj : kindOrObj.kind;
    const src = typeof kindOrObj === 'string' ? (w.fauna.find((c) => c.kind === kind) || w.flora.find((p) => p.kind === kind)) : kindOrObj;
    const stub = {
      t: w.t, night: 0, gust: 0, sky: w.sky, W: S, H: S, topInset: 0, clock: w.clock,
      groundY: () => S * 0.86, mindPulse: null, focusPod: null, lastTouch: null,
    };
    const amb = this.portraitAmb;
    try {
      this.drawPortrait(ctx, S, w, kind, src, stub, amb);
    } catch (err) {
      console.warn('portrait failed for', kind, err);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, S, S);
    }
  }

  drawPortrait(ctx, S, w, kind, src, stub, amb) {
    if (kind === 'gloamwhale') {
      ctx.fillStyle = '#8fa7b4'; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.ellipse(S / 2, S * 0.45, S * 0.42, S * 0.1, -0.1, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#8fa7b4'; ctx.lineWidth = 2;
      ctx.beginPath(); for (let i = 0; i < 8; i++) { const x = S * 0.25 + i * S * 0.07; ctx.moveTo(x, S * 0.52); ctx.quadraticCurveTo(x - 6, S * 0.7, x - 12, S * 0.9); } ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }
    if (SPECIES[kind]?.kind === 'flora') {
      const p = src && src.kind === kind ? new Plant({ ...src, growth: Math.max(0.9, src.growth), wither: 0, x: S / 2 }) : new Plant({ kind, growth: 1, x: S / 2, genome: undefined });
      if (kind === 'bulbstalk') p.ripe = 0.8;
      stub.U = S * 0.78 / (p.genome.h * 1.15);
      p.x = S / 2;
      p.draw(ctx, stub, amb);
      return;
    }
    const C = CREATURES[kind];
    const genome = src && src.kind === kind ? src.genome : C.randomGenome(mulberry32(hashStr(kind)));
    const c = new C({ genome, age: C.mature * 2, life: C.mature * 100, energy: 0.8, dir: 1, state: 'idle' });
    c.flapT = 1.2; c.vx = 0; c.vy = 0; c.swim = w.t; c.rest = 0; c.headOpen = 0.5; c.gait = 0.25;
    const frame = {
      scuttler: [S / 10, S * 0.4, S * 0.68],
      petalmoth: [S / 9, S * 0.45, S * 0.5],
      bellwisp: [S / 25, S * 0.5, S * 0.3],
      ribbonfin: [S / 15, S * 0.62, S * 0.5],
      stiltstrider: [S / 30, S * 0.5, S * 0.93],
      mindbloom: [S / 22, S * 0.5, S * 0.32],
      hookjaw: [S / 16, S * 0.45, S * 0.7],
      lancewing: [S / 12, S * 0.5, S * 0.5],
      mireeel: [S / 18, S * 0.5, S * 0.5],
    }[kind] || [S / 14, S * 0.5, S * 0.6];
    stub.U = frame[0] / genome.size;
    c.x = frame[1]; c.y = frame[2];
    if (kind === 'mindbloom') c.ax = c.x / S;
    if (kind === 'stiltstrider') { c._hx = undefined; }
    c.draw(ctx, stub, amb);
  }

  // ------------------------------------------------------------ settings
  bindSettings() {
    $$('#sheet-settings .seg').forEach((seg) => seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      this.app.setSetting(seg.dataset.key, b.dataset.v);
      this.renderSettings();
    }));
    $$('#sheet-settings input[data-key]').forEach((inp) => inp.addEventListener('input', () => {
      const v = inp.type === 'checkbox' ? inp.checked : parseFloat(inp.value);
      this.app.setSetting(inp.dataset.key, v);
      if (inp.dataset.key === 'dim') $('#dim-val').textContent = `${Math.round(v * 100)}%`;
    }));
    $('#btn-export').addEventListener('click', () => this.app.exportData());
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { this.app.importData(JSON.parse(await f.text())); } catch { this.toast('That file could not be read.'); }
      e.target.value = '';
    });
    const reset = $('#btn-reset');
    reset.addEventListener('click', () => {
      if (reset.dataset.armed) { this.app.resetWorld(); reset.textContent = 'Start a new glass'; delete reset.dataset.armed; this.close(); return; }
      reset.dataset.armed = '1';
      reset.textContent = 'Tap again: everything will be lost';
      setTimeout(() => { reset.textContent = 'Start a new glass'; delete reset.dataset.armed; }, 3500);
    });
    if (this.app.native) $$('.native-only').forEach((el) => (el.hidden = false));
  }

  renderSettings() {
    const s = this.settings;
    $$('#sheet-settings .seg').forEach((seg) => $$('button', seg).forEach((b) => b.classList.toggle('on', String(s[seg.dataset.key]) === b.dataset.v)));
    $$('#sheet-settings input[data-key]').forEach((inp) => {
      if (inp.type === 'checkbox') inp.checked = !!s[inp.dataset.key];
      else inp.value = s[inp.dataset.key];
    });
    $('#dim-val').textContent = `${Math.round(s.dim * 100)}%`;
    $('#perf-hint').textContent = PERF_HINT[s.perf];
    const w = this.world;
    const days = (Date.now() - w.stats.created) / 86400000;
    $('#world-stats').textContent = `Sealed ${days < 1 ? 'today' : Math.floor(days) + ' day' + (Math.floor(days) === 1 ? '' : 's') + ' ago'}. ${w.fauna.length} creatures and ${w.flora.length} plants alive. ${w.stats.births} births, ${w.stats.deaths} deaths, ${w.stats.tasksDone} tasks bloomed.`;
  }

  // ------------------------------------------------------------ inspector
  bindInspector() {
    $('#inspector .close').addEventListener('click', () => this.hideInspector());
    $('#insp-hunt').addEventListener('click', () => {
      const obj = this.inspecting;
      if (obj) this.app.orderHunt(obj);
      this.updateInspector(false);
    });
    $('#insp-name').addEventListener('click', () => {
      const sel = this.app.selected;
      if (!sel || !sel.name || !sel.genome || !CREATURES[sel.kind]) return;
      const n = prompt('Give this creature a name', sel.name);
      if (n && n.trim()) { sel.name = n.trim().slice(0, 24); this.showInspector(sel); }
    });
  }

  showInspector(obj) {
    const el = $('#inspector');
    el.hidden = false;
    this.inspecting = obj;
    this.updateInspector(true);
  }

  updateInspector(full) {
    const obj = this.inspecting;
    if (!obj) return;
    const w = this.world;
    const isCreature = !!CREATURES[obj.kind] && obj.name;
    const isEgg = !!obj.species;
    const kind = isEgg ? obj.species : obj.kind;
    const sp = SPECIES[kind];
    if (obj.dead || obj.gone) {
      $('#insp-origin').textContent = isEgg ? 'It has hatched.' : 'It is gone now.';
      return;
    }
    let facts = [];
    if (isCreature) {
      $('#insp-name').textContent = obj.name;
      $('#insp-latin').textContent = `${sp.name} · ${sp.latin}`;
      const stage = obj.stage;
      const doing = { eat: 'feeding', feed: 'feeding', perch: 'resting on the clock', walk: 'wandering', fly: 'flying', dig: 'burrowing', tunnel: 'tunnelling', rise: 'surfacing', jump: 'leaping!', swim: 'swimming', stalk: 'stalking', pounce: 'pouncing!', digest: 'digesting', soar: 'soaring', dive: 'diving!', climb: 'climbing', lurk: 'lurking', strike: 'striking!', idle: obj.rest > 0.5 ? 'asleep' : 'pausing' }[obj.state] || 'drifting';
      facts = [['Stage', stage], ['Age', fmtAge(obj.age)], ['Generation', obj.gen], ['Now', obj._trance > 0 ? 'entranced' : kind === 'bellwisp' ? (w.night > 0.5 ? 'glowing' : 'basking') : kind === 'mindbloom' ? 'watching' : doing]];
      $('#insp-energy').style.width = `${clamp(obj.energy, 0, 1) * 100}%`;
      $('#insp-origin').textContent = obj.origin;
    } else if (isEgg) {
      $('#insp-name').textContent = { petalmoth: 'Cocoon', stiltstrider: 'Egg', bellwisp: 'Drifting spore', ribbonfin: 'Roe' }[kind] || 'Egg';
      $('#insp-latin').textContent = `${sp.name} · ${sp.latin}`;
      facts = [['Hatches in', fmtAge(Math.max(0, obj.hatch - obj.age))], ['Generation', obj.gen]];
      $('#insp-energy').style.width = `${clamp(obj.age / obj.hatch, 0, 1) * 100}%`;
      $('#insp-origin').textContent = obj.parentName ? `Parent: ${obj.parentName}` : obj.origin || '';
    } else {
      $('#insp-name').textContent = sp.name;
      $('#insp-latin').textContent = sp.latin;
      facts = [['Age', fmtAge(obj.age)], ['Grown', `${Math.round(obj.growth * 100)}%`]];
      if (obj.kind === 'bulbstalk') facts.push(['Fruit', obj.ripe > 0.95 ? 'ripe' : `${Math.round(obj.ripe * 100)}%`]);
      if (obj.kind === 'lanternlily') facts.push(['Nectar', `${Math.round(obj.nectar * 100)}%`]);
      if (obj.kind === 'snaplure' || obj.kind === 'dewveil') facts.push(['Trap', obj.closed > 0.5 ? 'digesting' : 'set']);
      if (obj.wither > 0) facts.push(['State', 'withering']);
      $('#insp-energy').style.width = `${clamp(obj.growth, 0, 1) * 100}%`;
      $('#insp-origin').textContent = `Soil here: ${Math.round(w.fertAt(obj.x) * 100)}% rich`;
    }
    if (!isEgg && obj.inf > 0) facts.push(['Health', 'infected by gloomcap fungus']);
    if (isCreature && obj.digest > 0 && !obj.hunt) facts.push(['Digesting', fmtAge(obj.digest)]);
    this.huntButton(obj, isEgg);
    $('#insp-facts').innerHTML = facts.map(([a, b]) => `<dt>${a}</dt><dd>${escapeHtml(String(b))}</dd>`).join('');
    if (full || isCreature) this.portrait($('#insp-portrait'), isEgg ? kind : obj);
  }

  // predators and traps can be sent to hunt, every so often
  huntButton(obj, isEgg) {
    const b = $('#insp-hunt');
    const hunter = !isEgg && (PREDATORS.includes(obj.kind) || obj.kind === 'snaplure' || obj.kind === 'dewveil');
    b.hidden = !hunter;
    if (!hunter) return;
    const st = this.world.orderStatus(obj);
    const trap = obj.kind === 'snaplure' ? 'Lure a petalmoth' : obj.kind === 'dewveil' ? 'Lure a bellwisp' : 'Send to hunt';
    const text = st.ok ? trap
      : st.why === 'cooldown' ? `Hunters are resting · ${fmtDuration(st.wait)}`
      : st.why === 'busy' ? (obj.hunt || obj.lured ? 'Hunting…' : 'Busy')
      : st.why === 'young' ? 'Too young to hunt'
      : st.why === 'noprey' ? 'Not enough prey to spare'
      : 'Unavailable';
    if (b.textContent !== text) b.textContent = text;
    b.disabled = !st.ok;
  }

  hideInspector() {
    $('#inspector').hidden = true;
    this.inspecting = null;
    this.app.selected = null;
  }

  // ------------------------------------------------------------ toasts
  toast(msg, big = false, ms = 4200) {
    const box = $('#toasts');
    while (box.children.length > 2) box.firstChild.remove();
    const t = document.createElement('div');
    t.className = 'toast' + (big ? ' big' : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 500); }, ms);
  }
}
