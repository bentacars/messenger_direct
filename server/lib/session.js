// server/lib/session.js
// KV-backed session with idle tracking + indexing for nudges

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 14);

async function kv(cmd, ...args) {
  const res = await fetch(`${KV_URL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ // Upstash REST "pipeline" format
      pipeline: [[cmd, ...args]]
    }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out?.error || `KV ${cmd} failed`);
  return out?.results?.[0];
}

const key = (pid) => `sess:${pid}`;

export async function getSession(pid) {
  const r = await kv("GET", key(pid));
  if (!r || !r.result) return null;
  return JSON.parse(r.result);
}

export async function saveSession(pid, patch = {}) {
  const k = key(pid);
  const now = Date.now();
  const cur = (await getSession(pid)) || {};
  const session = {
    ...cur,
    ...patch,
    pid,
    lastInteractionAt: patch.lastInteractionAt ?? now,
    updatedAt: now,
  };
  const ttlSec = TTL_DAYS * 24 * 60 * 60;
  await kv("SET", k, JSON.stringify(session), "EX", ttlSec);
  // index for the nudge cron
  await kv("SADD", "sess:index", pid);
  return session;
}

export async function clearSession(pid) {
  await kv("DEL", key(pid));
  await kv("SREM", "sess:index", pid);
}

export async function listAllSessionPids() {
  const r = await kv("SMEMBERS", "sess:index");
  return r?.result ?? [];
}
