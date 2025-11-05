// server/flows/offers.js
// Phase 2: Matching & formatting (LLM hook + human captions)

import { composeUnitReply } from "../lib/format.js";
import { getHookLine } from "../lib/model.js";

/* ---------------- Inventory Fetch ---------------- */

const INVENTORY_API_URL = process.env.INVENTORY_API_URL;

async function fetchInventory() {
  if (!INVENTORY_API_URL) {
    console.error("[offers] INVENTORY_API_URL missing");
    return [];
  }
  try {
    const r = await fetch(INVENTORY_API_URL);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("[offers] fetch error", r.status, t);
      return [];
    }
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data;
  } catch (e) {
    console.error("[offers] fetch crash", e);
    return [];
  }
}

/* ---------------- Helpers ---------------- */

function normStr(s = "") {
  return (s || "").toString().trim();
}

function numOrNull(v) {
  const n = Number(String(v).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function same(a = "", b = "") {
  return normStr(a).toLowerCase() === normStr(b).toLowerCase();
}

function includesCI(hay = "", needle = "") {
  return normStr(hay).toLowerCase().includes(normStr(needle).toLowerCase());
}

function pickBodyType(bt = "") {
  const s = normStr(bt).toLowerCase();
  if (!s) return "";
  // normalize common variants
  if (/^suv$/.test(s)) return "suv";
  if (/^mpv$/.test(s)) return "mpv";
  if (/^van$/.test(s)) return "van";
  if (/^pickup|^pick[- ]?up/.test(s)) return "pickup";
  if (/^hatch|hatchback/.test(s)) return "hatchback";
  if (/^crossover$/.test(s)) return "crossover";
  if (/^sedan$/.test(s)) return "sedan";
  if (/^auv$/.test(s)) return "auv";
  return s;
}

function scoreLocation(unit = {}, location = "") {
  // simple scoring: exact city match > province match > NCR zone hint > 0
  const loc = normStr(location).toLowerCase();
  if (!loc) return 0;
  const city = normStr(unit.city).toLowerCase();
  const prov = normStr(unit.province).toLowerCase();
  const zone = normStr(unit.ncr_zone).toLowerCase();
  if (loc && city && city.includes(loc)) return 30;
  if (loc && prov && prov.includes(loc)) return 20;
  if (loc && zone && zone.includes(loc)) return 10;
  return 0;
}

function pricePass(unit, qual) {
  const budget = numOrNull(qual?.budget);
  if (!budget) return true; // no budget provided, don’t block

  if ((qual?.payment || "").toLowerCase().startsWith("cash")) {
    const srp = numOrNull(unit.srp);
    if (!srp) return false;
    return Math.abs(srp - budget) <= 50000;
  } else {
    // financing path
    const allIn = numOrNull(unit.all_in);
    if (!allIn) return false;
    return allIn <= budget + 50000;
  }
}

function transPass(unit, qual) {
  const want = normStr(qual?.transmission).toLowerCase();
  if (!want || want === "any") return true;
  const t = normStr(unit.transmission).toLowerCase();
  if (!t) return false;
  if (want.startsWith("a")) return /^a(uto|\/?t|utomatic)?/.test(t) || t.includes("a/t") || t.includes("automatic");
  if (want.startsWith("m")) return /^m(t|anual|manual)/.test(t) || t.includes("m/t") || t.includes("manual");
  return t.includes(want);
}

function bodyPass(unit, qual) {
  const want = pickBodyType(qual?.bodyType);
  if (!want) return true;
  const u = pickBodyType(unit.body_type);
  if (!u) return false;
  return u === want;
}

function strongWants(qual = {}) {
  return {
    brand: normStr(qual.brand),
    model: normStr(qual.model),
    year: normStr(qual.year),
    variant: normStr(qual.variant),
  };
}

function strongFilter(unit, wants) {
  // all given strong fields must match (case-insensitive, contains for model/variant)
  if (wants.brand && !includesCI(unit.brand, wants.brand)) return false;
  if (wants.model && !includesCI(unit.model, wants.model)) return false;
  if (wants.year && normStr(unit.year) !== normStr(wants.year)) return false;
  if (wants.variant && !includesCI(unit.variant, wants.variant)) return false;
  return true;
}

function statusRank(unit) {
  const s = normStr(unit.price_status).toLowerCase();
  if (s === "priority") return 0;
  if (s === "ok to market" || s === "ok-to-market" || s === "ok") return 1;
  return 2; // others last
}

/* ---------------- Matching Core ---------------- */

export async function matchUnits(qualifier = {}) {
  const inv = await fetchInventory();
  if (inv.length === 0) return { mainUnits: [], backupUnits: [] };

  const wants = strongWants(qualifier);

  // 1) strong-filtered list (if any wants provided)
  let pool = inv.filter((u) => {
    if (wants.brand || wants.model || wants.year || wants.variant) {
      if (!strongFilter(u, wants)) return false;
    }
    // Core passes
    if (!pricePass(u, qualifier)) return false;
    if (!transPass(u, qualifier)) return false;
    if (!bodyPass(u, qualifier)) return false;
    return true;
  });

  if (pool.length === 0) {
    // 2) fallback to softer filter (ignore strong wants)
    pool = inv.filter((u) => pricePass(u, qualifier) && transPass(u, qualifier) && bodyPass(u, qualifier));
  }

  // Rank: price_status > location score > recency (updated_at)
  const loc = qualifier?.location || "";
  pool.sort((a, b) => {
    const sr = statusRank(a) - statusRank(b);
    if (sr !== 0) return sr;

    const la = scoreLocation(a, loc);
    const lb = scoreLocation(b, loc);
    if (lb !== la) return lb - la;

    const ta = Date.parse(a.updated_at || "") || 0;
    const tb = Date.parse(b.updated_at || "") || 0;
    return tb - ta;
  });

  // Cap to 4; split to first 2 then next 2
  const top4 = pool.slice(0, 4);
  const mainUnits = top4.slice(0, 2);
  const backupUnits = top4.slice(2, 4);

  return { mainUnits, backupUnits };
}

/* ---------------- Formatter ---------------- */

export async function formatUnitReply(unit = {}, payment = "cash") {
  const mode = (payment || "").toLowerCase().startsWith("cash") ? "cash" : "financing";
  const hook = await getHookLine(unit);
  const { image, caption } = composeUnitReply(unit, mode, hook);

  // NOTE:
  // Our router currently pushes ONE message per unit.
  // We’ll send the caption first (clean, human).
  // Images (carousel) are sent AFTER the user picks a unit in Phase 3.

  return {
    type: "text",
    text: caption,
    // If you later want to send image + text here, adjust router to accept arrays.
    // e.g., return [{ type:'images', urls:[image] }, { type:'text', text: caption }]
  };
}

/* ---------------- Optional step() (tolerant) ----------------
 * If you later decide to call offers.step(...) directly from the router,
 * you can wire postback handling here. For now, router handles the flow.
 */
export async function step(/* ctx */) {
  return { messages: [], session: {} };
}

export default { matchUnits, formatUnitReply, step };
