// server/lib/state.js
// Stores per-user "flow" state (qualifiers, phase, matches, etc.)
// Uses Vercel KV for storage

import fetch from "node-fetch";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

if (!KV_URL || !KV_TOKEN) {
  console.warn("[state] Missing KV_REST_API_URL or KV_REST_API_TOKEN");
}

function sk(psid) {
  return `state:${psid}`;
}

// Helper to call KV API
async function kvFetch(method, key, body) {
  const url = `${KV_URL}/v1/kv/${key}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error(`[state] KV error ${method} ${key}`, r.status, t);
  }
  return r;
}

// GET full state
export async function getState(psid) {
  const r = await kvFetch("GET", sk(psid));
  if (!r || !r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

// PATCH + merge fields into state
export async function setState(psid, patch = {}) {
  const old = (await getState(psid)) || {};
  const merged = { ...old, ...patch, updated_at: Date.now() };
  await kvFetch("PUT", sk(psid), merged);
  return merged;
}

// Reset full state (used for Start over)
export async function resetState(psid) {
  await kvFetch("DELETE", sk(psid));
}

// OPTIONAL: force timestamp refresh without merging (used by idle nudges)
export async function touchState(psid) {
  const st = (await getState(psid)) || {};
  st.updated_at = Date.now();
  await setState(psid, st);
  return st;
}
