// Due-date reminders as phone notifications.
//
// In the Android app they are scheduled with the system, so they arrive even
// when Glasswild is closed. In the browser there is no way to schedule a
// notification ahead of time, so they are shown by the page itself: they
// arrive while Glasswild is open (on screen or in the background), and any
// that came due while it was closed are shown when it's next opened.
//
// For every task with a due date:
//   - a reminder when it's due: at its time (or a little before, by the
//     "remind" setting), or at 9 in the morning for a task due "on a day";
//   - one nudge the next morning if it's still not done, when its weed has
//     started to grow.
import { DAY, addDays, fmtDue } from './when.js';

const MORNING = 9; // o'clock, for all-day tasks and overdue nudges
const MAX = 48; // the system allows a limited number of pending alarms
const SHOWN_KEY = 'glasswild.reminded';

// a stable 31-bit id for a task + kind, as Android wants an int
const idOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 1) || 1; };
const morningOf = (t) => { const d = new Date(t); d.setHours(MORNING, 0, 0, 0); return d.getTime(); };

export class Reminders {
  constructor(app, native) {
    this.app = app;
    this.LN = native; // the LocalNotifications plugin, or null on the web
    this.sig = '';
    this.timers = [];
    try { this.shown = new Set(JSON.parse(localStorage.getItem(SHOWN_KEY) || '[]')); } catch { this.shown = new Set(); }
  }

  get supported() { return !!this.LN || ('Notification' in window); }

  // ask once, when the setting is turned on
  async permit() {
    try {
      if (this.LN) {
        let p = await this.LN.checkPermissions();
        if (p.display !== 'granted') p = await this.LN.requestPermissions();
        return p.display === 'granted';
      }
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;
      return (await Notification.requestPermission()) === 'granted';
    } catch { return false; }
  }

  // what should be scheduled for the current task list
  plan(tasks, now = Date.now()) {
    const lead = { ontime: 0, '15': 15, '60': 60 }[this.app.settings.remindLead] ?? 0;
    const out = [];
    for (const t of tasks) {
      if (t.state === 'done' || t.due == null) continue;
      let at = t.allDay ? morningOf(t.due) : t.due - lead * 60000;
      // too late for the early warning, but not for the due time itself
      if (!t.allDay && at <= now && t.due > now) at = Math.min(t.due, now + 5000);
      const when = fmtDue(t.due, t.allDay, Math.min(at, t.due - 1));
      if (at > now) out.push({ id: idOf(t.id + ':due'), at, title: t.title, body: t.allDay ? `Due today. Finish it and it blooms.` : lead ? `Due ${when}.` : 'Due now. Finish it and it blooms.' });
      const nudge = morningOf(addDays(t.due, 1));
      if (nudge > now) out.push({ id: idOf(t.id + ':late'), at: nudge, title: `Overdue: ${t.title}`, body: 'Weeds have started growing out of its pod in your glass.' });
    }
    out.sort((a, b) => a.at - b.at);
    return out.slice(0, MAX);
  }

  // the web only arms the next day of timers, so re-plan now and then
  refresh(tasks) { if (!this.LN && this.app.settings.reminders) { this.sig = ''; this.sync(tasks); } }

  // called whenever tasks change; cheap when nothing that matters did
  sync(tasks) {
    if (!this.app.settings.reminders) { if (this.sig) this.clear(); return; }
    const plan = this.plan(tasks);
    const sig = this.app.settings.remindLead + '|' + plan.map((r) => r.id + '@' + r.at + r.title).join(',');
    if (sig === this.sig) return;
    this.sig = sig;
    if (this.LN) this.schedule(plan);
    else this.arm(plan);
  }

  async schedule(plan) {
    const LN = this.LN;
    try {
      const pending = await LN.getPending();
      if (pending.notifications?.length) await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
      if (!plan.length) return;
      await LN.schedule({
        notifications: plan.map((r) => ({
          id: r.id, title: r.title, body: r.body,
          schedule: { at: new Date(r.at), allowWhileIdle: true },
        })),
      });
    } catch (e) { console.warn('could not schedule reminders', e); }
  }

  // the web: timers for what falls due while the page is alive
  arm(plan) {
    for (const h of this.timers) clearTimeout(h);
    this.timers = [];
    const now = Date.now();
    for (const r of plan) {
      const ms = r.at - now;
      if (ms > 24 * 3600000) break; // re-armed on the next sync anyway
      this.timers.push(setTimeout(() => this.show(r), Math.max(0, ms)));
    }
    this.lastPlan = plan;
  }

  // the web, on opening: anything that came due while Glasswild was shut
  catchUp(tasks, since) {
    if (this.LN || !this.app.settings.reminders || !since) return;
    const missed = this.plan(tasks, since).filter((r) => r.at <= Date.now() && Date.now() - r.at < DAY);
    for (const r of missed.slice(-3)) this.show(r);
  }

  async show(r) {
    if (this.shown.has(r.id + '@' + r.at)) return;
    this.shown.add(r.id + '@' + r.at);
    try { localStorage.setItem(SHOWN_KEY, JSON.stringify([...this.shown].slice(-200))); } catch {}
    try {
      if (Notification.permission !== 'granted') return;
      const opts = { body: r.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: String(r.id), data: { url: location.href } };
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) await reg.showNotification(r.title, opts);
      else new Notification(r.title, opts);
    } catch (e) { console.warn('could not show a reminder', e); }
  }

  async clear() {
    this.sig = '';
    for (const h of this.timers) clearTimeout(h);
    this.timers = [];
    if (this.LN) {
      try {
        const pending = await this.LN.getPending();
        if (pending.notifications?.length) await this.LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
      } catch {}
    }
  }
}
