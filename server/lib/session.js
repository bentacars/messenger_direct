// server/lib/session.js
const SESSIONS = new Map();
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function now() { return Date.now(); }

export function getSession(id) {
  let s = SESSIONS.get(id);
  if (!s || (s.expiresAt && s.expiresAt < now())) {
    s = { id, createdAt: now(), expiresAt: now() + TTL_MS, funnel: {}, qualifier: {}, offers: {}, status: 'active' };
    SESSIONS.set(id, s);
  }
  return s;
}

export function saveSession(id, patch = {}) {
  const cur = getSession(id);
  const next = { ...cur, ...patch, expiresAt: now() + TTL_MS };
  SESSIONS.set(id, next);
  return next;
}

export function clearSession(id) {
  const s = getSession(id);
  // keep answers but mark paused
  s.status = 'paused';
  s.pausedAt = now();
  s.offeredResumeAt = 0; // so we can show resume card on next message
  SESSIONS.set(id, s);
  return s;
}

export function hardReset(id) {
  SESSIONS.delete(id);
}
