// server/flows/offers.js
import { INVENTORY_HEADERS as H, BODY_TYPES } from '../constants.js';
import { sendImage, sendGenericTemplate, sendText } from '../lib/messenger.js';

const INV_URL = process.env.INVENTORY_API_URL || '';

async function fetchInventory() {
  const r = await fetch(INV_URL);
  if (!r.ok) throw new Error(`Inventory fetch ${r.status}`);
  return r.json();
}

function takeImages(row) {
  const imgs = [];
  for (let i=1;i<=10;i++){
    const key = `image_${i}`;
    const url = row[key] || row[H[key]]; // support either direct key or mapped
    if (url) imgs.push(url);
  }
  return imgs;
}

function withinCash(srp, budget) {
  if (!srp || !budget) return false;
  const delta = Math.abs(Number(srp) - Number(budget));
  return delta <= 50000; // ±₱50k
}

function withinFinancing(allIn, cashOut) {
  if (!allIn || !cashOut) return false;
  return Number(allIn) <= (Number(cashOut) + 50000);
}

function scoreRow(row, q) {
  let score = 0;
  // priority flag
  if ((row.price_status || '').toLowerCase().includes('priority')) score += 100;
  if ((row.price_status || '').toLowerCase().includes('ok')) score += 10;

  // match strong preferences
  if (q.pref_brand && row.brand?.toLowerCase() === q.pref_brand.toLowerCase()) score += 10;
  if (q.pref_model && row.model?.toLowerCase() === q.pref_model.toLowerCase()) score += 8;
  if (q.pref_variant && row.variant?.toLowerCase().includes(q.pref_variant.toLowerCase())) score += 5;
  if (q.pref_year && String(row.year) === String(q.pref_year)) score += 5;

  // transmission
  if (q.transmission && q.transmission !== 'any') {
    if ((row.transmission || '').toLowerCase().startsWith(q.transmission[0])) score += 6;
    else score -= 4;
  }

  // body type
  if (q.body_type && q.body_type !== 'any') {
    if ((row.body_type || '').toLowerCase() === q.body_type.toLowerCase()) score += 6;
    else score -= 3;
  }

  // pricing rule
  if (q.payment === 'cash' && withinCash(row.srp, q.budget_number)) score += 20;
  if (q.payment === 'financing' && withinFinancing(row.all_in, q.budget_number)) score += 20;

  // geo nudge
  if (q.location_city && row.city && row.city.toLowerCase().includes(q.location_city.toLowerCase())) score += 3;

  return score;
}

function quickHook(row) {
  const model = (row.model || '').toLowerCase();
  if (model.includes('vios')) return 'Matipid, mura maintenance ✅';
  if (model.includes('mirage')) return '3-cyl → super tipid sa gas ✅';
  if (model.includes('innova')) return '7-seater, pang pamilya (diesel) ✅';
  if (model.includes('everest')) return 'Malakas hatak, mataas ground clearance ✅';
  if (model.includes('mirage g4')) return 'City driving friendly ✅';
  return 'Clean & ready to view ✅';
}

function unitText(row, q) {
  const title = `${row.year} ${row.brand} ${row.model}${row.variant ? ' ' + row.variant : ''}`.trim();
  const loc = [row.city, row.province].filter(Boolean).join(', ');
  const km = row.mileage ? `${Number(row.mileage).toLocaleString()} km` : '';
  if (q.payment === 'cash') {
    return `${title}
${km} — ${loc}
SRP: ₱${Number(row.srp || 0).toLocaleString()} (negotiable upon viewing)
${quickHook(row)}`;
  }
  return `${title}
${km} — ${loc}
All-in: ₱${Number(row.all_in || 0).toLocaleString()} (subject for approval)
Standard 20–30% DP, naka all-in promo tayo this month.`;
}

export default {
  async step(session, userText) {
    // Handle gallery triggers
    const chooseMatch = /^CHOOSE_(.+)$/.exec(userText);
    const morePhotos = /^PHOTOS_(.+)$/.exec(userText);
    const others = userText === 'SHOW_OTHERS';

    if (chooseMatch || morePhotos) {
      const sku = (chooseMatch?.[1] || morePhotos?.[1] || '').trim();
      const row = session.offers?.pool?.find(x => (x.SKU || x.sku) === sku);
      if (!row) return { message: 'Oops—na-miss ko yung item na ‘yun. Paki try ulit 🙏' };

      const imgs = takeImages(row);
      if (imgs.length >= 2) {
        // Carousel
        const elements = imgs.slice(0, 10).map(url => ({
          title: `${row.brand} ${row.model}`,
          image_url: url,
          subtitle: `${row.year} • ${row.color || ''}`.trim()
        }));
        await sendGenericTemplate(session.psid, elements);
      } else if (imgs.length === 1) {
        await sendImage(session.psid, imgs[0]);
      } else {
        await sendText(session.psid, 'Walang extra photos sa record, pero pwede natin i-view sa showroom.');
      }
      return { message: null };
    }

    if (!session.offers) session.offers = { page: 0, pool: [] };

    // Build / refresh pool from inventory when first entering offers
    if (!session.offers.pool.length || others) {
      const inv = await fetchInventory();

      // Normalize keys for easier access, assume rows are objects with the sheet headers
      let rows = Array.isArray(inv) ? inv : inv.rows || [];
      // Filter: not locked
      rows = rows.filter(r => String(r.lock_flag || '').toLowerCase() !== 'y');

      // Price rule
      const q = session.qualifier;
      const scored = rows
        .filter(r => {
          // body/trans filters if specified
          if (q.body_type && q.body_type !== 'any' && (r.body_type || '').toLowerCase() !== q.body_type) return false;
          if (q.transmission && q.transmission !== 'any') {
            const rt = (r.transmission || '').toLowerCase();
            if (q.transmission === 'automatic' && !rt.startsWith('a')) return false;
            if (q.transmission === 'manual' && !rt.startsWith('m')) return false;
          }
          // Cash / financing
          if (q.payment === 'cash') return withinCash(r.srp, q.budget_number);
          return withinFinancing(r.all_in, q.budget_number);
        })
        .map(r => ({ row: r, score: scoreRow(r, q) }))
        .sort((a,b) => b.score - a.score)
        .map(x => x.row);

      // Priority → OK to Market tiering already considered in score
      session.offers.pool = scored.slice(0, 4);
      session.offers.page = 0;
    }

    // Render 2 at a time
    const start = session.offers.page * 2;
    const slice = session.offers.pool.slice(start, start + 2);

    if (!slice.length) {
      return { message: `Walang exact match sa filters na ‘to. Pwede kitang i-tryhan ng alternatives — type mo "Others".` };
    }

    // Send each unit message with buttons
    for (const r of slice) {
      const img = takeImages(r)[0];
      if (img) await sendImage(session.psid, img);
      const text = unitText(r, session.qualifier);
      const sku = r.SKU || r.sku;
      await sendButtons(session.psid, text, [
        { type: 'postback', title: 'Unit 1', payload: `CHOOSE_${sku}` },
        { type: 'postback', title: 'Others', payload: 'SHOW_OTHERS' },
        { type: 'postback', title: 'Photos', payload: `PHOTOS_${sku}` }
      ]);
    }

    // Advance page for next "Others"
    session.offers.page += 1;
    return { message: null };
  }
};
