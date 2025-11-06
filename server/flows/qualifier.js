// server/flows/qualifier.js
// Phase 1: Qualifier extraction + missing-check
// Hybrid: regex + deterministic parsing + LLM fallback (for phrasing only)

import { askLLM } from "../lib/ai.js";

/* -----------------------------------------------------------
 * Canonical field order and keys
 * ----------------------------------------------------------- */
const FIELD_KEYS = ["payment", "budget", "transmission", "bodyType", "location"];
const STRONG_PREFS = ["brand", "model", "variant", "year"];

/* -----------------------------------------------------------
 * Regexes & helpers
 * ----------------------------------------------------------- */
const R_CASH =
  /\b(cash(?:\s?basis)?|spot\s?cash|full\s?cash|full\s?payment|straight|one[- ]?time)\b/i;

const R_FIN =
  /\b(financ(?:e|ing)|installment|hulog|loan|terms?|monthly|all[- ]?in|bank\s?loan|in[- ]?house)\b/i;

const R_TRANS = /\b(auto(?:matic)?|a\/?t|manual|m\/?t)\b/i;

const BODY_ALIASES = {
  sedan: ["sedan"],
  suv: ["suv"],
  mpv: ["mpv", "multi[- ]?purpose"],
  van: ["van"],
  pickup: ["pickup", "pick[- ]?up", "truck"],
  crossover: ["crossover"],
  hatchback: ["hatch", "hatchback"],
  auv: ["auv"],
};

const BODY_REGEX = new RegExp(
  "\\b(" +
    Object.values(BODY_ALIASES)
      .flat()
      .join("|") +
    ")\\b",
  "i"
);

// budget: 650,000 | 650k | 0.65m | ₱650k
const R_BUDGET_RAW = /(?:₱|\b)\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:\.\d+)?)(\s*[km])?\b/i;

function parseBudget(msg) {
  const m = msg.match(R_BUDGET_RAW);
  if (!m) return undefined;
  let num = m[1].replace(/[^\d.]/g, "");
  let val = Number(num);
  if (!isFinite(val)) return undefined;
  const suffix = (m[2] || "").trim().toLowerCase();
  if (suffix === "k") val = val * 1_000;
  if (suffix === "m") val = val * 1_000_000;
  // If they wrote 550 with no suffix, but context commonly means "550k", try to infer
  if (val < 5_000) val = val * 1_000;
  return String(Math.round(val));
}

function normalizeBody(raw = "") {
  const s = raw.toLowerCase();
  for (const [canon, variants] of Object.entries(BODY_ALIASES)) {
    if (variants.some((v) => new RegExp(`\\b${v}\\b`, "i").test(s))) return canon;
  }
  return undefined;
}

/* -----------------------------------------------------------
 * Extraction
 * ----------------------------------------------------------- */
export function extractQualifiers(text = "", prev = {}) {
  const q = { ...prev };
  const msg = text.toLowerCase();

  // payment
  if (!q.payment) {
    if (R_CASH.test(msg)) q.payment = "cash";
    else if (R_FIN.test(msg)) q.payment = "financing";
  }

  // budget (cash price or cash-out)
  if (!q.budget) {
    const parsed = parseBudget(msg);
    if (parsed) q.budget = parsed;
  }

  // transmission
  if (!q.transmission) {
    const m = msg.match(R_TRANS);
    if (m) {
      const s = m[0].toLowerCase();
      q.transmission = /auto|a\/?t/.test(s) ? "automatic" : "manual";
    }
  }

  // body type
  if (!q.bodyType) {
    const m = msg.match(BODY_REGEX);
    if (m) q.bodyType = normalizeBody(m[0]);
  }

  // quick location heuristic (kept simple; router/interrupts can refine later)
  if (
    !q.location &&
    /\b(qc|quezon|manila|makati|pasig|taguig|cavite|laguna|bulacan|cebu|davao|pampanga|pateros|marikina|antipolo|parañaque|paranaque|muntinlupa|las\s*piñas|las\s*piñas|valenzuela|caloocan|malabon|navotas|pasay)\b/i.test(
      msg
    )
  ) {
    // Use the original text so proper case is preserved for city names in one-liners
    q.location = text;
  }

  // soft preferences (brand/model/variant/year) — non-blocking
  STRONG_PREFS.forEach((k) => {
    if (q[k]) return;
    // e.g., "brand: Toyota", "model vios", "variant XE", "year 2019"
    const re = new RegExp(`\\b${k}\\s*[:=]?\\s*([\\w\\-\\.]+)`, "i");
    const m = text.match(re);
    if (m) q[k] = m[1];
  });

  return q;
}

/* -----------------------------------------------------------
 * Missing fields in priority order
 * ----------------------------------------------------------- */
export function missingFields(q = {}) {
  return FIELD_KEYS.filter((k) => !q[k] || q[k] === "");
}

/* -----------------------------------------------------------
 * Ask for the NEXT missing field (one line, human, no checklist tone)
 * We still use LLM for tone, but we deterministically pick WHICH to ask next,
 * so it won’t keep repeating “cash or financing” once captured.
 * ----------------------------------------------------------- */
export async function askForMissingConversational(missing = [], userText = "") {
  if (!missing || missing.length === 0) return "";

  // deterministic next target (first in our FIELD_KEYS order that is still missing)
  const nextKey = FIELD_KEYS.find((k) => missing.includes(k)) || missing[0];

  // Minimal, specific instructions so the LLM returns exactly one question
  const system = `
You are a friendly Taglish car sales AI for BentaCars.
Ask ONLY ONE short question to capture the requested field.
No lists. No multiple questions. No recap. No emojis.
Return only the question sentence.
  `.trim();

  const prompts = {
    payment:
      "Tanongin mo lang kung cash or financing ang plan nila. Huwag magpaliwanag.",
    budget:
      "Tanongin mo lang ang budget (cash price or cash-out), isang tanong lang.",
    transmission:
      "Tanongin mo lang kung automatic or manual ang hanap nila.",
    bodyType:
      "Tanongin mo lang kung anong body type ang gusto (sedan, suv, hatchback, etc.).",
    location:
      "Tanongin mo lang kung anong city/province ang preferred viewing location nila.",
  };

  // If LLM call fails, we have safe fallbacks:
  const fallback = {
    payment: "Sige, quick one lang — cash or financing ang plan mo?",
    budget: "Magkano po ang target budget natin (cash price o cash-out)?",
    transmission: "Automatic o manual ang hanap mo?",
    bodyType: "Anong body type ang gusto mo — sedan, SUV, hatchback, etc.?",
    location: "Saan po kayo located o saan niyo gustong mag-view?",
  };

  try {
    const out = await askLLM(
      `${system}\n\nField to ask: ${nextKey}\nUser said: "${userText}"\nInstruction: ${prompts[nextKey]}`
    );
    const text = (out || "").trim();
    if (!text) return fallback[nextKey];
    // ensure it ends with a question mark
    return /[?？]$/.test(text) ? text : `${text}?`;
  } catch {
    return fallback[nextKey];
  }
}

/* -----------------------------------------------------------
 * Optional full LLM extraction (kept for compatibility)
 * ----------------------------------------------------------- */
export async function llmExtract(text = "", prev = {}) {
  const prompt = `
Extract ONLY the fields explicitly mentioned in the user's message.
Input: "${text}"

Return strict JSON with keys if present:
  payment: "cash" | "financing"
  budget: string digits only (e.g. "550000")
  location: short city/province text if clearly stated
  transmission: "automatic" | "manual" | "any"
  bodyType: one of "sedan","suv","mpv","van","pickup","crossover","hatchback","auv"
  brand, model, variant, year (optional)

Do not guess. Omit keys not present. No extra text.
  `.trim();

  try {
    const raw = await askLLM(prompt, { json: true });
    return { ...prev, ...raw };
  } catch {
    return prev;
  }
}
