// Task logic without a browser: due-date parsing, weeds and their blight,
// snoozing, steps, and loading saves from before any of this existed.
import assert from 'node:assert/strict';
import { World } from '../www/js/world.js';
import { TaskGarden } from '../www/js/tasks.js';
import { parseDue, parseEntry, fmtDue, DAY } from '../www/js/when.js';
import { Reminders } from '../www/js/remind.js';

let n = 0;
const test = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`✗ ${name}\n`, e); process.exitCode = 1; } };

// Wednesday 21 Oct 2026, 10:00 local
const now = new Date(2026, 9, 21, 10, 0).getTime();
const day = (t) => new Date(t).toDateString();

test('parse: trailing day words', () => {
  let r = parseDue('collect trash sunday', now);
  assert.equal(r.title, 'collect trash'); assert.equal(day(r.due), new Date(2026, 9, 25).toDateString()); assert.ok(r.allDay);
  r = parseDue('call vet tomorrow 3pm', now);
  assert.equal(r.title, 'call vet'); assert.equal(new Date(r.due).getHours(), 15); assert.ok(!r.allDay);
  assert.equal(parseDue('call vet 3pm tomorrow', now).due, r.due);
  assert.equal(day(parseDue('taxes by oct 24', now).due), new Date(2026, 9, 24).toDateString());
  assert.equal(day(parseDue('rent 11/1', now).due), new Date(2026, 10, 1).toDateString());
  assert.equal(day(parseDue('meeting next wed', now).due), new Date(2026, 9, 28).toDateString());
  assert.equal(day(parseDue('party wednesday', now).due), new Date(2026, 9, 21).toDateString());
});
test('parse: leaves ordinary titles alone', () => {
  for (const s of ['Sunday school prep', 'study for the SAT', 'read chapter 3', 'junk 2', 'today', 'Email: Bob']) assert.equal(parseDue(s, now).due, null, s);
});
test('parse: steps', () => {
  assert.deepEqual(parseEntry('Clean house sun: trash, dishes, vacuum', now).steps, ['trash', 'dishes', 'vacuum']);
  const e = parseEntry('Groceries tomorrow\n- milk\n- eggs\n3. bread', now);
  assert.equal(e.title, 'Groceries'); assert.deepEqual(e.steps, ['milk', 'eggs', 'bread']); assert.ok(e.due);
});
test('format', () => {
  assert.equal(fmtDue(now - 3 * DAY, true, now), '3 days overdue');
  assert.equal(fmtDue(now + DAY, true, now), 'tomorrow');
});

function garden(data) {
  const w = new World(7);
  w.layout(390, 844, 0);
  w.genesis();
  w.offline = true;
  return { w, g: new TaskGarden(w, data) };
}

test('weeds grow by stage, and their blight reaches the world', () => {
  const { w, g } = garden();
  const t = g.add('fix the gutter');
  assert.equal(g.stage(t), 0);
  for (const [late, st] of [[0.5, 1], [2, 2], [4, 3], [8, 4]]) {
    t.due = Date.now() - late * DAY;
    g.updateWeeds();
    assert.equal(g.stage(t), st, `${late} days late`);
  }
  assert.ok(Math.max(...w.blight) > 0.89);
  assert.equal(g.overdueCount, 1);
});
test('undated seeds wilt, then turn after a week untouched', () => {
  const { g } = garden();
  const t = g.add('someday thing');
  t.touched = t.created = Date.now() - 4 * DAY;
  g.updateWeeds();
  assert.ok(g.wilting(t)); assert.equal(g.stage(t), 0);
  t.touched = t.created = Date.now() - 7.5 * DAY;
  g.updateWeeds();
  assert.equal(g.stage(t), 1);
});
test('snoozing makes the weed recede, finishing kills it', () => {
  const { w, g } = garden();
  const t = g.add('book dentist');
  t.due = Date.now() - 4 * DAY;
  g.updateWeeds();
  g.snooze(t.id);
  assert.ok(t.due > Date.now());
  assert.equal(g.stage(t), 3); // still there right after
  t.weedAt -= 0.6 * DAY; // ~14 hours later
  g.updateWeeds();
  assert.ok(g.stage(t) < 3);
  t.due = Date.now() - 9 * DAY; g.updateWeeds();
  assert.equal(g.stage(t), 4);
  g.complete(t.id); g.updateWeeds();
  assert.equal(g.stage(t), 0);
  assert.equal(Math.max(...w.blight), 0);
});
test('steps: the last one blooms the project', () => {
  const { w, g } = garden();
  const t = g.add('Clean house: trash, dishes, vacuum');
  assert.equal(t.steps.length, 3);
  assert.equal(g.toggleStep(t.id, t.steps[0].id), 'done');
  assert.equal(g.toggleStep(t.id, t.steps[0].id), 'undone');
  g.toggleStep(t.id, t.steps[0].id); g.toggleStep(t.id, t.steps[1].id);
  assert.equal(g.toggleStep(t.id, t.steps[2].id), 'all');
  const before = w.stats.tasksDone;
  g.complete(t.id);
  assert.equal(w.stats.tasksDone, before + 1);
  g.addStep(t.id, 'too late');
  assert.equal(t.steps.length, 3);
});
test('old saves load with no dates, steps or weeds', () => {
  const old = { tasks: [{ id: 'z1', title: 'old one', created: Date.now() - 30 * DAY, state: 'seed', focusMs: 0, slot: 0, c1: '#fff', c2: '#000', glow: '#0ff' }], history: [] };
  const { g } = garden(old);
  const t = g.tasks[0];
  assert.deepEqual(t.steps, []); assert.equal(t.due, null); assert.equal(g.stage(t), 0);
  g.updateWeeds();
  assert.equal(g.stage(t), 0);
  assert.ok(JSON.stringify(g.serialize()).includes('"steps":[]'));
});

test('reminders: when due, early, mornings, and the overdue nudge', () => {
  const app = { settings: { reminders: true, remindLead: 'ontime' } };
  const R = new Reminders(app, null);
  const at3 = new Date(2026, 9, 22, 15, 0).getTime();
  const tasks = [
    { id: 'a', title: 'vet', state: 'seed', due: at3, allDay: false },
    { id: 'b', title: 'trash', state: 'seed', due: new Date(2026, 9, 25, 23, 59, 59, 999).getTime(), allDay: true },
    { id: 'c', title: 'done one', state: 'done', due: at3, allDay: false },
    { id: 'd', title: 'no date', state: 'seed', due: null },
  ];
  const plan = R.plan(tasks, now);
  const hm = (t) => new Date(t).toString().slice(0, 21);
  assert.equal(plan.length, 4);
  assert.equal(hm(plan[0].at), hm(at3));
  assert.ok(plan.some((r) => r.title === 'trash' && new Date(r.at).getHours() === 9 && new Date(r.at).getDate() === 25));
  assert.ok(plan.some((r) => r.title === 'Overdue: vet' && new Date(r.at).getDate() === 23 && new Date(r.at).getHours() === 9));
  app.settings.remindLead = '60';
  assert.equal(R.plan(tasks, now)[0].at, at3 - 3600e3);
  // nothing in the past is scheduled
  assert.equal(R.plan(tasks, at3 + 5 * DAY).length, 0);
});

if (!process.exitCode) console.log(`tasks: ${n} tests passed`);
