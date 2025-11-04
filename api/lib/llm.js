// api/lib/llm.js (ESM). Clean, syntax-safe, Edge-compatible.

/** -------------------------------
 *  Model/temperature helpers
 *  ------------------------------- */
export function pickModel(envValue, fallback = 'gpt-4.1-mini') {
  const v = (envValue || '').trim();
  if (!v) return fallback;
  // allow things like "gpt-4o-mini" or "o4-mini"
  return v;
}

export function pickTemp(envValue, fallback = 0.2) {
  const n = Number(envValue);
  if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  return fallback;
}

/** -------------------------------
 *  Normalizers
 *  ------------------------------- */
const BODY_ALIASES = {
  sedan: ['sedan', 'saloon'],
  suv: ['suv', 'sport utility'],
  mpv: ['mpv', 'multi-purpose', 'multi purpose'],
  van: ['van'],
  pickup: ['pickup', 'pick-up', 'truck', 'pick up'],
  hatchback: ['hatch', 'hatchback'],
};

const TX_ALIASES = {
  automatic: ['automatic', 'auto', 'a/t', 'at'],
  manual: ['manual', 'm/t', 'mt', 'stick'],
  any: ['any', 'kahit ano', 'pwede kahit ano'],
};

function normText(s) {
  return (s || '').toLowerCase().normalize('NFKD');
}

export function normalizeBodyType(text) {
  const t = normText(text);
  if (!t) return null;
  for (const key of Object.keys(BODY_ALIASES)) {
    if (t.includes(key) || BODY_ALIASES[key].some(a => t.includes(a))) return key;
  }
  if (/\b(any|kahit\s*ano)\b/.test(t)) return 'any';
  return null;
}

export function normalizeTransmission(text) {
  const t = normText(text);
  if (!t) return null;
  for (const key of Object.keys(TX_ALIASES)) {
    if (t.includes(key) || TX_ALIASES[key].some(a => t.includes(a))) return key;
  }
  if (/\b(any|kahit\s*ano)\b/.test(t)) return 'any';
  return null;
}

/** -------------------------------
 *  Intent & slot extraction (NLP)
 *  ------------------------------- */
const MONEY_RX = /(?:(?:php|₱|phP|\b))(?:\s*)?([\d,.]+)\s*(k|m)?|\b([\d]{3,7})\s*(k|m)?/i;

function parseMoney(s) {
  if (!s) return null;
  const m = s.match(MONEY_RX);
  if (!m) return null;
  const raw = m[1] || m[3];
  const unit = (m[2] || m[4] || '').toLowerCase();
  let n = Number(String(raw).replace(/[.,]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (unit === 'k') n *= 1000;
  if (unit === 'm') n *= 1_000_000;
  return n;
}

function parseBudget(text) {
  const t = normText(text);
  if (!t) return {};
  // phrases like "550k below", "below 600k", "under 500k", "max 500"
  if (/\b(below|under|max|hanggang|cap)\b/.test(t)) {
    const n = parseMoney(t);
    if (n) return { max_cash: n };
  }
  // "between 450k-600k", "450-600k"
  const range = t.match(/(\d[\d,\.]*)\s*-\s*(\d[\d,\.]*)\s*(k|m)?/i);
  if (range) {
    const lo = Number(range[1].replace(/[.,]/g, ''));
    const hiBase = Number(range[2].replace(/[.,]/g, ''));
    const unit = (range[3] || '').toLowerCase();
    let hi = hiBase;
    if (unit === 'k') { /* assume both are k */ }
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const loN = unit === 'k' ? lo * 1000 : lo;
      const hiN = unit === 'k' ? hi * 1000 : hi;
      return { min_cash: loN, max_cash: hiN };
    }
  }
  // single number means "around"
  const n = parseMoney(t);
  if (n) return { approx_cash: n };
  return {};
}

function parsePlan(text) {
  const t = normText(text);
  if (!t) return null;
  if (/\b(cash|spot\s*cash|full\s*payment|outright)\b/.test(t)) return 'cash';
  if (/\b(finance|financing|loan|installment|hulugan|all\s*-?in)\b/.test(t)) return 'financing';
  return null;
}

function parseModelBrandVariant(text) {
  const t = normText(text);
  if (!t) return {};
  // brand & model (simple heuristics)
  // catch "mirage", "vios", "nv350", "hiace", etc.
  const KNOWN_MODELS = ['mirage', 'vios', 'innova', 'fortuner', 'nv350', 'urvan', 'hiace', 'city', 'brv', 'raize', 'xl7', 'stargazer', 'terra', 'montero', 'xtrail', 'yaris', 'accent', 'elantra', 'civic', 'cr-v', 'crv', 'pilot', 'camry', 'altis', 'wigo'];
  let model = null;
  for (const m of KNOWN_MODELS) {
    if (t.includes(m)) { model = m.replace(/-/g, ''); break; }
  }
  // brand detection
  const KNOWN_BRANDS = ['toyota', 'mitsubishi', 'nissan', 'honda', 'suzuki', 'hyundai', 'kia', 'ford', 'isuzu', 'chevrolet', 'mazda'];
  let brand = null;
  for (const b of KNOWN_BRANDS) {
    if (t.includes(b)) { brand = b; break; }
  }
  // variant (GL, GLX, GLS, XE, E, G, S, V, RS, etc.)
  const variantMatch = t.match(/\b(glx|gls|gl|xe|xle|e|g|s|v|vx|rs|sport|premium|deluxe|mt|at)\b/i);
  const variant = variantMatch ? variantMatch[1].toUpperCase() : null;
  return { brand, model, variant };
}

function parseLocation(text) {
  const t = normText(text);
  if (!t) return null;
  // accept "qc", "quezon city", "makati", etc.
  const qc = /\b(qc|quezon\s*city)\b/;
  if (qc.test(t)) return 'Quezon City';
  const mk = /\bmakati\b/;
  if (mk.test(t)) return 'Makati';
  const mnl = /\b(manila|city\s*of\s*manila)\b/;
  if (mnl.test(t)) return 'Manila';
  // generic city/province words: try to pull capitalized tokens (handled upstream if needed)
  return null;
}

/** Parse one user message into slots. */
export function parseBuyerMessage(text) {
  const body_type = normalizeBodyType(text);
  const transmission = normalizeTransmission(text);
  const plan = parsePlan(text);
  const loc = parseLocation(text);
  const budgetInfo = parseBudget(text);
  const { brand, model, variant } = parseModelBrandVariant(text);
  // control intents
  const isRestart = /\b(restart|reset|start\s*over)\b/i.test(text);
  const wantOthers = /\b(others|iba|more\s*options|show\s*others)\b/i.test(text);
  const wantMorePhotos = /\b(more\s*photos|all\s*photos|gallery|full\s*photos)\b/i.test(text);
  // numeric quick-pick like "1", "2"
  const pickIdx = /^\s*([1-9])\s*$/.exec(text) ? Number(/^\s*([1-9])\s*$/.exec(text)[1]) : null;

  return {
    plan,
    location: loc,
    body_type,
    transmission,
    brand,
    model,
    variant,
    ...budgetInfo,
    intents: {
      restart: isRestart,
      others: wantOthers,
      more_photos: wantMorePhotos,
      pick_index: pickIdx
    }
  };
}

/** -------------------------------
 *  Human reply helpers (Tone B)
 *  ------------------------------- */
const toneB = {
  greetNew: (name) =>
    `Hi${name ? ' ' + name : ''}! 👋 I’m your BentaCars consultant. I’ll help match you to the best units — no endless scrolling.`,
  greetReturning: (name) =>
    `Welcome back${name ? ', ' + name : ''}! 👋 Ready to pick up where we left off?`,
  // short & human follow-ups
  askPlan: `Cash or financing plan mo?`,
  askLocation: `Saan location mo? (city/province)`,
  askBody: `Anong body type hanap mo? (sedan/suv/mpv/van/pickup — or type 'any')`,
  askTransmission: `Auto or manual? (pwede rin 'any')`,
  askBudgetCash: `Cash budget range? (e.g., 450k–600k)`,
  noExactPriority: `Walang exact match sa 'priority'. Okay lang, magpapakita ako ng best alternatives ha.`,
  noExactAny: `Wala pa ring exact match. Relax natin ng konti (budget or body type) para may maipakita ako.`,
  softAck: (text) => `Got it — ${text}. ✅`,
};

export function humanizeOpt({ tone = 'B', variant = 'short', returning = false, name = '' } = {}) {
  // We expose this to keep backward compatibility with older imports.
  return {
    greet: returning ? toneB.greetReturning(name) : toneB.greetNew(name),
    askPlan: toneB.askPlan,
    askLocation: toneB.askLocation,
    askBody: toneB.askBody,
    askTransmission: toneB.askTransmission,
    askBudgetCash: toneB.askBudgetCash
  };
}

/** Optionally detect a name from the user message (very simple heuristic). */
export function detectName(text) {
  const t = (text || '').trim();
  // "I'm John", "ako si Mark", "this is Ana"
  const rx = /\b(i['’]m|ako\s*si|this\s*is)\s+([A-Z][a-z]{1,20})\b/;
  const m = rx.exec(t);
  if (m) return m[2];
  return null;
}

/** -------------------------------
 *  Offer formatting helpers
 *  ------------------------------- */

/** Round up to nearest 5,000 (for brackets) */
function roundUp5k(n) {
  if (!Number.isFinite(n)) return null;
  return Math.ceil(n / 5000) * 5000;
}

/** Format 95,000 as "₱95,000" and "95K" if short = true */
function peso(n, short = false) {
  if (!Number.isFinite(n)) return '';
  if (short) return `₱${Math.round(n / 1000)}K`;
  return `₱${n.toLocaleString('en-PH')}`;
}

/**
 * Financing: show all-in bracket (rounded-up lower bound +20k upper bound).
 * Example: all_in=94,120 -> "₱95K–₱115K (promo; subject to approval)"
 */
export function financingBracket(allInExact) {
  const lo = roundUp5k(allInExact);
  if (!lo) return '';
  const hi = lo + 20000;
  // Keep short K format to be concise
  return `${peso(lo, true)}–${peso(hi, true)} (promo; subject to approval)`;
}

/** Compose the price line based on plan. */
export function composePriceLine({ plan, srp, all_in }) {
  if (plan === 'cash') {
    if (Number.isFinite(srp)) {
      return `Cash: ${peso(srp)} — negotiable upon viewing.`;
    }
    return `Cash price — negotiable upon viewing.`;
  }
  // financing
  if (Number.isFinite(all_in)) {
    return `All-in: ${financingBracket(all_in)}. Standard DP is 20% of unit price; all-in available this month.`;
  }
  return `All-in available this month; standard DP is 20% of unit price (subject to approval).`;
}

/** One-line title for an item. */
export function itemTitle({ year, brand, model, variant }) {
  const v = (variant || '').toString().trim();
  const yr = year ? String(year).trim() + ' ' : '';
  const md = [brand, model].filter(Boolean).map(s => String(s).trim()).join(' ');
  return `${yr}${md}${v ? ' ' + v : ''}`.trim();
}

/** Short detail line (location + mileage) */
export function shortDetail({ city, province, mileage }) {
  const loc = [city, province].filter(Boolean).join(' — ');
  const km = Number.isFinite(mileage) ? `${mileage.toLocaleString('en-PH')} km` : '';
  return [loc, km].filter(Boolean).join(' — ');
}

/** -------------------------------
 *  Next-question routing
 *  ------------------------------- */
export function nextMissingSlot(state = {}) {
  // Desired order (C): plan -> location -> body_type -> transmission -> budget (cash last)
  if (!state.plan) return 'plan';
  if (!state.location) return 'location';
  if (!state.body_type) return 'body_type';
  if (!state.transmission) return 'transmission';
  // For cash flows we need budget for smarter filtering,
  // for financing we can proceed even without explicit budget.
  if (state.plan === 'cash') {
    const hasCashBudget = Boolean(state.max_cash || state.min_cash || state.approx_cash);
    if (!hasCashBudget) return 'budget_cash';
  }
  return null;
}

/** Turn a slot key into a human prompt (Tone B) */
export function promptForSlot(slotKey) {
  switch (slotKey) {
    case 'plan': return toneB.askPlan;
    case 'location': return toneB.askLocation;
    case 'body_type': return toneB.askBody;
    case 'transmission': return toneB.askTransmission;
    case 'budget_cash': return toneB.askBudgetCash;
    default: return null;
  }
}

/** -------------------------------
 *  Export a single NLP object also
 *  ------------------------------- */
export const NLP = {
  parseBuyerMessage,
  normalizeBodyType,
  normalizeTransmission,
  nextMissingSlot,
  promptForSlot,
  composePriceLine,
  itemTitle,
  shortDetail
};
