// /server/flows/offers.js
// Phase 2 — match up to 4 units (Priority → OK to Market), show 2 first; backup 2 on "Others"
// When a unit is chosen, send a photo CAROUSEL (image_1..image_10), then move to next phase.

const INVENTORY_API_URL = process.env.INVENTORY_API_URL || '';

/* --------------------------- utils --------------------------- */
function toNum(x) {
  if (x == null) return NaN;
  const n = Number(String(x).replace(/[₱, ]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
function norm(s) { return String(s || '').trim().toLowerCase(); }
function nonEmpty(arr) { return Array.isArray(arr) && arr.filter(Boolean).length > 0; }

function getAllImages(row) {
  const imgs = [];
  for (let i = 1; i <= 10; i++) {
    const v = row[`image_${i}`];
    if (v && String(v).startsWith('http')) imgs.push(String(v));
  }
  return imgs;
}

function quickHook(row) {
  // very simple hooks; you can expand via a model→hook map later (Phase 2.5)
  const m = norm(row.model);
  if (m.includes('vios') || m.includes('mirage')) return 'super tipid sa gas ✅';
  if (m.includes('innova')) return '7-seater, pang pamilya ✅';
  if (m.includes('everest') || m.includes('fortuner')) return 'mataas ground clearance ✅';
  return 'parts are easy to find ✅';
}

/* --------------------------- fetch inventory --------------------------- */
async function fetchInventory() {
  if (!INVENTORY_API_URL) throw new Error('INVENTORY_API_URL missing');
  const res = await fetch(INVENTORY_API_URL);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Inventory fetch ${res.status}: ${t}`);
  }
  const data = await res.json();
  // Expect array of rows with headers provided by user.
  return Array.isArray(data) ? data : [];
}

/* --------------------------- filters & ranking --------------------------- */
function isNearby(row, qual) {
  const city = norm(row.city);
  const prov = norm(row.province);
  const zone = norm(row.ncr_zone);
  const qcity = norm(qual.location || '');
  // hierarchy: same city → same province → same ncr_zone → else ok
  if (qcity && city && city.includes(qcity)) return 3;
  if (qcity && prov && qcity && qcity && qcity && prov.includes(qcity)) return 2;
  if (qcity && zone && (qcity.includes('qc') || qcity.includes('quezon'))) {
    // qc belongs to Metro Manila (NCR)
    return zone.includes('ncr') || zone.includes('metro') ? 1 : 0;
  }
  // if no location given, neutral
  return 1; // neutral weight
}

function pricePass(row, qual) {
  const payment = norm(qual.payment);
  const budget = toNum(qual.budget);
  if (!Number.isFinite(budget)) return true; // no budget → don't block

  if (payment === 'cash') {
    const srp = toNum(row.srp);
    if (!Number.isFinite(srp)) return false;
    return Math.abs(srp - budget) <= 50000; // ±₱50k
  }

  // financing → use all_in ≤ budget + 50k
  const allIn = toNum(row.all_in);
  if (!Number.isFinite(allIn)) return false;
  return allIn <= (budget + 50000);
}

function specPass(row, qual) {
  const bt = norm(qual.bodyType || '');
  const tr = norm(qual.transmission || '');

  const rowBT = norm(row.body_type);
  const rowTR = norm(row.transmission);

  const btOk = !bt || bt === 'any' || rowBT === bt;
  const trOk = !tr || tr === 'any' || rowTR === tr || (tr === 'automatic' && rowTR === 'at') || (tr === 'manual' && rowTR === 'mt');
  return btOk && trOk;
}

function strongWants(qual = {}) {
  return {
    brand: (qual.brand || '').trim(),
    model: (qual.model || '').trim(),
    year: qual.year ? String(qual.year).trim() : '',
    variant: (qual.variant || '').trim(),
  };
}
function hasStrongWants(w = {}) {
  return !!(w.brand || w.model || w.year || w.variant);
}

function matchScore(row, qual) {
  // base score by proximity and status
  let score = 0;
  const near = isNearby(row, qual); // 0..3
  score += near * 2;

  const status = norm(row.price_status);
  if (status === 'priority') score += 6;
  else if (status.includes('ok')) score += 3;

  // spec alignment
  if (specPass(row, qual)) score += 3;

  // strong wants boosts
  const w = strongWants(qual);
  if (w.brand && norm(row.brand) === norm(w.brand)) score += 2;
  if (w.model && norm(row.model).includes(norm(w.model))) score += 2;
  if (w.year && String(row.year) === String(w.year)) score += 1;
  if (w.variant && norm(row.variant).includes(norm(w.variant))) score += 1;

  return score;
}

/* Build a prioritized pool (max 4) in correct order:
   1) Priority matches (up to 4)
   2) If <4, add OK to Market matches
*/
async function buildPool(qual) {
  const rows = await fetchInventory();

  // First, hard filter by specs & price
  const filtered = rows.filter(r => pricePass(r, qual) && specPass(r, qual));

  // Partition by status
  const pri = [];
  const okm = [];

  for (const r of filtered) {
    const s = norm(r.price_status);
    const item = { row: r, score: matchScore(r, qual) };
    if (s === 'priority') pri.push(item);
    else if (s.includes('ok')) okm.push(item);
  }

  // Sort each bucket by score desc
  pri.sort((a,b)=>b.score - a.score);
  okm.sort((a,b)=>b.score - a.score);

  // Take up to 4 total
  const combined = [...pri, ...okm].slice(0, 4).map(x => x.row);

  // If still nothing, widen gradually:
  if (combined.length === 0) {
    // 1) Drop body type constraint
    const relaxed1 = rows.filter(r => pricePass(r, qual) && specPass(r, { ...qual, bodyType: 'any' }));
    const plus = relaxed1
      .map(r => ({ row: r, score: matchScore(r, { ...qual, bodyType: 'any' }) }))
      .sort((a,b)=>b.score-a.score)
      .slice(0,4)
      .map(x=>x.row);
    return plus;
  }

  return combined;
}

/* --------------------------- public step() --------------------------- */
export default async function step(session, userText, rawEvent) {
  const messages = [];
  const payload = (rawEvent?.postback?.payload && String(rawEvent.postback.payload)) || '';
  const t = String(userText || '').toLowerCase();

  session.funnel = session.funnel || {};
  session._offers = session._offers || { pool: [], page: 0, tier: '' };

  // paging
  if (/^SHOW_OTHERS$/.test(payload) || /\bothers\b/i.test(t)) {
    session._offers.page = (session._offers.page || 0) + 1;
  }

  // compute or reuse pool
  const qual = session.qualifier || {};
  let pool = session._offers.pool;
  if (!nonEmpty(pool)) {
    try {
      pool = await buildPool(qual);
      session._offers.pool = pool.slice(0, 4);
      session._offers.page = 0;
    } catch (error) {
      messages.push({ type: 'text', text: `⚠️ Nagka-issue sa inventory: ${error?.message || error}. Try ulit after a moment or adjust filters (e.g., “SUV AT ₱800k QC”).` });
      return { session, messages };
    }
  }

  if (!pool.length) {
    messages.push({
      type: 'text',
      text: `Walang exact match sa filters na ’to. Pwede kitang i-tryhan ng alternatives — type mo “Others”, or sabihin mo “widen search” para lumuwag yung body type / location.`
    });
    return { session, messages };
  }

  // slice per page: 2 at a time
  const PAGE_SIZE = 2;
  const start = (session._offers.page || 0) * PAGE_SIZE;
  const slice = pool.slice(start, start + PAGE_SIZE);

  // If user tapped a unit or asked for more photos → send gallery
  const choosePayload = /^CHOOSE_(.+)$/;
  const wantMorePhotos = /\bmore(s|)\s*(photos|pics|images)|lahat|show\s*(photos|images)|gallery|carousel\b/.test(t);
  if (choosePayload.test(payload) || wantMorePhotos) {
    const sku = (payload.match(choosePayload) || [])[1] || (slice[0] && slice[0].SKU);
    const chosen = (pool.find(r => String(r.SKU) === String(sku))) || slice[0];
    if (chosen) {
      session.funnel.unit = { id: chosen.SKU, label: `${chosen.year} ${chosen.brand} ${chosen.model} ${chosen.variant}` };
      messages.push({ type: 'text', text: `Solid choice! 🔥 Sending full photos…` });

      const imgs = getAllImages(chosen);
      if (imgs.length) {
        // Messenger Generic Template carousel
        const elements = imgs.map(u => ({ title: '', image_url: u }));
        messages.push({ type: 'generic', elements }); // your webhook should map this to sendGenericTemplate
      } else {
        messages.push({ type: 'text', text: `Walang uploaded photos pa for this listing.` });
      }

      // Decide next phase based on qualifier.payment
      const p = norm(qual.payment);
      session.nextPhase = (p === 'cash') ? 'cash' : 'financing';
      return { session, messages };
    }
  }

  // Otherwise show 1 or 2 units with buttons
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    const imgs = getAllImages(r);
    if (imgs[0]) {
      messages.push({ type: 'image', url: imgs[0] });
    }

    const payment = norm(qual.payment);
    const lineCash = `SRP: ₱${toNum(r.srp).toLocaleString('en-PH')} (negotiable upon viewing)\n${quickHook(r)}`;
    const lineFin = `All-in: ₱${toNum(r.all_in).toLocaleString('en-PH')} (subject for approval)\nStandard 20–30% DP for used cars.`;
    const priceLine = payment === 'cash' ? lineCash : lineFin;

    messages.push({
      type: 'text',
      text:
`${r.year} ${r.brand} ${r.model} ${r.variant}
${r.mileage ? `${toNum(r.mileage).toLocaleString('en-PH')} km — ` : ''}${r.city || r.province || 'Metro Manila'}
${priceLine}`
    });

    const sku = String(r.SKU || r.sku || `U${i}`);
    const showOthersBtn = { title: 'Others', payload: 'SHOW_OTHERS' };
    const chooseBtn = { title: `Unit ${i + 1}`, payload: `CHOOSE_${sku}` };

    messages.push({ type: 'buttons', text: `Pili ka:`, buttons: [chooseBtn, showOthersBtn] });
  }

  return { session, messages };
}
