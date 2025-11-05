// /server/flows/offers.js
// Phase 2 — match up to 4 units (Priority → OK to Market).
// Show 2 first; "Others" reveals the backup 2.
// When a unit is chosen, send a photo CAROUSEL (image_1..image_10), then move to next phase.

const INVENTORY_API_URL = process.env.INVENTORY_API_URL || '';

export async function step(session, userText, rawEvent) {
  const messages = [];
  const payload = getPayload(rawEvent);
  const t = String(userText || '').toLowerCase();

  session.funnel = session.funnel || {};
  session._offers = session._offers || { page: 0, pool: [], tier: '' };

  // Paging
  if (payload === 'SHOW_OTHERS' || /\bothers?\b/.test(t)) {
    session._offers.page = (session._offers.page || 0) + 1;
  }

  const qual = session.qualifier || {};
  const { pool, error } = await buildPool(qual); // up to 4 units, tiered + ranked

  if (error) {
    messages.push({
      type: 'text',
      text: `⚠️ Nagka-issue sa inventory: ${error}. Try ulit after a moment or adjust filters (e.g., “SUV AT ₱800k QC”).`
    });
    return { session, messages };
  }
  if (!pool.length) {
    messages.push({
      type: 'text',
      text: 'Walang exact match sa filters na ’to. Pwede kitang i-tryhan ng alternatives — type mo “Others”.'
    });
    return { session, messages };
  }

  // Save latest pool (max 4)
  session._offers.pool = pool.slice(0, 4);

  // 2 per page
  const PAGE_SIZE = 2;
  const start = (session._offers.page || 0) * PAGE_SIZE;
  let slice = session._offers.pool.slice(start, start + PAGE_SIZE);
  if (!slice.length) {
    session._offers.page = 0;
    slice = session._offers.pool.slice(0, PAGE_SIZE);
  }

  // "More photos" intent OR explicit unit pick
  const pickPayload = payload && payload.startsWith('CHOOSE_') ? payload.replace(/^CHOOSE_/, '') : '';
  const wantMorePhotos = /^(more\s+(photos|pics|images)|lahat\s+ng\s+photos|gallery)$/i.test(String(userText || '').trim());

  if (pickPayload || wantMorePhotos) {
    const chosen = pickPayload
      ? session._offers.pool.find(x => x.SKU === pickPayload)
      : session.funnel?.unit?.raw;

    if (chosen) {
      session.funnel.unit = { id: chosen.SKU, label: fmtTitle(chosen), raw: chosen };

      messages.push({ type: 'text', text: 'Solid choice! 🔥 Sending full photos…' });

      const images = getAllImages(chosen);
      if (images.length) {
        const elements = images.slice(0, 10).map((url, i) => ({
          title: i === 0 ? fmtTitle(chosen) : `Photo ${i + 1}`,
          image_url: url,
          buttons: (i === 0 && chosen.drive_link)
            ? [{ type: 'web_url', title: 'Details', url: chosen.drive_link }]
            : []
        }));
        messages.push({ type: 'generic', elements }); // Messenger "generic" carousel
      } else {
        messages.push({ type: 'text', text: 'Walang extra photos uploaded for this unit yet. Pwede kong i-request sa dealer. 🙏' });
      }

      // Auto-transition based on Phase 1 payment
      const pay = (qual.payment || '').toLowerCase();
      if (pay === 'cash' || pay === 'financing') {
        session.nextPhase = pay === 'cash' ? 'cash' : 'financing';
      } else {
        messages.push({
          type: 'buttons',
          text: 'Proceed ka ba via Cash or Financing?',
          buttons: [
            { title: 'Cash', payload: 'CASH' },
            { title: 'Financing', payload: 'FINANCING' },
          ],
        });
      }
      return { session, messages };
    }
  }

  // Show 2 units as separate messages (not a product carousel)
  for (const unit of slice) {
    if (unit.image_1) messages.push({ type: 'image', url: unit.image_1 });

    const isCash = (qual.payment || '').toLowerCase() === 'cash';
    const line1 = `${fmtTitle(unit)}\n${fmtMileageLoc(unit)}`;
    const line2 = isCash
      ? (unit.srp ? `SRP: ₱${money(unit.srp)} (negotiable upon viewing)` : '')
      : (unit.all_in ? `All-in: ₱${money(unit.all_in)} (subject for approval)` : 'All-in available (subject for approval)');
    const hook = quickHook(unit);

    messages.push({ type: 'text', text: [line1, line2, hook].filter(Boolean).join('\n') });
  }

  // Buttons: Unit X labels reflect absolute index in pool
  const btns = [];
  slice.forEach((u, idx) => {
    btns.push({ title: `Unit ${start + idx + 1}`, payload: `CHOOSE_${u.SKU}` });
  });
  btns.push({ title: 'Others', payload: 'SHOW_OTHERS' });
  messages.push({ type: 'buttons', text: 'Pili ka:', buttons: btns });

  // Optional branch if user types payment here
  if (payload === 'CASH' || /\bcash\b/.test(t)) {
    session.nextPhase = 'cash';
    messages.push({ type: 'text', text: 'Sige, Cash path tayo. I-schedule natin ang viewing.' });
    return { session, messages };
  }
  if (payload === 'FINANCING' || /financ(ing|e)/.test(t)) {
    session.nextPhase = 'financing';
    messages.push({ type: 'text', text: 'Okay, financing. Ico-collect ko muna ilang details for pre-qual.' });
    return { session, messages };
  }

  return { session, messages };
}

/* ============================ Strong Wants Helpers =========================== */
// Extract explicit brand/model/year/variant preference from Phase 1
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

/* ============================ Pool builder ============================== */
// - Pulls from INVENTORY_API_URL
// - Applies strong wants as filters when present
// - Applies hidden pricing rules based on payment + budget
// - Builds up to 4 items total, prioritizing "Priority" tier first, then "OK to Market"
async function buildPool(qual) {
  if (!INVENTORY_API_URL) return { pool: [], error: 'INVENTORY_API_URL missing' };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(INVENTORY_API_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { pool: [], error: `HTTP ${res.status}` };
    const raw = await res.json();
    let items = (Array.isArray(raw) ? raw : raw?.items || []).map(normalizeFromSheet);

    // Strong wants filter
    const want = strongWants(qual);
    if (hasStrongWants(want)) {
      items = items.filter(u =>
        (!want.brand   || eq(u.brand, want.brand)) &&
        (!want.model   || eq(u.model, want.model)) &&
        (!want.year    || String(u.year) === String(want.year)) &&
        (!want.variant || contains(u.variant, want.variant))
      );
    }

    // Hidden Phase-1 rules + soft filters
    const filtered = items.filter(u => softPhase1Filter(u, qual));

    // Partition by price_status
    const pri  = filtered.filter(u => isPriority(u.price_status));
    const okm  = filtered.filter(u => isOKtoMarket(u.price_status));
    const rest = filtered.filter(u => !isPriority(u.price_status) && !isOKtoMarket(u.price_status));

    // Score within tier
    const order = arr => arr
      .map(u => ({ u, s: scoreUnit(u, qual) }))
      .sort((A, B) => B.s - A.s)
      .map(x => x.u);

    let a = order(pri);
    let b = order(okm);
    let c = order(rest);

    // Build pool: first 2 from Priority (else OKM), then backup 2 from same tier; if underfilled, borrow others.
    const pool = [];
    const take = (arr, n) => { const out = arr.slice(0, n); arr.splice(0, n); return out; };

    // first 2
    if (a.length >= 2)      pool.push(...take(a, 2));
    else if (b.length >= 2) pool.push(...take(b, 2));
    else                    pool.push(...take(a, 2), ...take(b, 2), ...take(c, 2));

    // backup 2
    if (pool.length < 4 && a.length) pool.push(...take(a, Math.min(2, 4 - pool.length)));
    if (pool.length < 4 && b.length) pool.push(...take(b, Math.min(2, 4 - pool.length)));
    if (pool.length < 4 && c.length) pool.push(...take(c, Math.min(2, 4 - pool.length)));

    return { pool: uniqueBySKU(pool).slice(0, 4), error: null };
  } catch (e) {
    return { pool: [], error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch error') };
  }
}

/* ============================ Filters/Scoring =========================== */

// Phase-1 hidden rule + soft filters
function softPhase1Filter(u, qual = {}) {
  const pay  = (qual.payment || '').toLowerCase(); // 'cash' or 'financing'
  const bud  = toNum(qual.budget);
  const body = (qual.bodyType || '').toLowerCase();
  const trans= (qual.transmission || '').toLowerCase();
  const loc  = (qual.location || '').toLowerCase();

  // Body/trans if specified
  if (body && body !== 'any' && !eq(u.body_type, body)) return false;
  if (trans && trans !== 'any' && !eq(u.transmission, trans)) return false;

  // Hidden price rules
  if (bud > 0) {
    if (pay === 'cash') {
      const srp = u.srp || 0;
      if (Math.abs(srp - bud) > 50_000) return false; // ± ₱50k
    } else if (pay === 'financing') {
      const ai = u.all_in || 0;
      if (!(ai > 0 && ai <= bud + 50_000)) return false; // ≤ budget + ₱50k
    }
  }

  // Location fuzzy (if provided)
  if (loc) {
    const locs = [u.city, u.province, u.ncr_zone].map(x => (x || '').toLowerCase());
    if (!locs.some(x => x && (x.includes(loc) || loc.includes(x)))) return false;
  }

  return true;
}

function scoreUnit(u, qual = {}) {
  let s = 0;
  // Body/trans affinity
  if (qual.bodyType && qual.bodyType !== 'any') s += eq(u.body_type, qual.bodyType) ? 6 : -2;
  if (qual.transmission && qual.transmission !== 'any') s += eq(u.transmission, qual.transmission) ? 4 : -2;

  // Budget closeness
  const bud = toNum(qual.budget);
  const pay = (qual.payment || '').toLowerCase();
  if (bud > 0) {
    if (pay === 'cash' && u.srp) {
      const diff = Math.abs(u.srp - bud);
      if (diff <= 20_000) s += 6;
      else if (diff <= 50_000) s += 3;
      else if (diff <= 100_000) s += 1;
      else s -= 2;
    }
    if (pay === 'financing' && u.all_in) {
      if (u.all_in <= bud + 50_000) s += 6;
      else s -= 2;
    }
  }

  // Location proximity
  if (qual.location) {
    const want = (qual.location || '').toLowerCase();
    const locs = [u.city, u.province, u.ncr_zone].map(x => (x || '').toLowerCase());
    if (locs.some(x => x && (x.includes(want) || want.includes(x)))) s += 3;
  }

  // Recency + newer year bonus
  if (u.updated_at) s += 1;
  if (u.year) s += Math.min(3, Math.max(0, +u.year - 2015) * 0.2);

  return s;
}

/* ============================== Normalization =========================== */

function normalizeFromSheet(src = {}) {
  const safe = k => (src[k] ?? '').toString().trim();

  const obj = {
    SKU: safe('SKU'),
    plate_number: safe('plate_number'),
    year: safe('year'),
    brand: safe('brand'),
    model: safe('model'),
    variant: safe('variant'),
    transmission: safe('transmission').toLowerCase(),
    fuel_type: safe('fuel_type'),
    body_type: safe('body_type').toLowerCase(),
    color: safe('color'),
    mileage: toNum(safe('mileage')),
    video_link: safe('video_link'),
    drive_link: safe('drive_link'),
    image_1: safe('image_1') || placeholder(),
    image_2: safe('image_2'),
    image_3: safe('image_3'),
    image_4: safe('image_4'),
    image_5: safe('image_5'),
    image_6: safe('image_6'),
    image_7: safe('image_7'),
    image_8: safe('image_8'),
    image_9: safe('image_9'),
    image_10: safe('image_10'),
    dealer_price: toNum(safe('dealer_price')),
    srp: toNum(safe('srp')),
    term2: toNum(safe('2yrs')),
    term3: toNum(safe('3yrs')),
    term4: toNum(safe('4yrs')),
    all_in: toNum(safe('all_in')),
    price_status: safe('price_status'),
    complete_address: safe('complete_address'),
    city: safe('city'),
    province: safe('province'),
    ncr_zone: safe('ncr_zone'),
    search_key: safe('search_key'),
    lock_flag: safe('lock_flag'),
    brand_model: safe('brand_model'),
    updated_at: safe('updated_at'),
    markup_rate: safe('markup_rate'),
  };

  obj.title = fmtTitle(obj);
  obj.locationText = [obj.city, obj.province || obj.ncr_zone].filter(Boolean).join(', ');
  return obj;
}

/* ============================== Render helpers ========================== */

function fmtTitle(u) { return [u.year, u.brand, u.model, u.variant].filter(Boolean).join(' '); }
function fmtMileageLoc(u) {
  const m = u.mileage ? `${numberWithCommas(u.mileage)} km` : '';
  const loc = u.locationText || [u.city, u.province || u.ncr_zone].filter(Boolean).join(', ');
  return [m, loc].filter(Boolean).join(' — ');
}

function quickHook(u) {
  const model = (u.model || '').toLowerCase();
  if (/vios/.test(model)) return 'Matipid sa gas, mura maintenance ✅';
  if (/innova/.test(model)) return '7-seater, pang-pamilya, diesel tipid ✅';
  if (/mirage/.test(model)) return '3-cyl → super tipid sa gas ✅';
  if (/city/.test(model)) return 'Matipid sa gas, good for city driving 🚗';
  if (/fortuner|everest/.test(model)) return 'Malakas hatak, mataas ground clearance 🛞';
  return 'Parts are easy to find, high resale demand 👍';
}

function getAllImages(u) {
  const keys = ['image_1','image_2','image_3','image_4','image_5','image_6','image_7','image_8','image_9','image_10'];
  return keys.map(k => u[k]).filter(Boolean);
}

/* ============================== Utils =================================== */

function getPayload(evt) {
  const p = evt?.postback?.payload;
  return typeof p === 'string' ? p : '';
}
function toNum(v) {
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function numberWithCommas(x) {
  return String(Math.round(Number(x) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function money(n) { return numberWithCommas(n); }
function eq(a, b) { return (a || '').toString().trim().toLowerCase() === (b || '').toString().trim().toLowerCase(); }
function contains(a, b) { return (a || '').toLowerCase().includes((b || '').toLowerCase()); }
function placeholder() { return 'https://via.placeholder.com/600x400?text=Unit'; }
function uniqueBySKU(arr) {
  const seen = new Set();
  return arr.filter(x => {
    const k = x.SKU || '';
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function isPriority(ps = '') {
  const v = (ps || '').toLowerCase();
  return v.includes('priority');
}
function isOKtoMarket(ps = '') {
  const v = (ps || '').toLowerCase();
  return v.includes('ok') && v.includes('market');
}

export default { step };
