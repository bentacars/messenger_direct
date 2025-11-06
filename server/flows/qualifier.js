// server/flows/qualifier.js
// Phase 1: LLM-only extraction + minimal helpers

import { askLLM } from "../lib/ai.js";

// Fields we consider "required" to complete Phase 1
export const REQUIRED_FIELDS = ["payment", "budget", "location", "transmission", "bodyType"];

// Return array of missing field keys
export function missingFields(q = {}) {
  return REQUIRED_FIELDS.filter((k) => !q[k] || String(q[k]).trim() === "");
}

// Single friendly question for the NEXT missing field (Taglish, short)
export async function askForMissingConversational(missing = [], userText = "") {
  const prompt = `
You are a friendly Taglish car sales AI for BentaCars.
The user said: "${userText}".

Only ask ONE short, human question for the NEXT missing qualifier from this list (in order):
payment, budget, bodyType, transmission, location.

Format: casual Taglish, no checklist, no bullets, 1 sentence only.
`;
  return (await askLLM(prompt)) || "Sige, quick one lang — cash or financing ang plan natin?";
}

// LLM extractor: infer whatever the user actually mentioned; never guess.
export async function extractQualifiers(userText = "", prev = {}) {
  const sys = `Extract only what the user explicitly said. Return STRICT JSON, no prose. Do NOT invent.`;
  const prompt = `
User text: "${userText}"

Return a JSON object with any of the following keys ONLY when mentioned:
- payment: "cash" | "financing"
- budget: number (digits only, PHP, no commas), represents cash price or target budget / cash-out if implied
- location: city or province if stated (short string)
- transmission: "automatic" | "manual" | "any"
- bodyType: one of [sedan, suv, mpv, van, pickup, crossover, hatchback, auv] if stated
- brand, model, variant, year: optional preferences if explicitly stated

Example output when user says: "cash buyer, 550k budget, sedan automatic, QC":
{"payment":"cash","budget":"550000","bodyType":"sedan","transmission":"automatic","location":"QC"}
`;
  try {
    const raw = await askLLM(`${sys}\n${prompt}`);
    // Be defensive: try to find the first {...} JSON substring
    const match = raw && raw.match(/\{[\s\S]*\}/);
    const json = match ? JSON.parse(match[0]) : {};
    return { ...prev, ...json };
  } catch {
    return { ...prev };
  }
}
