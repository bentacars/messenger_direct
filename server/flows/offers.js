// /server/flows/offers.js
// Phase 2 — match up to 4 units (Priority → OK to Market), show 2 first, "Others" reveals backup,
// and when a unit is chosen, send photo GALLERY (image_1..image_10) then move to next phase.

import { strongWants, hasStrongWants } from './qualifier.js';
import { sendText, sendButtons, sendImage, sendImagesCarousel } from '../lib/messenger.js';
import { nlg } from '../lib/ai.js';

const INVENTORY_API_URL = process.env.INVENTORY_API_URL || "";

const PAGE_SIZE = 2;

function carHook(row) {
  // ultra-simple hooks; can expand with a model→hook table later
  const m = (row.model || "").toLowerCase();
  if (/mirage/.test(m)) return "3-cyl → super tipid sa gas ✅";
  if (/vios/.test(m)) return "Matipid, pang-grab, mura maintenance ✅";
  if (/innova/.test(m)) return "7-seater, pang-pamilya, diesel tipid ✅";
  return "Good condition, ready to view ✅";
}

function pickPrimaryImage(row) {
  for (let i = 1; i <= 10; i++) {
    const key = `image_${i}`;
    if (row[key]) return row[key];
  }
  return null;
}

function allImages(row) {
  const images = [];
  for (let i = 1; i <= 10; i++) {
    const key = `image_${i}`;
    if (row[key]) images.push(row[key]);
  }
  return images;
}

async function fetchInventory() {
  if (!INVENTORY_API_URL) return [];
  try {
    const res = await fetch(INVENTORY_API_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`Inventory HTTP ${res.status}`);
    const data = await res.json();
    // Expect array of rows with headers the user provided
    return Array.isArray(data) ? data : (data?.rows || []);
  } catch (err) {
    console.error("fetchInventory error", err);
    return [];
  }
}

function withinBudgetCash(row, budget) {
  if (!budget) return true;
  const srp = Number(row.srp || row.dealer_price || 0);
  if (!srp) return false;
  return Math.abs(srp - budget) <= 50000; // ±₱50k
}

function withinBudgetFinancing(row, budget) {
  if (!budget) return true;
  const allIn = Number(row.all_in || 0);
  if (!allIn) return false;
  return allIn <= (budget + 50000);
}

function cityMatches(rowCity="", wantCity="") {
  if (!wantCity) return true;
  const a = (rowCity || "").toLowerCase();
  const b = (wantCity || "").toLowerCase();
  if (!a || !b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

function buildTitle(row) {
  // "2020 Toyota Vios XE A/T"
  const year = row.year || "";
  const brand = row.brand || "";
  const model = row.model || "";
  const variant = row.variant || "";
  return [year, brand, model, variant].filter(Boolean).join(" ").trim();
}

function describeUnit(row, isCash) {
  const loc = [row.city, row.province || row.ncr_zone || ""].filter(Boolean).join(", ");
  const km = row.mileage ? `${row.mileage.toLocaleString()} km` : "";
  const priceLine = isCash
    ? `SRP: ₱${Number(row.srp || 0).toLocaleString()} (negotiable upon viewing)`
    : `All-in: ₱${Number(row.all_in || 0).toLocaleString()} (subject for approval)`;
  const body = [
    buildTitle(row),
    [km, loc].filter(Boolean).join(" — "),
    priceLine,
    carHook(row)
  ].filter(Boolean).join("\n");
  return body;
}

function filterPool(rows, qual) {
  const wants = strongWants(qual);
  const isCash = qual.payment === "cash";

  // 1) priority first, then ok-to-market
  const priority = rows.filter(r => (r.price_status || "").toLowerCase().includes("priority"));
  const ok = rows.filter(r => (r.price_status || "").toLowerCase().includes("ok"));

  function matchOne(r) {
    // strong wants (if any)
    if (hasStrongWants(wants)) {
      if (wants.brand && String(r.brand || "").toLowerCase() !== wants.brand) return false;
      if (wants.model && String(r.model || "").toLowerCase() !== wants.model) return false;
      if (wants.year && String(r.year || "") !== wants.year) return false;
      if (wants.variant && !String(r.variant || "").toUpperCase().includes(String(wants.variant).toUpperCase())) return false;
    }
    // phase-1 fields: body, trans, location, budget
    if (qual.bodyType && qual.bodyType !== "any") {
      if (String(r.body_type || "").toLowerCase() !== String(qual.bodyType).toLowerCase()) return false;
    }
    if (qual.transmission && qual.transmission !== "ANY") {
      const want = qual.transmission === "AT" ? "automatic" : "manual";
      const have = String(r.transmission || "").toLowerCase();
      if (!have.includes(want)) return false;
    }
    if (!cityMatches(String(r.city || ""), String(qual.location || ""))) return false;

    // budget logic
    if (isCash) return withinBudgetCash(r, Number(qual.budget || 0));
    return withinBudgetFinancing(r, Number(qual.budget || 0));
  }

  const p = priority.filter(matchOne);
  const o = ok.filter(matchOne);
  return [...p, ...o].slice(0, 8); // build a bigger shortlist first
}

export default async function step(session, userText, rawEvent) {
  const messages = [];
  const qual = session.qualifier || {};
  const isCash = qual.payment === "cash";

  // --- state for paging/selection
  session.funnel = session.funnel || {};
  session._offers = session._offers || { page: 0, pool: [] };

  // handle "Others" or choose
  const payloadText = (rawEvent?.postback?.payload || "").toString();
  const rawTxt = (userText || "").toLowerCase();

  if (/^CHOOSE_/.test(payloadText)) {
    const sku = payloadText.replace(/^CHOOSE_/, "");
    const chosen = session._offers.pool.find(x => String(x.SKU || x.sku) === sku);
    if (!chosen) {
      messages.push({ type: "text", text: "Nawala yung unit na ‘yon, pili ka muna sa list below or type “Others” para sa iba pa." });
      return { session, messages };
    }

    // Confirm + send gallery
    const t = await nlg("Solid choice! 🔥 Sending full photos…", { persona: "friendly" });
    messages.push({ type: "text", text: t });

    const imgs = allImages(chosen);
    if (imgs.length) {
      if (typeof sendImagesCarousel === "function") {
        // Messenger generic template carousel
        messages.push({ type: "gallery", images: imgs });
      } else {
        for (const url of imgs) messages.push({ type: "image", url });
      }
    }

    // Decide next phase (cash/financing)
    session.unit = { sku: String(chosen.SKU || ""), label: buildTitle(chosen), raw: chosen };
    session.nextPhase = isCash ? "cash" : "financing";
    return { session, messages };
  }

  if (/others/i.test(payloadText) || /\bothers\b/i.test(rawTxt)) {
    session._offers.page = (session._offers.page || 0) + 1;
  }

  // --- if first time building pool
  if (!Array.isArray(session._offers.pool) || !session._offers.pool.length) {
    const rows = await fetchInventory();
    const pool = filterPool(rows, qual);
    session._offers.pool = pool.slice(0, 4); // limit to 4 total
    session._offers.page = 0;

    if (!pool.length) {
      const sorry = await nlg(
        "Walang exact match sa filters na ’to. Pwede kitang i-tryhan ng alternatives—type mo “Others”.",
        { persona: "friendly" }
      );
      messages.push({ type: "text", text: sorry });
      return { session, messages };
    }
  }

  // --- summary line before offers (first show only)
  if (!session._offers._summarized) {
    const sum = [
      isCash ? "Cash buyer" : "Financing",
      qual.budget ? `Budget ~ ₱${Number(qual.budget).toLocaleString()}` : "",
      qual.location ? `Location: ${qual.location}` : "",
      qual.transmission ? `Trans: ${qual.transmission === "ANY" ? "Any" : qual.transmission}` : "",
      qual.bodyType ? `Body: ${qual.bodyType}` : "",
      qual.model ? `Pref: ${qual.model}` : ""
    ].filter(Boolean).join("\n• ");

    const txt = await nlg(
      `Alright, ito’ng hahanapin ko for you:\n• ${sum}\nSaglit, I’ll pull the best units that fit this. 🔎`,
      { persona: "friendly" }
    );
    messages.push({ type: "text", text: txt });
    session._offers._summarized = true;
  }

  // --- page slice (2 first, 2 backup)
  const start = (session._offers.page || 0) * PAGE_SIZE;
  const slice = session._offers.pool.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    const widen = await nlg(
      "Mukhang wala nang exact matches. Gusto mo bang i-widen ko yung search? Pwede kong taasan nang konti ang price range or ibang body type.",
      { persona: "friendly" }
    );
    messages.push({
      type: "buttons",
      text: widen,
      buttons: [{ title: "Widen search ✅", payload: "WIDEN" }, { title: "Keep as is ❌", payload: "KEEP" }]
    });
    return { session, messages };
  }

  for (const row of slice) {
    const img = pickPrimaryImage(row);
    const body = describeUnit(row, isCash);
    if (img) messages.push({ type: "image", url: img });
    messages.push({
      type: "buttons",
      text: body,
      buttons: [
        { title: "Unit 1", payload: `CHOOSE_${row.SKU || row.sku}` },
        { title: "Others", payload: "SHOW_OTHERS" }
      ]
    });
  }

  return { session, messages };
}
