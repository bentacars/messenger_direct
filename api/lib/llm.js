// api/lib/llm.js (ESM) — Smart NLP + compatibility shims

/** -------------------------------
 *  Model/temperature helpers
 *  ------------------------------- */
export function pickModel(envValue, fallback = 'gpt-4.1-mini') {
  const v = (envValue || '').trim();
  return v || fallback;
}

export function pickTemp(envValue, fallback = 0.2) {
  const n = Number(envValue);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
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
  if (/\b(below|under|max|hanggang|cap)\b/.test(t)) {
    const n = parseMoney(t);
    if (n) return { max_cash: n };
  }
  const range = t.match(/(\d[\d,\.]*)\s*-\s*(\d[\d,\.]*)\s*(k|m)?/i);
  if (range) {
    const lo = Number(range[1].replace(/[.,]/g, ''));
    const hiBase = Number(range[2].replace(/[.,]/g, ''));
    const unit = (range[3] || '').toLowerCase();
    if (Number.isFinite(lo) && Number.isFinite(hiBase)) {
      const loN = unit === 'k' ? lo * 1000 : lo;
      const hiN = unit === 'k' ? hiBase * 1000 : hiBase;
      return { min_cash: loN, max_cash: hiN };
    }
  }
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
  const KNOWN_MODELS = [
    'mirage','vios','innova','fortuner','nv350','urvan','hiace',
    'city','brv','raize','xl7','stargazer','terra','montero',
    'xtrail','yaris','accent','elantra','civic','cr-v','crv','pilot',
    'camry','altis','wigo'
  ];
  let model = null;
  for (const m of KNOWN_MODELS) {
    if (t.includes(m)) { model = m.replace(/-/g, ''); break; }
  }
  const KNOWN_BRANDS = ['toyota','mitsubishi','nissan','honda','suzuki','hyundai','kia','ford','isuzu','chevrolet','mazda'];
  let brand = null;
  for (const b of KNOWN_BRANDS) {
    if (t.includes(b)) { brand = b; break; }
  }
  const variantMatch = t.match(/\b(glx|gls|gl|xe|xle|e|g|s|v|vx|rs|sport|premium|deluxe|mt|at)\b/i);
  const variant = variantMatch ? variantMatch[1].toUpperCase() : null;
  return { brand, model, variant };
}

function parseLocation(text) {
  const t = normText(text);
  if (!t) return null;
  if (/\b(qc|quezon\s*city)\b/.test(t)) return 'Quezon City';
  if (/\bmakati\b/.test(t)) return 'Makati';
  if (/\b(manila|city\s*of\s*manila)\b/.test(t)) return 'Manila';
  return null;
}

/** Main one-shot parser */
export function parseBuyerMessage(text) {
  const body_type = normalizeBodyType(text);
  const transmission = normalizeTransmission(text);
  const plan = parsePlan(text);
  const loc = parseLocation(text);
  const budgetInfo = parseBudget(text);
  const { brand, model, variant } = parseModelBrandVariant(text);

  const isRestart   = /\b(restart|reset|start\s*over)\b/i.test(text);
  const wantOthers  = /\b(others|iba|more\s*options|show\s*others)\b/i.test(text);
  const wantPhotos  = /\b(more\s*photos|all\s*photos|gallery|full\s*photos)\b/i.test(text);
  const mPick       = /^\s*([1-9])\s*$/.exec(text);
  const pickIdx     = mPick ? Number(mPick[1]) : null;

  return {
    plan,
    location: loc,
    body_type,
    transmission,
    brand,
    model,
    variant,
    ...budgetInfo,
    intents: { restart: isRestart, others: wantOthers, more_photos: wantPhotos, pick_index: pickIdx }
  };
}

/** -------------------------------
 *  Human reply helpers (Tone B)
 *  ------------------------------- */
const toneB = {
  greetNew: (name) =>
    `Hi${name ? ' ' + name : ''}! 👋 I’m your BentaCars consultant. I’ll help match you to the best units — no endless scrolling.`,
  greetReturning: (name) =>
    `Welcome back${name ? ', ' + name : ''}! 👋 Ready to continue?`,
  askPlan: `Cash or financing ang plan mo?`,
  askLocation: `Saan location mo? (city/province)`,
  askBody: `Anong body type hanap mo? (sedan/suv/mpv/van/pickup — or 'any')`,
  askTransmission: `Auto or manual? (pwede 'any')`,
  askBudgetCash: `Cash budget range? (e.g., 450k–600k)`,
};

export function humanizeOpt({ returning = false, name = '' } = {}) {
  return {
    greet: returning ? toneB.greetReturning(name) : toneB.greetNew(name),
    askPlan: toneB.askPlan,
    askLocation: toneB.askLocation,
    askBody: toneB.askBody,
    askTransmission: toneB.askTransmission,
    askBudgetCash: toneB.askBudgetCash,
  };
}

export function detectName(text) {
  const t = (text || '').trim();
  const rx = /\b(i['’]m|ako\s*si|this\s*is)\s+([A-Z][a-z]{1,20})\b/;
  const m = rx.exec(t);
  return m ? m[2] : null;
}

/** -------------------------------
 *  Offer formatting
 *  ------------------------------- */
function roundUp5k(n) {
  if (!Number.isFinite(n)) return null;
  return Math.ceil(n / 5000) * 5000;
}

export function peso(n, short = false) {
  if (!Number.isFinite(n)) return '';
  if (short) return `₱${Math.round(n / 1000)}K`;
  return `₱${n.toLocaleString('en-PH')}`;
}

export function financingBracket(allInExact) {
  const lo = roundUp5k(allInExact);
  if (!lo) return '';
  const hi = lo + 20000;
  return `${peso(lo, true)}–${peso(hi, true)} (promo; subject to approval)`;
}

export function composePriceLine({ plan, srp, all_in }) {
  if (plan === 'cash') {
    return Number.isFinite(srp)
      ? `Cash: ${peso(srp)} — negotiable upon viewing.`
      : `Cash price — negotiable upon viewing.`;
  }
  return Number.isFinite(all_in)
    ? `All-in: ${financingBracket(all_in)}. Standard DP is 20% of unit price; all-in available this month.`
    : `All-in available this month; standard DP is 20% of unit price (subject to approval).`;
}

export function itemTitle({ year, brand, model, variant }) {
  const v = (variant || '').toString().trim();
  const yr = year ? String(year).trim() + ' ' : '';
  const md = [brand, model].filter(Boolean).map(s => String(s).trim()).join(' ');
  return `${yr}${md}${v ? ' ' + v : ''}`.trim();
}

export function shortDetail({ city, province, mileage }) {
  const loc = [city, province].filter(Boolean).join(' — ');
  const km = Number.isFinite(mileage) ? `${mileage.toLocaleString('en-PH')} km` : '';
  return [loc, km].filter(Boolean).join(' — ');
}

/** -------------------------------
 *  Slot flow helpers
 *  ------------------------------- */
export function nextMissingSlot(state = {}) {
  if (!state.plan) return 'plan';
  if (!state.location) return 'location';
  if (!state.body_type) return 'body_type';
  if (!state.transmission) return 'transmission';
  if (state.plan === 'cash') {
    const hasCashBudget = Boolean(state.max_cash || state.min_cash || state.approx_cash);
    if (!hasCashBudget) return 'budget_cash';
  }
  return null;
}

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
 *  Backward-compatibility shims
 *  (to match your webhook imports)
 *  ------------------------------- */
// old -> new aliases
export const humanize = humanizeOpt;              // was: humanize
export const parseUtterance = parseBuyerMessage;  // was: parseUtterance
export function shortMoney(n) { return peso(n, true); } // was: shortMoney
export const allInBracket = financingBracket;     // was: allInBracket

// Aggregate NLP export (optional convenience)
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

/** --------------------------------
 *  Conversational prompts (ask)
 *  -------------------------------- */
export function ask(slotKey, { returning = false, name = '' } = {}) {
  const h = humanizeOpt({ returning, name });
  switch (slotKey) {
    case 'greet':         return h.greet;
    case 'plan':          return h.askPlan;
    case 'location':      return h.askLocation;
    case 'body_type':     return h.askBody;
    case 'transmission':  return h.askTransmission;
    case 'budget_cash':   return h.askBudgetCash;
    default:              return '';
  }
}

/** Namespace style export for backward compatibility:
 *   import * as L from './lib/llm.js';  L.ask(...)
 */
export const L = { ask };
