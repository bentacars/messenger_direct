/**
 * llm.js — helper utils for model/temperature picking, tone presets,
 * name detection, and prompt builders (qualifier + matching).
 *
 * All functions are pure; webhook owns the actual OpenAI calls.
 */

/* ------------------------- Model / Temperature ------------------------- */

export function pickModel(override) {
  const envVal = process.env.MODEL_DEFAULT || process.env.OPENAI_MODEL;
  const model = (override && String(override).trim()) || envVal || 'gpt-4.1';
  return model;
}

export function pickTemp(override) {
  const envVal = process.env.TEMP_DEFAULT;
  const raw = override ?? (envVal != null ? Number(envVal) : 0.30);
  const n = Number.isFinite(raw) ? raw : 0.30;
  // clamp to [0,1]
  return Math.max(0, Math.min(1, n));
}

/* ------------------------------ Tone Layer ----------------------------- */
/**
 * Tone keys:
 *  - 'A' Friendly Pro
 *  - 'B' Neutral Consultant
 *  - 'C' Sales Energized
 *  - 'D' Warm, human Taglish (rapport-first)  ← your default
 */
export function humanizeOpt(tone = 'D', returningUserMemory = true) {
  const base = {
    // shared knobs
    taglish: true,
    emojis: 'light',             // none | light | medium
    verbosity: 'short',          // short | balanced
    rapportFirst: true,
    avoidButtons: true,          // no quick replies (human vibe)
    returningUserMemory: !!returningUserMemory,
  };

  const map = {
    A: { ...base, emojis: 'light', verbosity: 'balanced', rapportFirst: true },
    B: { ...base, emojis: 'none',  verbosity: 'balanced', rapportFirst: false },
    C: { ...base, emojis: 'medium',verbosity: 'short',    rapportFirst: false },
    D: { ...base, emojis: 'light', verbosity: 'short',    rapportFirst: true },
  };

  return map[tone] || map.D;
}

/* ---------------------------- Name Detection --------------------------- */
/**
 * Tries to grab the user's first name from a typical Messenger event payload.
 * Safe to call even if fields are missing.
 */
export function detectName(event) {
  try {
    // Common places where profile details may appear depending on your middleware
    const profile =
      event?.sender?.profile ||
      event?.message?.nlp?.entities?.profile?.[0] ||
      event?.context?.user_profile ||
      null;

    const full = profile?.name || profile?.first_name || null;
    if (!full) return null;

    const first = String(full).trim().split(/\s+/)[0];
    return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : null;
  } catch {
    return null;
  }
}

/* ------------------------------ Prompts -------------------------------- */

export function buildQualifierSystemPrompt(opts = {}) {
  const o = humanizeOpt(opts.tone || 'D', opts.returningUserMemory !== false);

  const rapport = o.rapportFirst
    ? "Warm, natural, consultant vibe. Build konting rapport bago magtanong."
    : "Professional and concise.";

  const emoji = o.emojis === 'light' ? " Use light, situational emojis only." : "";
  const taglish = o.taglish
    ? " Speak in Taglish. Keep it casual pero malinaw."
    : " Speak in English, concise and clear.";

  const memory = o.returningUserMemory
    ? " If user is returning (you see prior state), greet briefly and continue from last missing detail—unless they type 'restart'."
    : " Do not reference prior chats.";

  const noButtons = o.avoidButtons
    ? " Do NOT send quick-reply buttons; phrase like a human instead."
    : " You may offer quick-reply style suggestions.";

  // Qualifier sequence (C order the user requested)
  const seq = [
    "1) Cash or Financing plan?",
    "2) Location (city/province)?",
    "3) Body type (sedan/suv/mpv/van/pickup or 'any') — if they gave a specific model or year, treat body type as satisfied.",
    "4) Transmission (automatic/manual/'any').",
    "5) Budget LAST: If cash → ask for range (e.g., ₱450k–₱600k). If financing → ask for ready cash-out / all-in range (e.g., 150k–220k)."
  ].join(" ");

  return [
    "You are BentaCars’ AI sales consultant.",
    rapport + emoji + taglish,
    memory,
    noButtons,
    "Goal: qualify smoothly then match the BEST 2 units (prioritize price_status='Priority' if available, else top matches).",
    "If model/year is explicitly stated, accept it and infer body type automatically.",
    "Keep answers short, friendly, and with tiny connective phrases to feel human.",
    "",
    "Ask strictly in this sequence (auto-skip if already answered; never re-ask the same field):",
    seq,
    "",
    "After all details are complete, say 'GOT IT! ✅ I now have everything I need. I can now search available units for you.' then hand off to matching."
  ].join("\n");
}

export function buildMatchingSystemPrompt(opts = {}) {
  const o = humanizeOpt(opts.tone || 'D', opts.returningUserMemory !== false);
  const emoji = o.emojis === 'light' ? "🙂" : "";
  return [
    "You are now matching qualified buyer details to inventory results provided by another service.",
    "Rules:",
    "• Offer exactly 2 units first. If any with price_status='Priority', show them first.",
    "• Send only photo #1 per unit with a short, human caption:",
    "  '🚗 {year} {brand_model} {variant}\\nAll-in: ₱{all_in}\\n{city} — {mileage} km'",
    "• Then ask: 'Alin ang gusto mong tingnan?' (Don’t show extra options unless they ask.)",
    "• If the user picks a unit, then send the rest of its photos (2–10 if present) on request ('more photos'), and proceed to viewing schedule.",
    "• If there are no Priority matches, do not say 'no match'; offer best non-priority matches instead.",
    `• Stay Taglish, warm, and concise ${emoji}`,
  ].join("\n");
}

/* --------------------------- Small Utilities ---------------------------- */

export function isRestart(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  return t === 'restart' || t === '/restart' || t === 'start over';
}

export function isGreeting(text) {
  if (!text) return false;
  const t = String(text).trim().toLowerCase();
  return ['hi','hello','helo','hey','yo','gday','good am','good pm','good morning','good evening'].some(
    k => t.includes(k)
  );
}

export function welcomeLine({ name, returning }) {
  const first = name ? `Hi ${name}!` : "Hi!";
  if (returning) {
    return `${first} Welcome back to BentaCars 👋 Ready ka na ba? If you want to start fresh, type 'restart'.`;
  }
  return `${first} Welcome to BentaCars 👋 Tutulungan kitang ma-match sa best unit (no endless scrolling).`;
}

/* ----------------------------- Export bag ------------------------------- */

export default {
  pickModel,
  pickTemp,
  humanizeOpt,
  detectName,
  buildQualifierSystemPrompt,
  buildMatchingSystemPrompt,
  isRestart,
  isGreeting,
  welcomeLine,
};
