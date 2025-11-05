// server/lib/state.js
// Simpler, safer KV wrapper (avoids circular and V1 issues)

import fetch from 'node-fetch';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

if (!KV_URL || !KV_TOKEN) {
  throw new Error('KV env vars missing');
}

const headers = {
  Authorization: `Bearer ${KV_TOKEN}`,
  'Content-Type': 'application/json',
};

function sk(psid) {
  return `state:${psid}`;
}

// -------------- GET --------------
export async function getState(psid) {
  const key = sk(psid);
  const r = await fetch(`${KV_URL}/get/${key}`, { headers });
  if (!r.ok) return null;
  const t = await r.text();
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

// -------------- SET / MERGE --------------
export async function setState(psid, patch) {
  const old = (await getState(psid)) || {};
  const safe = JSON.parse(JSON.stringify(patch)); // avoid circular refs
  const merged = { ...old, ...safe, updated_at: Date.now() };

  await fetch(`${KV_URL}/set/${sk(psid)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(merged),
  });
  return merged;
}

// -------------- RESET --------------
export async function resetState(psid) {
  await fetch(`${KV_URL}/del/${sk(psid)}`, {
    method: 'POST',
    headers,
  });
}
