// Phase 2 — match up to 4 units (Priority → OK to Market), show 2 first,
// "Others" reveals backup 2. When a unit is chosen, send photo CAROUSEL.

import { sendText, sendButtons, sendImage, sendCarousel } from "../lib/messenger.js";

const INVENTORY_API_URL = process.env.INVENTORY_API_URL || process.env.KV_REST_API_URL;

// --- helpers ---
const toNum = (v) => {
  const n = Number(String(v || "").replace(/[₱, ]/g, ""));
  return isFinite(n) ? n : 0;
};

function qualWants(qual = {}) {
  return {
    payment: (qual.payment || "").toLowerCase(), // cash|financing
    budget: toNum(qual.budget),
    location: (qual.location || "").toLowerCase(),
    trans: (qual.transmission || "").toLowerCase(), // at|mt|any
    body: (qual.bodyType || "").toLowerCase(),
    brand: (qual.brand || "").toLowerCase(),
    model: (qual.model || "").toLowerCase(),
    year: String(qual.year || "").toLowerCase(),
    variant: (qual.variant || "").toLowerCase()
  };
}

function isPriority(row) {
  const s = (row.price_status || "").toLowerCase();
  return s.includes("priority");
}
function isOK(row) {
  const s = (row.price_status || "").toLowerCase();
  return s.includes("ok");
}

function withinCashBudget(row, budget) {
  if (!budget) return true;
  const srp = toNum(row.srp || row.dealer_price || 0);
  return srp >= budget - 50000 && srp <= budget + 50000;
}
function withinFinBudget(row, budget) {
  if (!budget) return true;
  const allin = toNum(row.all_in || 0);
  return allin <= budget + 50000;
}

function matchesStrong(row, w) {
  if (w.brand && String(row.brand || "").toLowerCase() !== w.brand) return false;
  if (w.model && String(row.model || "").toLowerCase() !== w.model) return false;
  if (w.variant && !String(row.variant || "").toLowerCase().includes(w.variant)) return false;
  if (w.year && String(row.year || "").toLowerCase() !== w.year) return false;
  return true;
}

function matchesPhase1(row, w) {
  // Transmission "any" means ignore, else check
  if (w.trans && w.trans !== "any") {
    const t = String(row.transmission || "").toLowerCase();
    const wantAT = ["a/t", "at", "automatic"];
    const wantMT = ["m/t", "mt", "manual"];
    if (w.trans.startsWith("a") && !wantAT.some(s => t.includes(s))) return false;
    if (w.trans.startsWith("m") && !wantMT.some(s => t.includes(s))) return false;
  }
  if (w.body && w.body !== "any") {
    const b = String(row.body_type || row.bodyType || "").toLowerCase();
    if (b && !b.includes(w.body)) return false;
  }
  return true;
}

function quickHook(row) {
  const m = String(row.model || "").toLowerCase();
  if (m.includes("vios")) return "Matipid, mura maintenance ✅";
  if (m.includes("mirage")) return "3-cyl → super tipid sa gas ✅";
  if (m.includes("innova")) return "7-seater, pang-pamilya ✅";
  if (m.includes("everest")) return "Mataas ground clearance, malakas hatak ✅";
  return "Good condition, ready for viewing ✅";
}

function imagesOf(row) {
  const imgs = [];
  for (let i = 1; i <= 10; i++) {
    const u = row[`image_${i}`];
    if (u && /^https?:\/\//i.test(u)) imgs.push(u);
  }
  return imgs;
}

// Build pool (max 4) honoring Priority→OK and strong wants
async function buildPool(qual) {
  const w = qualWants(qual);

  const res = await fetch(INVENTORY_API_URL);
  const data = await res.json(); // expect array of rows with headers provided

  const base = Array.isArray(data) ? data : (data?.rows || []);
  const items = base.filter(Boolean);

  const priced = items.filter(row => {
    if (w.payment === "cash") return withinCashBudget(row, w.budget);
    return withinFinBudget(row, w.budget);
  }).filter(row => matchesPhase1(row, w));

  const strong = priced.filter(r => matchesStrong(r, w));
  const loose  = priced.filter(r => !matchesStrong(r, w));

  function sortTier(list) {
    const pri = list.filter(isPriority);
    const ok  = list.filter(r => !isPriority(r) && isOK(r));
    const rest = list.filter(r => !pri.includes(r) && !ok.includes(r));
    return [...pri, ...ok, ...rest];
  }

  const ordered = [...sortTier(strong), ...sortTier(loose)];
  return ordered.slice(0, 4);
}

// Format single card text
function unitLine(row, payment) {
  const loc = [row.city, row.province || row.ncr_zone].filter(Boolean).join(", ");
  const km = row.mileage ? `${row.mileage} km — ` : "";
  if (payment === "cash") {
    const srp = toNum(row.srp) || toNum(row.dealer_price);
    return [
      `${row.year || ""} ${row.brand || ""} ${row.model || ""} ${row.variant || ""}`.replace(/\s+/g, " ").trim(),
      `${km}${loc}`,
      `SRP: ₱${(srp || 0).toLocaleString()} (negotiable upon viewing)`,
      quickHook(row)
    ].join("\n");
  } else {
    const range = row.all_in ? `₱${toNum(row.all_in).toLocaleString()}` : "Ask all-in";
    return [
      `${row.year || ""} ${row.brand || ""} ${row.model || ""} ${row.variant || ""}`.replace(/\s+/g, " ").trim(),
      `${km}${loc}`,
      `All-in: ${range} (subject for approval)`,
      "Standard 20–30% DP, may promo all-in ✅"
    ].join("\n");
  }
}

function elementFor(row, idx) {
  const title = `${row.year || ""} ${row.brand || ""} ${row.model || ""}`.replace(/\s+/g, " ").trim();
  const subtitle = quickHook(row);
  const img = imagesOf(row)[0] || row.image_1 || row.image_2;
  return {
    title: title || "Unit",
    image_url: img || undefined,
    subtitle,
    buttons: [
      { type: "postback", title: `Unit ${idx}`, payload: `CHOOSE_${idx}` }
    ]
  };
}

export async function step(session, userText, rawEvent) {
  const messages = [];
  session.funnel = session.funnel || {};
  session.offers = session.offers || { pool: [], page: 0 };

  const payload = (rawEvent?.postback?.payload || "").toString();
  const wantMorePhotos =
    /\b(more|photos|images|lahat|tingin|shots|gallery)\b/i.test(String(userText || ""));

  // Handle CHOOSE_X → send gallery (carousel if possible)
  if (/^CHOOSE_\d+/.test(payload)) {
    const idx = Number(payload.split("_")[1]) - 1;
    const unit = session.offers.pool[idx];
    if (!unit) {
      messages.push({ type: "text", text: "Medyo nawala ‘yung item na ‘yon. Pwede pili ka ulit? 😊" });
      return { session, messages };
    }

    messages.push({ type: "text", text: "Solid choice! 🔥 Sending full photos…" });

    const imgs = imagesOf(unit);
    if (imgs.length >= 2) {
      // build carousel elements from images
      const elements = imgs.slice(0, 10).map((u, i) => ({
        title: i === 0 ? "Front / Angle" : `Photo ${i + 1}`,
        image_url: u
      }));
      messages.push({ type: "carousel", elements });
    } else if (imgs.length === 1) {
      messages.push({ type: "image", url: imgs[0] });
    } else {
      messages.push({ type: "text", text: "Walang uploaded gallery, pero pwede tayo mag viewing. 😊" });
    }

    // Next phase hint (router will switch)
    session.nextPhase = (session.qualifier?.payment === "cash") ? "cash" : "financing";
    return { session, messages };
  }

  // "Others" → next page
  if (/^SHOW_OTHERS/.test(payload) || /^others$/i.test(String(userText || ""))) {
    session.offers.page = (session.offers.page || 0) + 1;
  }

  // First time in phase2 → build pool
  if (!session.offers.pool?.length) {
    let pool = [];
    try {
      pool = await buildPool(session.qualifier || {});
    } catch (e) {
      messages.push({ type: "text", text: `⚠️ Nagka-issue sa inventory: ${e?.message || e}. Subukan natin ulit mamaya o bawasan natin ang filters.` });
      return { session, messages };
    }

    if (!pool.length) {
      messages.push({ type: "text", text: "Walang exact match sa filters na ‘to. Pwede kitang i-tryhan ng alternatives — type mo “Others”. 🙂" });
      return { session, messages };
    }

    session.offers.pool = pool.slice(0, 4);
    session.offers.page = 0;
  }

  // Show 2 per page
  const start = (session.offers.page || 0) * 2;
  const slice = session.offers.pool.slice(start, start + 2);
  const payment = (session.qualifier?.payment || "").toLowerCase();

  for (let i = 0; i < slice.length; i++) {
    const row = slice[i];
    const text = unitLine(row, payment);
    const img = imagesOf(row)[0];
    if (img) messages.push({ type: "image", url: img });
    messages.push({ type: "text", text });
  }

  // Buttons row
  const btns = [];
  if (slice[0]) btns.push({ title: "Unit 1", payload: "CHOOSE_1" });
  if (slice[1]) btns.push({ title: "Unit 2", payload: "CHOOSE_2" });

  // If more exist, add Others
  if (start + 2 < session.offers.pool.length) {
    btns.push({ title: "Others", payload: "SHOW_OTHERS" });
  }

  messages.push({ type: "buttons", text: "Pili ka:", buttons: btns });

  // If user typed “photos” on a specific unit name, we could enhance here later.
  if (wantMorePhotos && slice[0]) {
    // Send quick gallery for the first visible item
    const imgs = imagesOf(slice[0]);
    if (imgs.length >= 2) {
      const elements = imgs.slice(0, 10).map((u, i) => ({ title: `Photo ${i + 1}`, image_url: u }));
      messages.push({ type: "carousel", elements });
    } else if (imgs[0]) {
      messages.push({ type: "image", url: imgs[0] });
    }
  }

  return { session, messages };
}

export default { step };
