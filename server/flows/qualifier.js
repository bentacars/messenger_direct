// server/flows/qualifier.js
// Phase 1: Qualifier extraction + missing-check
// Hybrid: regex + LLM extractor

import { askLLM } from "../lib/ai.js";

const FIELD_KEYS = ["payment", "budget", "location", "transmission", "bodyType"];
const STRONG_PREFS = ["brand", "model", "variant", "year"];

// Regex fallback helpers
const R_CASH = /\b(cash|spot\s?cash|full\s?payment)\b/i;
const R_FIN = /\b(finance|hulog|installment|all[- ]?in|loan)\b/i;
const R_BUDGET = /\b(\d[\d,\.]{3,})\b/;
const R_TRANS = /\b(auto|a\/?t|automatic|manual|m\/?t)\b/i;
const R_BODY = /\b(sedan|suv|mpv|van|pickup|crossover|hatch|hatchback|auv)\b/i;

export function extractQualifiers(text = "", prev = {}) {
  const q = { ...prev };
  const msg = text.toLowerCase();

  // Payment
  if (!q.payment) {
    if (R_CASH.test(msg)) q.payment = "cash";
    else if (R_FIN.test(msg)) q.payment = "financing";
  }

  // Budget (cash or cash-out)
  if (!q.budget) {
    const m = msg.match(R_BUDGET);
    if (m) q.budget = m[1].replace(/[^\d]/g, "");
  }

  // Transmission
  if (!q.transmission) {
    const m = msg.match(R_TRANS);
    if (m) {
      const s = m[0];
      q.transmission = /auto|a\/?t|automatic/.test(s) ? "automatic" : "manual";
    }
  }

  // Body type
  if (!q.bodyType) {
    const m = msg.match(R_BODY);
    if (m) q.bodyType = m[0].toLowerCase();
  }

  // Location: simple heuristic (PH cities/provinces often end without commas)
  if (!q.location && /\bQC\b|\bquezon\b|\bmanila\b|\bcavite\b|\bcebu\b|\bdavao\b|\bpasig\b|\bmakati\b/i.test(msg)) {
    q.location = text; // better: strip via GPT if needed
  }

  // Strong wants (non-blocking)
  STRONG_PREFS.forEach((k) => {
    if (q[k]) return;
    const re = new RegExp(`\\b(${k})[:=]?\\s?(\\w+)`, "i");
    const m = text.match(re);
    if (m) q[k] = m[2];
  });

  return q;
}

export function missingFields(q = {}) {
  return FIELD_KEYS.filter((k) => !q[k] || q[k] === "");
}

/**
 * LLM-style conversational prompt to ask for missing fields.
 * Called from router if Regex-only parsing can't detect qualifiers
 */
export async function askForMissingConversational(missing = [], userText = "") {
  const prompt = `
  You're a friendly Taglish car sales AI for BentaCars.
  The user said: "${userText}"
  You need ONLY to ask them for the NEXT missing qualifier: ${missing.join(", ")}.
  Keep it casual, short, human. Avoid checklist tone.
  `;
  const out = await askLLM(prompt);
  return out || "Sige, quick one: cash or financing ang plan natin?";
}

/**
 * Full LLM extraction (optional) — called when regex pass is unclear.
 */
export async function llmExtract(text = "", prev = {}) {
  const prompt = `
  Extract details from: "${text}"
  Return JSON with keys:
    payment ("cash" or "financing" if mentioned)
    budget (just the number, no commas)
    location (city/province only if stated)
    transmission ("automatic" | "manual" | "any")
    bodyType (sedan, suv, hatchback, etc.)
    brand, model, variant, year (optional preference)
  Only fill what user mentioned. Don't guess.
  Example:
  Input: "Cash, 550k budget, QC, sedan, auto"
  Output:
  {"payment":"cash","budget":"550000","location":"QC","transmission":"automatic","bodyType":"sedan"}
  `;
  try {
    const raw = await askLLM(prompt, { json: true });
    return { ...prev, ...raw };
  } catch {
    return prev;
  }
}
