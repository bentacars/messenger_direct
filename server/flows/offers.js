// server/flows/offers.js
import { MATCH_DELTA_ALLIN, MATCH_DELTA_CASH, FIRST_BATCH, MAX_OFFERS } from '../constants.js';
import { saveSession } from '../lib/session.js';
import { sendImage, sendQuick, sendText } from '../lib/messenger.js';
import { oneLineHook } from '../lib/ai.js';

const INVENTORY_API_URL = process.env.INVENTORY_API_URL;

async function fetchInventory() {
  const res = await fetch(INVENTORY_API_URL, { method:'GET' });
  if (!res.ok) throw new Error(`Inventory API ${res.status}`);
  return res.json(); // expect array of rows with headers from your sheet
}

function keepImages(u) {
  const imgs = [];
  for (let i=1;i<=10;i++){
    const k = `image_${i}`;
    if (u[k]) imgs.push(u[k]);
  }
  return imgs;
}

function priceFilter(u, qual) {
  if (qual.payment === 'cash') {
    const b = Number(qual.budgetCash||0);
    if (!b || !u.srp) return false;
    const srp = Number(u.srp||0);
    return srp >= (b - MATCH_DELTA_CASH) && srp <= (b + MATCH_DELTA_CASH);
  } else {
    const b = Number(qual.budgetAllIn||0);
    if (!b || !u.all_in) return false;
    const allin = Number(u.all_in||0);
    return allin <= (b + MATCH_DELTA_ALLIN);
  }
}

function strongMatch(u, pref) {
  if (!pref) return true;
  const m = (u.model||'').toLowerCase();
  const b = (u.brand||'').toLowerCase();
  const v = (u.variant||'').toLowerCase();
  const wantM = (pref.model||'').toLowerCase();
  const wantB = (pref.brand||'').toLowerCase();
  const wantV = (pref.variant||'').toLowerCase();
  if (wantB && !b.includes(wantB)) return false;
  if (wantM && !m.includes(wantM)) return false;
  if (wantV && !v.includes(wantV)) return false;
  return true;
}

function transMatch(u, trans) {
  if (!trans || trans==='any') return true;
  const t = (u.transmission||'').toUpperCase();
  return t.includes(trans.toUpperCase());
}

function bodyMatch(u, body) {
  if (!body) return true;
  const b = (u.body_type||'').toLowerCase();
  return b.includes(body.toLowerCase());
}

function rankUnits(pool, qual) {
  // priority first, then ok_to_market
  const priority = pool.filter(u => String(u.price_status||'').toLowerCase().includes('priority'));
  const okm = pool.filter(u => String(u.price_status||'').toLowerCase().includes('ok'));
  const rest = pool.filter(u => !priority.includes(u) && !okm.includes(u));
  return [...priority, ...okm, ...rest].slice(0, MAX_OFFERS);
}

export async function buildPool(qual) {
  const all = await fetchInventory();
  const filtered = all.filter(u =>
    priceFilter(u, qual) &&
    transMatch(u, qual.trans) &&
    bodyMatch(u, qual.body) &&
    strongMatch(u, qual.modelPref)
  );
  return rankUnits(filtered, qual);
}

function unitTitle(u) {
  const yr = u.year ? `${u.year} ` : '';
  const trans = (u.transmission||'').toUpperCase();
  return `${yr}${u.brand||''} ${u.model||''} ${u.variant||''} ${trans}`.replace(/\s+/g,' ').trim();
}

function unitSubtitle(u, qual) {
  const km = u.mileage ? `${u.mileage} km` : '';
  const city = u.city || u.province || '';
  const line1 = [km, city].filter(Boolean).join(' — ');
  let line2 = '';
  if (qual.payment === 'cash') {
    if (u.srp) line2 = `SRP: ₱${Number(u.srp).toLocaleString()} (negotiable upon viewing)`;
  } else {
    const rr = [u['2yrs'], u['3yrs'], u['4yrs']].filter(Boolean).map(n => Number(n));
    const range = rr.length? `${Math.min(...rr).toLocaleString()}–${Math.max(...rr).toLocaleString()}` : '';
    const allin = u.all_in ? `All-in: ₱${Number(u.all_in).toLocaleString()}` : '';
    line2 = [allin, range?`Monthly: ₱${range}`:'', '(estimate only)'].filter(Boolean).join(' ');
  }
  return { line1, line2 };
}

export async function step({ psid, session, userText }) {
  // INITIALIZE on first entry
  if (!session.offers || !Array.isArray(session.offers.pool)) {
    const pool = await buildPool(session.qualifiers || {});
    session.offers = { pool, page: 0 };
    await saveSession(psid, session);

    // Summary before offers
    const q = session.qualifiers || {};
    const summary =
      `Alright, ito ang hahanapin ko for you:\n` +
      `• Payment: ${q.payment==='cash'?'Cash':'Financing'}\n` +
      `• ${q.payment==='cash' ? `Budget: ₱${(q.budgetCash||0).toLocaleString()}` : `All-in: ₱${(q.budgetAllIn||0).toLocaleString()}`}\n` +
      `• Location: ${q.locationCity||q.locationProvince||'—'}\n` +
      `• Body: ${q.body||'—'}\n` +
      `• Trans: ${q.trans||'—'}\n` +
      `${q.modelPref?.model ? `• Pref: ${q.modelPref.model}\n` : ''}` +
      `Saglit, I’ll pull the best units that fit this. 🔎`;
    await sendText(psid, summary);
  }

  const pool = session.offers.pool || [];
  if (!pool.length) {
    await sendText(psid, 'Walang exact match sa filters na ’to. Gusto mong i-relax natin nang konti or hanap ng similar models? Type mo: "Others".');
    return;
  }

  const start = session.offers.page * FIRST_BATCH;
  const batch = pool.slice(start, start + FIRST_BATCH);

  // Show each unit with image + hook line
  for (const u of batch) {
    const images = keepImages(u);
    if (images[0]) await sendImage(psid, images[0]);

    const title = unitTitle(u);
    const sub = unitSubtitle(u, session.qualifiers||{});
    let hook = '';
    try {
      hook = await oneLineHook({
        brand: u.brand, model: u.model, variant: u.variant,
        body_type: u.body_type, transmission: u.transmission
      });
    } catch {}
    const text =
`${title}
${sub.line1 || ''}
${sub.line2 || ''}
${hook ? hook : ''}`.trim();
    await sendText(psid, text);
  }

  // Quick replies: current batch units + Others (if more)
  const buttons = [];
  batch.forEach((u, idx) => buttons.push({ title: `Unit ${start+idx+1}`, payload: `CHOOSE:${u.SKU || u.sku || u.Sku || u.sku_id || u.id}` }));
  if (start + FIRST_BATCH < pool.length) buttons.push({ title: 'Others', payload: 'SHOW_OTHERS' });
  await sendQuick(psid, 'Pili ka:', buttons);
}

export async function showOthers({ psid, session }) {
  if (!session.offers?.pool) return sendText(psid, 'Sige, check ko ulit yung iba.');
  session.offers.page = (session.offers.page || 0) + 1;
  await saveSession(psid, session);
  return step({ psid, session });
}

export function findUnitBySku(session, sku) {
  const all = session.offers?.pool || [];
  return all.find(u => String(u.SKU||u.sku||u.sku_id||u.id) === String(sku));
}

export function unitImages(u) {
  const arr = [];
  for (let i=1;i<=10;i++){
    const k = `image_${i}`;
    if (u[k]) arr.push(u[k]);
  }
  return arr;
}
