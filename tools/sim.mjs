// Headless ecosystem harness: runs seeded terrariums for days and checks the
// invariants that keep the glass healthy. `npm test` runs the default suite.
//
//   node tools/sim.mjs [--days=7] [--seeds=12] [--done=30] [--live=0] [--csv] [--quiet]
//
// --done sets how many tasks have been finished (unlocks species).
// --live=H additionally runs H hours of per-frame motion (10 Hz) for seed 1.
import { World } from '../www/js/world.js';
import { mulberry32 } from '../www/js/util.js';
import { FAUNA_KINDS, SPECIES } from '../www/js/species.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const DAYS = +(args.days ?? 7);
const SEEDS = +(args.seeds ?? 12);
const DONES = args.done != null ? [+args.done] : [0, 10, 30];
const LIVE_H = +(args.live ?? 0);
const QUIET = !!args.quiet;
const HR = 3600;

const fails = [];
const fail = (ctx, msg) => { fails.push(`${ctx}: ${msg}`); if (fails.length < 40) console.error('FAIL', ctx, msg); };

function makeWorld(seed, done) {
  Math.random = mulberry32(seed * 7919 + 13);
  let now = Date.UTC(2026, 9, 21, 7, 0, 0);
  const w = new World(seed);
  w.clockFn = () => now;
  w.simTime = now;
  w.layout(390, 844, 0);
  w.genesis();
  w.stats.tasksDone = done;
  // what finishing those tasks would have brought into the glass
  for (const k of FAUNA_KINDS) if (w.unlocked(k) && SPECIES[k].unlock > 0 && !w.count(k)) { w.introduce(k); if (k !== 'mindbloom' && !['hookjaw', 'lancewing', 'mireeel'].includes(k)) w.introduce(k); }
  for (const k of ['snaplure', 'dewveil']) if (w.unlocked(k)) w.introduce(k);
  w._booted = true;
  return { w, advance: (ms) => { now += ms; return now; } };
}

function check(w, ctx) {
  for (const c of w.fauna) {
    for (const f of ['x', 'y', 'energy', 'n', 'age']) if (!Number.isFinite(c[f])) { fail(ctx, `${c.kind}.${f} = ${c[f]}`); return; }
    if (c.n < -1e-9) fail(ctx, `${c.kind} negative n ${c.n}`);
  }
  for (const v of w.soil) if (!Number.isFinite(v) || v < -1e-9) { fail(ctx, `soil ${v}`); break; }
  const total = w.totalN();
  const want = w.stats.n0 + w.stats.nIn;
  if (Math.abs(total - want) > 1e-6 * Math.max(1, total)) fail(ctx, `nutrient not conserved: ${total.toFixed(6)} vs ${want.toFixed(6)}`);
  const recount = {};
  for (const c of w.fauna) if (!c.dead) recount[c.kind] = (recount[c.kind] || 0) + 1;
  for (const k of FAUNA_KINDS) {
    if ((recount[k] || 0) !== (w.pop[k] || 0)) fail(ctx, `census ${k}: ${w.pop[k]} vs recount ${recount[k] || 0}`);
    if ((recount[k] || 0) > SPECIES[k].cap) fail(ctx, `${k} over ceiling: ${recount[k]}`);
  }
  if (w.fauna.length > 40) fail(ctx, `total fauna ${w.fauna.length}`);
  // family tree: everyone alive has a record, and the record stays bounded
  for (const c of w.fauna) if (!w.lineage[c.id]) { fail(ctx, `${c.kind} ${c.id} missing from the lineage`); break; }
  const nl = Object.keys(w.lineage).length;
  if (nl > 320 + w.fauna.length * 9) fail(ctx, `lineage has ${nl} records`);
  for (const c of w.fauna) for (const k of ['bold', 'soc', 'vig', 'fec']) if (!(c.genome[k] >= 0 && c.genome[k] <= 1)) { fail(ctx, `${c.kind}.${k} = ${c.genome[k]}`); return; }
}

function runOffline(seed, done) {
  const { w, advance } = makeWorld(seed, done);
  w.offline = true;
  // --blight=0.9 plays a neglected task's weeds over a third of the glass
  if (args.blight) for (let b = 2; b < 8; b++) w.blight[b] = +args.blight;
  const ctx = `seed=${seed} done=${done}`;
  const series = [];
  const gone = {};
  const stats = { maxGone: {}, infections: 0, kills: 0 };
  const step = 30;
  const causes = {};
  w.on('death', (c) => { const k = `${c.kind}:${c.cause}`; causes[k] = (causes[k] || 0) + 1; });
  let tickMs = 0, ticks = 0;
  for (let h = 0; h < DAYS * 24; h++) {
    for (let i = 0; i < HR / step; i++) {
      w.simTime = advance(step * 1000);
      w.jitter(step);
      const t0 = performance.now();
      w.tick(step);
      tickMs += performance.now() - t0; ticks++;
    }
    check(w, `${ctx} h=${h}`);
    stats.kills += w.act.kills; w.act.kills = 0;
    stats.infections += w.fauna.filter((c) => c.inf).length;
    const row = { h };
    for (const k of FAUNA_KINDS) {
      row[k] = w.count(k);
      if (!w.unlocked(k) || k === 'mindbloom') continue;
      const empty = w.count(k) + w.countEggs(k) === 0;
      gone[k] = empty ? (gone[k] || 0) + 1 : 0;
      stats.maxGone[k] = Math.max(stats.maxGone[k] || 0, gone[k]);
      const banked = w.bank[k]?.count > 0;
      if (empty && banked && gone[k] > 12) fail(`${ctx} h=${h}`, `${k} extinct ${gone[k]}h with a seed bank of ${w.bank[k].count}`);
      if (empty && gone[k] > 54) fail(`${ctx} h=${h}`, `${k} extinct ${gone[k]}h and nobody arrived`);
    }
    row.flora = w.flora.length;
    row.soil = w.soil.reduce((a, b) => a + b, 0);
    series.push(row);
  }
  // a 4-day catch-up the way the app does it, timed
  w.listeners.death = [];
  const t0 = performance.now();
  w.offline = false;
  w.catchUp(4 * 24 * HR);
  const catchMs = performance.now() - t0;
  check(w, `${ctx} after catchUp`);
  stats.causes = causes;
  // where temperament drifted to, per species
  stats.traits = {};
  for (const c of w.fauna) { const t = (stats.traits[c.kind] ||= { n: 0, bold: 0, soc: 0, vig: 0, fec: 0 }); t.n++; for (const k of ['bold', 'soc', 'vig', 'fec']) t[k] += c.genome[k]; }
  stats.lineage = Object.keys(w.lineage).length;
  return { w, series, stats, tickMs: tickMs / ticks, catchMs };
}

function runLive(seed, done, hours) {
  const { w, advance } = makeWorld(seed, done);
  const ctx = `live seed=${seed} done=${done}`;
  const dt = 0.1;
  for (let h = 0; h < hours; h++) {
    for (let i = 0; i < HR / dt; i++) { advance(dt * 1000); w.update(dt); }
    check(w, `${ctx} h=${h}`);
  }
  return w;
}

function summary(series, kinds) {
  const out = {};
  for (const k of kinds) {
    const v = series.map((r) => r[k]);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    out[k] = { min: Math.min(...v), max: Math.max(...v), mean: +mean.toFixed(1), cv: mean ? +(sd / mean).toFixed(2) : 0 };
  }
  return out;
}

const t0 = performance.now();
for (const done of DONES) {
  const agg = {};
  let tick = 0, catchMs = 0, kills = 0, inf = 0;
  const kinds = FAUNA_KINDS.filter((k) => done >= SPECIES[k].unlock);
  let lastSeries;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = runOffline(seed, done);
    lastSeries = r.series;
    tick += r.tickMs; catchMs = Math.max(catchMs, r.catchMs); kills += r.stats.kills; inf += r.stats.infections;
    const s = summary(r.series, [...kinds, 'flora']);
    for (const k in s) { (agg[k] ||= []).push(s[k]); }
    for (const k in r.stats.maxGone) (agg['gone:' + k] ||= []).push(r.stats.maxGone[k]);
    for (const k in r.stats.traits) { const a = (agg.traits ||= {})[k] ||= { n: 0, bold: 0, soc: 0, vig: 0, fec: 0 }; for (const f in a) a[f] += r.stats.traits[k][f]; }
    agg.lineage = Math.max(agg.lineage || 0, r.stats.lineage);
    for (const k in r.stats.causes) agg.causes = { ...(agg.causes || {}), [k]: ((agg.causes || {})[k] || 0) + r.stats.causes[k] };
  }
  if (!QUIET) {
    console.log(`\n== done=${done}: ${SEEDS} seeds × ${DAYS} days, mean tick ${(tick / SEEDS).toFixed(3)} ms, worst 4-day catch-up ${catchMs.toFixed(0)} ms, kills/day ${(kills / SEEDS / DAYS).toFixed(1)}, infected-hours/day ${(inf / SEEDS / DAYS).toFixed(1)}`);
    for (const k of [...kinds, 'flora']) {
      const a = agg[k];
      const g = agg['gone:' + k];
      console.log(`  ${k.padEnd(13)} mean ${(a.reduce((x, y) => x + y.mean, 0) / a.length).toFixed(1).padStart(5)}  range ${Math.min(...a.map((x) => x.min))}–${Math.max(...a.map((x) => x.max))}  cv ${(a.reduce((x, y) => x + y.cv, 0) / a.length).toFixed(2)}${g ? `  longest absence ${Math.max(...g)}h` : ''}`);
    }
  }
  if (args.traits && agg.traits) {
    console.log(`  temperament after ${DAYS} days (started near 0.5), largest family record ${agg.lineage}:`);
    for (const k in agg.traits) { const a = agg.traits[k]; console.log(`    ${k.padEnd(13)} n=${String(a.n).padStart(3)}  bold ${(a.bold / a.n).toFixed(2)}  social ${(a.soc / a.n).toFixed(2)}  watchful ${(a.vig / a.n).toFixed(2)}  prolific ${(a.fec / a.n).toFixed(2)}`); }
  }
  if (args.causes && agg.causes) console.log('  deaths/day by cause:', Object.entries(agg.causes).sort().map(([k, v]) => `${k} ${(v / SEEDS / DAYS).toFixed(1)}`).join(', '));
  if (args.csv && lastSeries) {
    const cols = Object.keys(lastSeries[0]);
    console.log(cols.join(','));
    for (const r of lastSeries) console.log(cols.map((c) => (typeof r[c] === 'number' ? +r[c].toFixed(3) : r[c])).join(','));
  }
  if (catchMs > 1000) fail(`done=${done}`, `4-day catch-up took ${catchMs.toFixed(0)} ms`);
}
if (LIVE_H) { runLive(1, DONES[DONES.length - 1], LIVE_H); if (!QUIET) console.log(`live ${LIVE_H}h ok`); }

console.log(`\n${fails.length ? `${fails.length} FAILURES` : 'all checks passed'} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exit(fails.length ? 1 : 0);
