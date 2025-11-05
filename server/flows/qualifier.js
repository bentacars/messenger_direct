// /server/flows/qualifier.js
// Phase 1: absorb free-order qualifiers in a conversational way.

const BOOL = (v) => !!v;

const CLEAN = (s='') => s
  .normalize('NFKC')
  .replace(/\s+/g,' ')
  .trim();

function parseBudget(text='') {
  const t = text.replace(/[,₱]/g,'');
  // "550k", "550 K", "550,000", "100k all-in"
  const m1 = t.match(/(\d{2,3})\s*[kK]\b/);
  if (m1) return Number(m1[1]) * 1000;
  const m2 = t.match(/\b(\d{5,7})\b/);
  if (m2) return Number(m2[1]);
  return null;
}

function parsePayment(text='') {
  const t = text.toLowerCase();
  if (/(cash|spot\s*cash|full\s*payment)/.test(t)) return "cash";
  if (/(hulog|hulugan|financ|installment|all[-\s]*in)/.test(t)) return "financing";
  return null;
}

function parseLocation(text='') {
  const m = text.match(/\b([a-zñ\s]+)\b/iu);
  if (!m) return null;
  let loc = CLEAN(m[1]);
  // map shorthand
  if (/^qc$/i.test(loc)) loc = "Quezon City";
  if (/^mm$|^ncr$/i.test(loc)) loc = "Metro Manila";
  return loc;
}

function parseTransmission(text='') {
  const t = text.toLowerCase();
  if (/(^|\W)(at|a\/?t|automatic)\b/.test(t)) return "AT";
  if (/(^|\W)(mt|m\/?t|manual)\b/.test(t)) return "MT";
  if (/\b(any|kahit ano)\b/.test(t)) return "ANY";
  return null;
}

function parseBody(text='') {
  const t = text.toLowerCase();
  if (/\b(sedan)\b/.test(t)) return "sedan";
  if (/\b(suv)\b/.test(t)) return "suv";
  if (/\b(mp[vb])\b/.test(t)) return "mpv";
  if (/\b(van)\b/.test(t)) return "van";
  if (/\b(pick[ -]?up)\b/.test(t)) return "pickup";
  if (/\b(hatch(back)?)\b/.test(t)) return "hatchback";
  if (/\b(cross(over)?)\b/.test(t)) return "crossover";
  if (/\b(any|kahit ano)\b/.test(t)) return "any";
  // 5-seater vs 7+ seater cue
  if (/\b7(\+| plus)?\b/.test(t)) return "mpv";
  return null;
}

function parseModelHints(text='') {
  // Capture brand/model/year/variant hints
  const year = (text.match(/\b(20[0-4]\d|19\d{2})\b/) || [])[0] || "";
  // brand+model (simple heuristic)
  const brands = ["toyota","mitsubishi","honda","nissan","ford","hyundai","kia","isuzu","suzuki","mazda","chevrolet","bmw","mercedes","audi","changan","geely","mg"];
  const foundBrand = brands.find(b => new RegExp(`\\b${b}\\b`, "i").test(text));
  const words = text.split(/\s+/);
  let model = "";
  if (foundBrand) {
    // take next token as model if present
    const idx = words.findIndex(w => new RegExp(`^${foundBrand}$`, "i").test(w));
    if (idx >= 0 && words[idx+1]) model = words[idx+1].replace(/[,\.]/g,'');
  } else {
    // specific popular models
    const popular = ["vios","mirage","city","civic","innova","fortuner","territory","raize","wigo","brv","xtrail","almera","accent","elantra"];
    model = popular.find(m => new RegExp(`\\b${m}\\b`,"i").test(text)) || "";
  }
  // variant: XE, E, GLX, GLS, etc
  const variant = (text.match(/\b([A-Z]{1,3}X?|[A-Z]{1,3}T)\b/) || [])[1] || "";
  return {
    brand: foundBrand ? foundBrand.toLowerCase() : "",
    model: model.toLowerCase(),
    variant: variant,
    year: year ? String(year) : ""
  };
}

export function absorb(prev = {}, userText = "") {
  const text = CLEAN(userText || "");

  const payment = parsePayment(text) || prev.payment || null;
  const budget = parseBudget(text) || prev.budget || null;
  const location = parseLocation(text) || prev.location || null;
  const transmission = parseTransmission(text) || prev.transmission || null;
  const bodyType = parseBody(text) || prev.bodyType || null;
  const pref = parseModelHints(text);

  const next = {
    ...prev,
    payment, budget, location, transmission, bodyType
  };

  // Store strong wants if specified
  if (pref.brand || pref.model || pref.variant || pref.year) {
    next.brand = pref.brand || prev.brand || null;
    next.model = pref.model || prev.model || null;
    next.variant = pref.variant || prev.variant || null;
    next.year = pref.year || prev.year || null;
  }
  return next;
}

export function shortAskForMissing(qual) {
  if (!qual.payment) return "Pwede tayo sa used cars either cash or hulugan—alin ang mas okay sa’yo?";
  if (!qual.budget)  return "Para hindi ako lumagpas, mga magkano ang target budget mo?";
  if (!qual.location) return "Nationwide tayo—saan ka based para ma-match ko sa pinakamalapit?";
  if (!qual.transmission) return "Automatic, manual, or ok lang kahit alin?";
  if (!qual.bodyType)  return "5-seater or 7+ seater ang hanap mo? (sedan/SUV/MPV/van/pickup or any)";
  return null;
}

export function needPhase1(qual) {
  return !(qual?.payment && qual?.budget && qual?.location && qual?.transmission && qual?.bodyType);
}

export function summary(qual = {}) {
  const parts = [];
  if (qual.payment) parts.push(qual.payment === "cash" ? "Cash buyer" : "Financing");
  if (qual.budget) parts.push(`Budget ~ ₱${Number(qual.budget).toLocaleString()}`);
  if (qual.location) parts.push(`Location: ${qual.location}`);
  if (qual.transmission) parts.push(`Trans: ${qual.transmission === "ANY" ? "Any" : (qual.transmission === "AT" ? "Automatic" : "Manual")}`);
  if (qual.bodyType) parts.push(`Body: ${qual.bodyType[0].toUpperCase()+qual.bodyType.slice(1)}`);
  if (qual.model) parts.push(`Pref: ${qual.model}`);
  return parts.join("\n• ");
}

// Helpers for Phase 2
export function strongWants(qual = {}) {
  return {
    brand: (qual.brand || '').trim(),
    model: (qual.model || '').trim(),
    year: qual.year ? String(qual.year).trim() : '',
    variant: (qual.variant || '').trim(),
  };
}
export function hasStrongWants(w = {}) {
  return !!(w.brand || w.model || w.year || w.variant);
}
