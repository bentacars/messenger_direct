// api/lib/llm.js
// Lightweight helpers to keep tone human and short, with tiny in-memory memory.

const MEMORY = new Map(); // psid -> { lastSeen: number }

export function remember(psid) {
  MEMORY.set(psid, { lastSeen: Date.now() });
}

export function recall(psid) {
  return MEMORY.get(psid);
}

export async function forgetIfRestart(msg, psid, session) {
  if (!/^(restart|start over|reset)$/i.test(msg)) return false;
  session.prefs = {
    plan: null, city: null, body: null, trans: null,
    budgetMin: null, budgetMax: null, dpMin: null, dpMax: null,
    model: null, year: null
  };
  return true;
}

export function adaptTone(text, userMsg) {
  // very light adaptation; remove extra formality if user is casual
  if (/\b(pare|bro|tol|hehe|lol)\b/i.test(userMsg)) {
    return text.replace(/\bpo\b/gi, '');
  }
  return text;
}

export function smartShort(text) {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const take = parts.slice(0, 2).join(' ');
  return take.length ? take : text;
}

export function extractClues(msg, session) {
  // model guess
  const mdl = msg.match(/\b(vios|mirage|city|altis|civic|fortuner|everest|montero|terra|nv350|urvan|hiace|starex|innova|raize|livina|traviz|ranger|hilux|strada|navara)\b/i);
  if (mdl) session.prefs.model = mdl[1].toLowerCase();

  // year guess (2014..2026)
  const yr = msg.match(/\b(20(1[4-9]|2[0-6]))\b/);
  if (yr) session.prefs.year = Number(yr[1]);
}
