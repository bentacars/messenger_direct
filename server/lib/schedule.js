// Text-only scheduling helpers for PH time.
// Rule: avoid same-day offer if now is between 15:00–06:00 (Asia/Manila).

const PH_TZ = 'Asia/Manila';

function nowPH() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: PH_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const hh = Number(parts.hour), mm = Number(parts.minute);
  return { y, m, d, hh, mm };
}

export function sameDayAllowed() {
  const { hh } = nowPH();
  // Disallow same-day if current time is 15:00–23:59 OR 00:00–06:00
  if (hh >= 15) return false;
  if (hh < 6) return false;
  return true;
}

export function summarizeProposed(dateText) {
  // We keep it simple: echo the user text as confirmation.
  // (You can replace with a real NLP date parser later.)
  return `Noted. I’ll pencil you in: ${dateText}.`;
}

export function needsSchedule(session) {
  return !session.schedule?.when;
}

export function ensureScheduleStore(session) {
  if (!session.schedule) session.schedule = { when: null, confirmed: false };
}

export function captureScheduleFromText(session, userText) {
  // Minimal parser: accept anything non-empty as requested time slot.
  const txt = String(userText || '').trim();
  if (!txt) return false;
  ensureScheduleStore(session);
  session.schedule.when = txt;
  session.schedule.confirmed = true;
  return true;
}
