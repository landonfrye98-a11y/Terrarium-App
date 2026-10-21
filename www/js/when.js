// Due dates in plain words. A phrase at the END of a task is read as its
// due date and taken off the title, so "collect trash sunday" is due Sunday
// and "Sunday school prep" stays as it is.
//   today · tonight · tomorrow · sun / sunday / next sunday · this weekend
//   next week · in 3 days · in 2 hours · oct 24 · 24 oct · 10/24
//   … plus an optional time: 3pm · 3:30pm · at 15:00 · at 9 · noon
// Steps ride along after a colon ("Clean house sun: trash, dishes, vacuum")
// or on the lines after the first when a list is pasted.

export const DAY = 86400000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };
const WEEKDAY = /^(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(day|sday|nesday|rsday|urday)?$/;

export const endOfDay = (t) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };
export const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
// calendar days, safe across daylight-saving changes
export const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const atTime = (day, h, m) => { const d = new Date(day); d.setHours(h, m, 0, 0); return d.getTime(); };

// trailing time: returns { h, m, rest } or null
function takeTime(s) {
  let m = /\s+(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm)|\s+(a|p))$/i.exec(s);
  if (m) m[3] = m[3] || m[4];
  if (m) {
    let h = +m[1] % 12;
    if (m[3][0].toLowerCase() === 'p') h += 12;
    if (+m[1] > 12 || +(m[2] || 0) > 59) return null;
    return { h, m: +(m[2] || 0), rest: s.slice(0, m.index), bare: false };
  }
  m = /\s+(?:at\s+|@\s*)(\d{1,2})(?::(\d{2}))?$/i.exec(s);
  if (!m) {
    // a bare 10:30, but not a reference like "John 3:16"
    m = /(\S*)\s+(\d{1,2}):(\d{2})$/.exec(s);
    if (m && /^[A-Z]/.test(m[1])) m = null;
    if (m) m = Object.assign([m[0], m[2], m[3]], { index: m.index + m[1].length });
  }
  if (m) {
    let h = +m[1];
    const mm = +(m[2] || 0);
    if (h > 23 || mm > 59) return null;
    // "at 3" and "3:30" mean the afternoon; "at 9" the morning
    if (h >= 1 && h <= 6) h += 12;
    return { h, m: mm, rest: s.slice(0, m.index), bare: true };
  }
  m = /\s+(?:at\s+)?(noon|midday|midnight)$/i.exec(s);
  if (m) return { h: m[1].toLowerCase() === 'midnight' ? 23 : 12, m: m[1].toLowerCase() === 'midnight' ? 59 : 0, rest: s.slice(0, m.index) };
  return null;
}

// trailing date: returns { day (start of that day), time?, rest } or null
function takeDate(s, now) {
  const today = startOfDay(now);
  const pre = '(?:\\s+(?:by|on|due|for|this|before))?';
  let m = new RegExp(`(?:\\s+(?:by|due|for|before))?\\s+(today|tonight|tomorrow|tmrw|tmr|tomorow)$`, 'i').exec(s);
  if (m) {
    const w = m[1].toLowerCase();
    if (w === 'today') return { day: today, rest: s.slice(0, m.index) };
    if (w === 'tonight') return { day: today, time: { h: 20, m: 0 }, evening: true, rest: s.slice(0, m.index) };
    return { day: addDays(today, 1), rest: s.slice(0, m.index) };
  }
  m = new RegExp(`(\\s+(?:by|on|due|for|this|before))?\\s+(next\\s+)?([a-z]+)$`, 'i').exec(s);
  if (m) m = Object.assign([m[0], m[2], m[3]], { index: m.index, lead: !!(m[1] || m[2]) });
  // (an all-caps word is an acronym: "study for the SAT"; "sun", "sat" and
  // "wed" are ordinary words unless something says they're a day)
  if (m && WEEKDAY.test(m[2].toLowerCase()) && !(m[2].length > 1 && m[2] === m[2].toUpperCase()) && (m.lead || !/^(sun|sat|wed)$/i.test(m[2]))) {
    const want = DAYS.indexOf(m[2].toLowerCase().slice(0, 3));
    const cur = new Date(now).getDay();
    let ahead = (want - cur + 7) % 7;
    if (m[1] && ahead === 0) ahead = 7;
    return { day: addDays(today, ahead), rest: s.slice(0, m.index) };
  }
  m = new RegExp(`${pre}\\s+(?:the\\s+)?weekend$`, 'i').exec(s);
  if (m) { const cur = new Date(now).getDay(); return { day: addDays(today, cur === 0 ? 0 : (6 - cur)), rest: s.slice(0, m.index) }; }
  m = /\s+next\s+week$/i.exec(s);
  if (m) return { day: addDays(today, 7), rest: s.slice(0, m.index) };
  m = /\s+in\s+(\d+|an?|one|two|three|four|five|six|seven|ten)\s+(days?|weeks?|hours?|hrs?|minutes?|mins?)$/i.exec(s);
  if (m) {
    const n = Math.min(NUM[m[1].toLowerCase()] ?? +m[1], 3650);
    const u = m[2].toLowerCase();
    if (u[0] === 'd') return { day: addDays(today, n), rest: s.slice(0, m.index) };
    if (u[0] === 'w') return { day: addDays(today, 7 * n), rest: s.slice(0, m.index) };
    const at = now + n * (u[0] === 'h' ? 3600000 : 60000);
    const d = new Date(at);
    return { day: startOfDay(at), time: { h: d.getHours(), m: d.getMinutes() }, rest: s.slice(0, m.index) };
  }
  m = new RegExp(`${pre}\\s+([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?$`, 'i').exec(s)
    || new RegExp(`${pre}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?([a-z]{3,9})$`, 'i').exec(s);
  if (m) {
    const a = /\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const mo = MONTHS.indexOf(a[0].toLowerCase().slice(0, 3));
    const day = mo >= 0 && MONTH_NAMES[mo].startsWith(a[0].toLowerCase().replace(/^sept$/, 'sep')) && +a[1] >= 1 && +a[1] <= 31 ? dateAhead(now, mo, +a[1]) : null;
    if (day != null) return { day, rest: s.slice(0, m.index) };
  }
  m = new RegExp(`${pre}\\s+(\\d{1,2})/(\\d{1,2})$`).exec(s);
  const md = m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31 ? dateAhead(now, +m[1] - 1, +m[2]) : null;
  if (md != null) return { day: md, rest: s.slice(0, m.index) };
  return null;
}

// the next time this month/day comes around (this year unless already past)
function dateAhead(now, mo, d) {
  const n = new Date(now);
  let y = n.getFullYear();
  if (new Date(y, mo, d).getTime() < startOfDay(now)) y++;
  const t = new Date(y, mo, d);
  return t.getMonth() === mo ? t.getTime() : null; // no Feb 30th
}

// "clean house sunday 3pm" -> { title: 'clean house', due, allDay: false }
export function parseDue(text, now = Date.now()) {
  let s = ' ' + text.trim();
  let day = null, time = null;
  for (let pass = 0; pass < 2; pass++) {
    if (!time) { const t = takeTime(s); if (t && t.rest.trim()) { time = t; s = t.rest; continue; } }
    if (day == null) {
      const d = takeDate(s, now);
      if (d && d.rest.trim() && Number.isFinite(d.day)) {
        day = d.day;
        if (d.time && !time) time = d.time;
        // "tonight at 8" is eight in the evening
        else if (d.evening && time && time.bare !== false && time.h < 12) time = { ...time, h: time.h + 12 };
        s = d.rest; continue;
      }
    }
    break;
  }
  const title = s.trim().replace(/\s+(by|due)$/i, '');
  if (day == null && !time) return { title: text.trim(), due: null, allDay: false };
  if (day == null) {
    // a bare time is today's, or tomorrow's if it has already gone by
    day = startOfDay(now);
    if (atTime(day, time.h, time.m) < now) day = addDays(day, 1);
  }
  return time ? { title, due: atTime(day, time.h, time.m), allDay: false } : { title, due: endOfDay(day), allDay: true };
}

const BULLET = /^\s*(?:[-*•·◦▪]|\d+[.)](?=\s)|\[\s?[xX ]?\s?\])\s*/;

// a whole entry: title, due date and any steps
export function parseEntry(text, now = Date.now()) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(BULLET, '').trim()).filter(Boolean);
  if (!lines.length) return null;
  let head = lines[0];
  let steps = lines.slice(1);
  // "Clean house sun: trash, dishes, vacuum"
  // (the last colon that isn't inside a time like 10:30)
  let c = -1;
  for (const mm of head.matchAll(/:(?!\d)/g)) c = mm.index;
  if (c > 0 && !steps.length) {
    const parts = head.slice(c + 1).split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) { steps = parts; head = head.slice(0, c); }
  }
  const d = parseDue(head, now);
  return { ...d, steps: steps.map((x) => x.slice(0, 120)) };
}

const fmtClock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(/\s/g, '').toLowerCase();

// "today" · "tomorrow 3pm" · "Sun" · "Oct 24" · "2 days overdue"
export function fmtDue(due, allDay, now = Date.now()) {
  if (due == null) return '';
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
  if (due < now) {
    const late = now - due;
    if (late < DAY) return allDay ? 'due yesterday' : late < 3600000 ? 'just overdue' : `overdue ${Math.floor(late / 3600000)}h`;
    const n = Math.floor(late / DAY);
    return `${n} day${n === 1 ? '' : 's'} overdue`;
  }
  const time = allDay ? '' : ' ' + fmtClock(due);
  if (days === 0) return allDay ? 'today' : 'today' + time;
  if (days === 1) return 'tomorrow' + time;
  if (days < 7) return new Date(due).toLocaleDateString(undefined, { weekday: 'short' }) + time;
  return new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + time;
}
