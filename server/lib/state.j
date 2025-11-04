// api/lib/state.js
const SESS = new Map(); // psid -> state

const newSession = () => ({
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastUserAt: 0,

  phase: 'p1',

  slots: {
    plan: null, budget: null, location: null, transmission: null, body_type: null,
    brand_pref: null, model_pref: null, year_pref: null, variant_pref: null
  },

  lastAsked: null,
  lastPromptAt: 0,

  isWelcomed: false,
  isReturning: false,

  // picks/chosen set in Offers
  picks: null,
  chosen: null,

  // Phase 3
  schedule: null,
  contact: null,
  fin: null,
  docs: null,
  _docsAsked: false,
  _addrShown: false,
  _finLinesShown: false,

  // Nudges state
  nudges: {
    p1: { lastAt: 0, count: 0 },
    docs: { lastAt: 0, count: 0 }
  }
});

export function getSession(psid) {
  let s = SESS.get(psid);
  const now = Date.now();
  if (!s) {
    s = newSession(); SESS.set(psid, s);
  } else if (now - s.updatedAt > 7*24*60*60*1000) {
    s = newSession(); SESS.set(psid, s); // 7-day reset
  }
  return s;
}
export function saveSession(psid, s) {
  s.updatedAt = Date.now();
  SESS.set(psid, s);
}
export function resetSession(psid) {
  SESS.set(psid, newSession());
}

// Activity
export function markUserActivity(psid) {
  const s = getSession(psid);
  s.lastUserAt = Date.now();
  saveSession(psid, s);
}

// Debounce same-slot prompts
export function shouldDebounce(psid, slot) {
  const s = getSession(psid);
  const now = Date.now();
  if (s.lastAsked === slot && (now - s.lastPromptAt) < 1500) return true;
  s.lastAsked = slot;
  s.lastPromptAt = now;
  saveSession(psid, s);
  return false;
}

// For cron nudger
export function getAllSessions() {
  const arr = [];
  for (const [psid, session] of SESS.entries()) {
    arr.push({ psid, session });
  }
  return arr;
}
