// server/lib/session.js
// Uses Upstash KV if provided; otherwise in-memory (best-effort)
const TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);
const TTL_SEC = TTL_DAYS * 24 * 60 * 60;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const mem = new Map();

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return mem.get(key);
  const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, val) {
  if (!KV_URL || !KV_TOKEN) return mem.set(key, val);
  await fetch(`${KV_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(val), ex: TTL_SEC })
  });
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return mem.delete(key);
  await fetch(`${KV_URL}/del/${key}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` } });
}

export async function getSession(psid) {
  const s = (await kvGet(`sess:${psid}`)) || {};
  return s;
}

export async function saveSession(psid, state) {
  state._updated_at = Date.now();
  await kvSet(`sess:${psid}`, state);
}

export async function clearSession(psid) {
  await kvDel(`sess:${psid}`);
}
