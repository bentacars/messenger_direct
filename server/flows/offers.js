// /server/flows/offers.js
// Phase 2 — match up to 4 units (Priority → OK to Market), show 2 first; backup 2 on "Others".
// On pick, send photo CAROUSEL (image_1..image_10) → next phase (cash/financing).

const INVENTORY_API_URL = process.env.INVENTORY_API_URL || "";

/* ----------------------- utilities ----------------------- */
function num(x) {
  if (x == null || x === "") return NaN;
  const s = String(x).replace(/[₱,\s]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
function norm(s) { return (s || "").toString().trim(); }
function normLower(s) { return norm(s).toLowerCase(); }
function isTruthy(v) { return v !== undefined && v !== null && String(v).trim() !== ""; }

function strongWants(qual = {}) {
  return {
    brand: norm(qual.brand),
    model: norm(qual.model),
    year: qual.year ? String(qual.year).trim() : "",
    variant: norm(qual.variant),
  };
}
function hasStrongWants(w = {}) {
  return !!(w.brand || w.model || w.year || w.variant);
}

/* ----------------------- inventory I/O ----------------------- */
async function fetchInventory() {
  if (!INVENTORY_API_URL) throw new Error("INVENTORY_API_URL missing");

  const headers = {};
  if (process.env.INVENTORY_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.INVENTORY_API_TOKEN}`;
  }

  const res = await fetch(INVENTORY_API_URL, { method: "GET", headers });
  const text = await res.text();

  if (!res.ok) throw new Error(`inventory http ${res.status} ${text.slice(0,120)}`);

  let json;
  try { json = JSON.parse(text); } catch { throw new Error("inventory not JSON"); }

  const rows = Array.isArray(json) ? json
             : (json && Array.isArray(json.data)) ? json.data
             : null;
  if (!Array.isArray(rows)) throw new Error("inventory JSON not array");
  return rows;
}

function normalizeRow(r) {
  const pick = (obj, ...keys) => keys.map(k => obj?.[k]).find(v => v != null);

  return {
    SKU: norm(pick(r, "SKU", "sku", "Sku")),
    brand: norm(pick(r, "brand", "Brand")),
    model: norm(pick(r, "model", "Model")),
    variant: norm(pick(r, "variant", "Variant")),
    year: norm(pick(r, "year", "Year")),
    transmission: normLower(pick(r, "transmission", "Transmission")),
    body_type: normLower(pick(r, "body_type", "bodyType", "Body Type")),
    city: norm(pick(r, "city", "City")),
    province: norm(pick(r, "province", "Province")),
    ncr_zone: norm(pick(r, "ncr_zone", "ncrZone", "NCR")),
    color: norm(pick(r, "color", "Color")),
    mileage: norm(pick(r, "mileage", "Mileage")),
    complete_address: norm(pick(r, "complete_address", "address", "Address")),
    price_status: norm(pick(r, "price_status", "Price Status", "status")),
    srp: num(pick(r, "srp", "SRP", "price", "Price")),
    all_in: num(pick(r, "all_in", "All-in", "allIn")),
    images: [
      r.image_1, r.image_2, r.image_3, r.image_4, r.image_5,
      r.image_6, r.image_7, r.image_8, r.image_9, r.image_10
    ].filter(isTruthy).map(norm),
  };
}

/* ----------------------- matching logic ----------------------- */
function priceMatches(qual, row) {
  if (!qual?.payment || !isFinite(qual.budget)) return true;

  if (qual.payment === "cash") {
    if (!isFinite(row.srp)) return false;
    const lo = qual.budget - 50000;
    const hi = qual.budget + 50000;
    return row.srp >= lo && row.srp <= hi;
  }

  if (qual.payment === "financing") {
    if (isFinite(row.all_in)) return row.all_in <= (qual.budget + 50000);
    // Optional fallback if all_in missing: very coarse filter using SRP
    if (isFinite(row.srp)) return row.srp <= (qual.budget + 50000);
    return false;
  }

  return true;
}

function fieldMatches(qual, row) {
  if (qual.location) {
    const q = normLower(qual.location);
    const rCity = normLower(row.city);
    const rProv = normLower(row.province);
    const rZone = normLower(row.ncr_zone);
    if (q && !(rCity.includes(q) || rProv.includes(q) || rZone.includes(q))) return false;
  }
  if (qual.transmission && qual.transmission !== "any") {
    if (row.transmission && row.transmission !== qual.transmission.toLowerCase()) return false;
  }
  if (qual.bodyType && qual.bodyType !== "any") {
    if (row.body_type && row.body_type !== qual.bodyType.toLowerCase()) return false;
  }
  return true;
}

function strongWantsMatches(qual, row) {
  const want = strongWants(qual);
  if (!hasStrongWants(want)) return true;

  const b = normLower(row.brand);
  const m = normLower(row.model);
  const v = normLower(row.variant);
  const y = (row.year || "").toString().trim();

  if (want.brand && normLower(want.brand) !== b) return false;
  if (want.model && normLower(want.model) !== m) return false;
  if (want.variant && normLower(want.variant) !== v) return false;
  if (want.year && want.year !== y) return false;
  return true;
}

function rankPool(pool) {
  const score = (r) =>
    r.price_status?.toLowerCase()?.includes("priority") ? 2 :
    r.price_status?.toLowerCase()?.includes("ok") ? 1 : 0;
  return pool.slice().sort((a, b) => score(b) - score(a));
}

/* ----------------------- formatting ----------------------- */
function quickHook(row) {
  const mdl = normLower(row.model);
  if (/vios/.test(mdl)) return "Matipid sa gas, mura maintenance";
  if (/mirage/.test(mdl)) return "3-cyl → super tipid sa gas";
  if (/innova/.test(mdl)) return "7-seater, pang-pamilya, diesel tipid";
  if (/everest|fortuner|terra/.test(mdl)) return "Malakas hatak, mataas ground clearance";
  return "Good condition, ready for viewing";
}
function titleLine(row) {
  const yr = row.year ? `${row.year} ` : "";
  const varLine = row.variant ? ` ${row.variant}` : "";
  return `${yr}${row.brand} ${row.model}${varLine}`.trim();
}
function priceLine(qual, row) {
  if (qual.payment === "financing") {
    if (isFinite(row.all_in)) return `All-in: ₱${row.all_in.toLocaleString()} (subject for approval)`;
    return `All-in available (subject for approval)`;
  }
  if (isFinite(row.srp)) return `SRP: ₱${row.srp.toLocaleString()} (negotiable upon viewing)`;
  return "SRP available onsite";
}
function unitCard(qual, row, indexLabel) {
  const img = row.images[0] || null;
  const loc = [row.city, row.province].filter(Boolean).join(" — ");
  const text = [
    titleLine(row),
    row.mileage ? `${row.mileage} km — ${loc || "Metro Manila"}` : `${loc || "Metro Manila"}`,
    priceLine(qual, row),
    `${quickHook(row)} ✅`
  ].join("\n");

  const buttons = [
    { title: indexLabel, payload: `CHOOSE_${row.SKU || indexLabel}` },
    { title: "Others", payload: "SHOW_OTHERS" }
  ];

  const msgs = [];
  if (img) msgs.push({ type: "image", url: img });
  msgs.push({ type: "buttons", text, buttons });
  return msgs;
}
function toCarouselElements(row) {
  const els = [];
  for (const url of row.images) {
    els.push({
      title: titleLine(row),
      image_url: url,
      subtitle: row.complete_address || "",
      default_action: { type: "web_url", url }
    });
  }
  return els.slice(0, 10);
}

/* ----------------------- main step ----------------------- */
export async function step(session, userText, rawEvent) {
  const messages = [];
  const payload = (rawEvent?.postback?.payload && String(rawEvent.postback.payload)) || "";
  const pickPayload = payload.startsWith("CHOOSE_") ? payload : null;
  const wantMorePhotos = /\b(more|photos|pictures|lahat|imgs|gallery|pics)\b/i.test(String(userText || ""));

  session.funnel = session.funnel || {};
  session.offers = session.offers || { page: 0, pool: [], tier: "" };
  const qual = session.qualifier || {};

  // paginate with "Others"
  if (/^SHOW_OTHERS$/i.test(payload)) {
    session.offers.page = (session.offers.page || 0) + 1;
  }

  // build pool if empty
  let pool = session.offers.pool || [];
  if (!pool.length) {
    let rows, error = null;
    try {
      const raw = await fetchInventory();
      rows = raw.map(normalizeRow);
    } catch (e) {
      error = e?.message || e;
    }
    if (error) {
      messages.push({ type: "text", text: `⚠️ Nagka-issue sa inventory: ${error}. Try ulit after a moment or adjust filters (e.g., “SUV AT ₱800k QC”).` });
      return { session, messages };
    }

    const filtered = rows.filter(row =>
      priceMatches(qual, row) &&
      fieldMatches(qual, row) &&
      strongWantsMatches(qual, row)
    );

    pool = rankPool(filtered).slice(0, 4);
    session.offers.pool = pool;
    session.offers.page = 0;
  }

  if (!pool.length) {
    messages.push({ type: "text", text: "Walang exact match sa filters na ’to. Pwede kitang i-tryhan ng alternatives — type mo “Others”." });
    return { session, messages };
  }

  // slice 2 per page
  const PAGE = 2;
  const start = (session.offers.page || 0) * PAGE;
  const slice = pool.slice(start, start + PAGE);

  // user picked or asked for photos
  if (pickPayload || wantMorePhotos) {
    const sku = pickPayload ? pickPayload.replace(/^CHOOSE_/, "") : null;
    const chosen = sku
      ? pool.find(x => (x.SKU && x.SKU === sku) || titleLine(x) === sku) || slice[0]
      : slice[0];

    session.funnel.unit = {
      sku: chosen?.SKU || "",
      label: titleLine(chosen),
      raw: chosen
    };

    messages.push({ type: "text", text: "Solid choice! 🔥 Sending full photos…" });

    if (chosen?.images?.length) {
      const elements = toCarouselElements(chosen);
      if (elements.length >= 2) {
        messages.push({ type: "carousel", elements });
      } else {
        for (const url of chosen.images) messages.push({ type: "image", url });
      }
    }

    session.nextPhase = (qual.payment === "cash") ? "cash" : "financing";
    return { session, messages };
  }

  // show 2 (image + buttons each)
  for (let i = 0; i < slice.length; i++) {
    const row = slice[i];
    const label = i === 0 ? "Unit 1" : "Unit 2";
    messages.push(...unitCard(qual, row, label));
  }

  // hint if there are backups
  if (start + PAGE < pool.length) {
    messages.push({
      type: "buttons",
      text: "Pili ka or check mo pa yung iba.",
      buttons: [{ title: "Others", payload: "SHOW_OTHERS" }]
    });
  }

  return { session, messages };
}

export default { step };
