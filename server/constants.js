// server/constants.js
export const PH_TZ = 'Asia/Manila';
export const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);

// Matching rules (silent)
export const MATCH_DELTA_CASH = 50_000;     // ±50k around SRP for cash
export const MATCH_DELTA_ALLIN = 50_000;    // +50k headroom for all-in

// Offers paging
export const MAX_OFFERS = 4;   // total units to keep per query (2 + 2)
export const FIRST_BATCH = 2;  // show first 2, then "Others" for the next 2

// Idle nudges (Phase 1 + Phase 3 cash)
export const NUDGE_INTERVAL_MIN = 15;
export const NUDGE_MAX_ATTEMPTS = 8;
export const QUIET_START_HOUR = 21; // 9 PM
export const QUIET_END_HOUR = 9;    // 9 AM

// Financing docs follow-up
export const DOCS_FOLLOW_INTERVAL_HOURS = 2;
export const DOCS_FOLLOW_MAX_HOURS = 72; // ≈ 3 days

// Models (you can override via env)
export const MODEL_DEFAULT = process.env.MODEL_DEFAULT || 'gpt-4.1-mini';
export const NLG_MODEL = process.env.NLG_MODEL || 'gpt-4o-mini';

// Titles / payload helpers
export const PAYLOADS = {
  CONTINUE: 'continue',
  START_OVER: 'start over',
  SHOW_OTHERS: 'SHOW_OTHERS',
};
