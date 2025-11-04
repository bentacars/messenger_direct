// api/flows/offers.js
import { fetchInventory } from '../lib/inventory.js';
import { rank } from '../lib/matcher.js';
import { imageList } from '../lib/photos.js';
import { cashLine, financingLine, monthlyLines } from '../lib/pricing.js';
import { titleLine, subLine } from '../lib/format.js';
import { softHookFor } from '../lib/model.js';
import { sendText, sendImage } from '../lib/messenger.js';

const N = (x)=> Number(String(x ?? '').replace(/[^\d]/g,'')) || 0;

function softFilter(units, slots) {
  // Keep wide gates; let rank() do the heavy lift
  return units.filter(u => {
    if (slots.plan === 'cash' && slots.budget) {
      const srp = N(u.srp); if (!srp) return false;
      if (srp > slots.budget + 200000) return false;
    }
    if (slots.plan === 'financing' && slots.budget) {
      const ai = N(u.all_in); if (!ai) return false;
      if (ai > slots.budget + 200000) return false;
    }
    if (slots.body_type && String(u.body_type||'').toLowerCase() !== String(slots.body_type).toLowerCase()) return false;
    if (slots.transmission && slots.transmission !== 'any') {
      const tx = String(u.transmission||'').toLowerCase();
      if (slots.transmission==='automatic' && !/(a\/?t|automatic|auto)/.test(tx)) return false;
      if (slots.transmission==='manual'    && !/(m\/?t|manual)/.test(tx)) return false;
    }
    return true;
  });
}

function priceBlock(u, plan){
  if (plan==='cash') return cashLine(u);
  return `${financingLine(u)}\n${monthlyLines(u)}`;
}

export async function startOffers(psid, session) {
  const inv = await fetchInventory();
  const subset = softFilter(inv, session.slots);
  const ranked = rank(subset, session.slots);

  // Take top 4; show first 2 first
  const pick = ranked.slice(0, 4);
  session.picks = {
    list: pick.map(u => String(u.SKU || u.sku || `${u.brand}-${u.model}-${u.year}`)),
    shown: [],
    backup: []
  };
  session.picks.backup = session.picks.list.slice(2);

  const first2 = pick.slice(0,2);
  if (!first2.length) {
    await sendText(psid, "Walang exact na pasok sa filters mo — pwede kitang i-widenan ng konti (budget o body type). Type **widen** kung okay.");
    session.phase = 'p2_pick';
    return;
  }

  for (let i=0;i<first2.length;i++){
    const u = first2[i];
    session.picks.shown.push(session.picks.list[i]);

    const imgs = imageList(u);
    if (imgs[0]) await sendImage(psid, imgs[0]);

    const hook = (await softHookFor(u)) || '';
    const msg = [
      titleLine(u),
      subLine(u),
      priceBlock(u, session.slots.plan),
      hook
    ].filter(Boolean).join('\n');

    await sendText(psid, msg);
  }

  await sendText(psid, first2.length === 1
    ? `Type **1** to proceed sa unit na ito, or type **others** para alternatives.`
    : `Pili ka: type **1** or **2**. Kung gusto mo pang iba, type **others**.`);

  session.phase = 'p2_pick';
}

export async function pickOrOthers(psid, session, userText) {
  const t = String(userText||'').trim().toLowerCase();
  const inv = await fetchInventory();
  const bySku = new Map(inv.map(u => [String(u.SKU||u.sku||''), u]));

  if (t === 'others') {
    const backSkus = session.picks?.backup?.slice(0,2) || [];
    if (!backSkus.length) {
      await sendText(psid, "Walang naka-prepare na back-up. Gusto mo bang i-widen natin? Type **widen**.");
      return;
    }
    for (const sku of backSkus) {
      const u = bySku.get(String(sku));
      if (!u) continue;

      const imgs = imageList(u);
      if (imgs[0]) await sendImage(psid, imgs[0]);

      const hook = (await softHookFor(u)) || '';
      const msg = [
        titleLine(u),
        subLine(u),
        priceBlock(u, session.slots.plan),
        hook
      ].filter(Boolean).join('\n');

      await sendText(psid, msg);
    }
    await sendText(psid, `Type **1**, **2**, **3**, or **4** to pick. (Order based on messages above)`);
    return;
  }

  if (t === 'widen') {
    await sendText(psid, `Sige, i-widen ko ng konti. Ano mas gusto mong i-relax: **body type** or **budget**?`);
    return;
  }

  // numeric choice
  const n = Number(t);
  if (Number.isInteger(n) && n>=1 && n<=4) {
    const sku = session.picks?.list?.[n-1];
    const u = sku ? bySku.get(String(sku)) : null;
    if (!u) { await sendText(psid, "Medyo na-delay. Paki-type ulit yung number."); return; }

    session.chosen = { sku, unit: u };

    // send gallery (image_1..image_10)
    const imgs = imageList(u);
    if (imgs.length) {
      await sendText(psid, "Nice choice! 🔥 Sending full photos…");
      for (const url of imgs) await sendImage(psid, url);
    }

    // go to Phase 3 based on plan
    session.phase = (session.slots.plan === 'cash') ? 'p3_cash' : 'p3_fin';
    return;
  }

  // fallback
  await sendText(psid, `Type **1** or **2**, or **others** para ibang options.`);
}
