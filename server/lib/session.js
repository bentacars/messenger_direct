// server/lib/session.js
// Upstash Redis REST-backed session with idle/doc follow tracking.

import { MEMORY_TTL_DAYS } from '../constants.js';

const KV_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN || '';

const TTL_SEC = MEMORY_TTL_DAYS * 24 * 60 * 60;

const PIPE_URL = KV_URL
  ? (KV_URL.endsWith('/pipeline') ? KV_URL : KV_URL.replace(/\/+$/, '') + '/pipeline')
  : '';

const mem = new Map();
const now = () => Date.now();

async function kvPipeline(cmd, ...args) {
  if (!PIPE_URL || !KV_TOKEN) return null;
  const res = await fetch(PIPE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([[cmd, ...args]]),
  });
  const txt = await res.text();
  let out = {};
  try { out = JSON.parse(txt); } catch {}
  if (!res.ok) {
    console.error('KV error', res.status, txt);
    throw new Error(out?.error || `KV ${cmd} failed`);
  }
  const first = Array.isArray(out?.result) ? out.result[0] : null;
  if (first?.error) throw new Error(first.error);
  return first;
}

const key = (psid) => `sess:${psid}`;

export async function getSession(psid) {
  if (!PIPE_URL || !KV_TOKEN) return mem.get(psid) || null;
  const r = await kvPipeline('GET', key(psid));
  const str = r?.result;
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

export async function saveSession(psid, patch = {}) {
  const cur = (await getSession(psid)) || {};
  const session = {
    ...cur,
    ...patch,
    psid,
    updatedAt: now(),
    lastInteractionAt: patch.lastInteractionAt ?? cur.lastInteractionAt ?? now(),
    nudgeLevel: patch.nudgeLevel ?? cur.nudgeLevel ?? 0,
    docsFollowStartAt: patch.docsFollowStartAt ?? cur.docsFollowStartAt ?? null,
  };
  if (!PIPE_URL || !KV_TOKEN) { mem.set(psid, session); return session; }
  await kvPipeline('SETEX', key(psid), String(TTL_SEC), JSON.stringify(session));
  await kvPipeline('SADD', 'sess:index', psid);
  return session;
}

export async function clearSession(psid) {
  if (!PIPE_URL || !KV_TOKEN) { mem.delete(psid); return; }
  await kvPipeline('DEL', key(psid));
  await kvPipeline('SREM', 'sess:index', psid);
}

export async function listAllSessionPids() {
  if (!PIPE_URL || !KV_TOKEN) return Array.from(mem.keys());
  const r = await kvPipeline('SMEMBERS', 'sess:index');
  return Array.isArray(r?.result) ? r.result : [];
}
