const SESS = new Map(); // psid -> state

const newSession = () => ({
  createdAt: Date.now(),
  updatedAt: Date.now(),
  // 7-day memory window handled naively here (we'll hard reset beyond)
  slots: { plan:null, budget:null, location:null, transmission:null, body_type:null,
           brand_pref:null, model_pref:null, year_pref:null, variant_pref:null },
  lastAsked: null,          // which slot we last asked
  lastPromptAt: 0,          // debounce
  lastUserAt: 0,            // for idle follow-up timers
  nudgeCount: 0,            // Phase 1 nudges sent
  phase: 'p1',              // p1/p2/p3_cash/p3_fin
  isReturning: false
});

export function getSession(psid) {
  let s = SESS.get(psid);
  const now = Date.now();
  if (!s) {
    s = newSession();
    SESS.set(psid, s);
  } else {
    // reset if > 7 days
    if (now - s.updatedAt > 7*24*60*60*1000) {
      s = newSession(); SESS.set(psid, s);
    }
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

export function markUserActivity(psid) {
  const s = getSession(psid);
  s.lastUserAt = Date.now();
  saveSession(psid, s);
}

/** simple debounce: avoid re-asking same slot within 1.5s */
export function shouldDebounce(psid, slot) {
  const s = getSession(psid);
  const now = Date.now();
  if (s.lastAsked === slot && (now - s.lastPromptAt) < 1500) return true;
  s.lastAsked = slot;
  s.lastPromptAt = now;
  saveSession(psid, s);
  return false;
}

