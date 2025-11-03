// /api/lib/matching.js
export function normalizeRow(r) {
  // Collect image_1..image_10 into an array (skip blanks)
  const images = [];
  for (let i = 1; i <= 10; i++) {
    const v = r[`image_${i}`];
    if (v && String(v).trim()) images.push(String(v).trim());
  }
  return {
    sku: r.SKU || r.sku || r.Sku || "",
    plate_number: r.plate_number || "",
    year: r.year || "",
    brand: r.brand || "",
    model: r.model || "",
    variant: r.variant || "",
    transmission: r.transmission || "",
    fuel_type: r.fuel_type || "",
    body_type: r.body_type || "",
    color: r.color || "",
    mileage: r.mileage || r.km || "",
    video_link: r.video_link || "",
    drive_link: r.drive_link || "",
    dealer_price: num(r.dealer_price),
    srp: num(r.srp),
    all_in: num(r.all_in || r.price_all_in),
    price_status: (r.price_status || "").toString(),
    complete_address: r.complete_address || "",
    city: r.city || "",
    province: r.province || "",
    ncr_zone: r.ncr_zone || "",
    brand_model: r.brand_model || "",
    search_key: r.search_key || "",
    images,
    has_images: images.length > 0
  };
}

function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[₱, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function score(row, want) {
  let s = 0;

  // Model / brand_model
  if (want.model && row.model) {
    if (row.model.toLowerCase().includes(want.model.toLowerCase())) s += 6;
  }
  if (want.brand && row.brand) {
    if (row.brand.toLowerCase().includes(want.brand.toLowerCase())) s += 3;
  }

  // Transmission
  if (want.transmission && row.transmission) {
    if (row.transmission.toLowerCase().startsWith(want.transmission.toLowerCase())) s += 3;
  }

  // Body type
  if (want.body_type && row.body_type) {
    if (row.body_type.toLowerCase().includes(want.body_type.toLowerCase())) s += 2;
  }

  // Budget logic:
  if (want.payment === "cash" && want.cash_budget && row.srp) {
    const diff = Math.abs(row.srp - want.cash_budget);
    s += diff === 0 ? 5 : Math.max(0, 5 - diff / 50000); // softer curve
  }
  if (want.payment === "financing" && want.cash_out && row.all_in) {
    const diff = Math.abs(row.all_in - want.cash_out);
    s += diff === 0 ? 5 : Math.max(0, 5 - diff / 30000);
  }

  // Location nudge
  if (want.city && row.city) {
    if (row.city.toLowerCase().includes(want.city.toLowerCase())) s += 2;
  }
  if (want.province && row.province) {
    if (row.province.toLowerCase().includes(want.province.toLowerCase())) s += 1;
  }

  // Images available
  if (row.has_images) s += 2;

  return s;
}

export function pickTopTwo(rawRows, want) {
  const rows = rawRows.map(normalizeRow);

  // Compute scores
  const scored = rows
    .map(r => ({ r, s: score(r, want) }))
    .sort((a, b) => b.s - a.s);

  if (scored.length === 0) return [];

  const isPriority = x => (x.r.price_status || "").toLowerCase().includes("priority");

  // 1) Take best PRIORITY (if any)
  const pri = scored.find(isPriority);

  // 2) Then take next-best overall (excluding chosen)
  const top = [];
  if (pri) top.push(pri);
  for (const it of scored) {
    if (top.length >= 2) break;
    if (pri && it.r.sku === pri.r.sku) continue;
    top.push(it);
  }

  // return plain rows in order
  return top.map(it => it.r);
}
