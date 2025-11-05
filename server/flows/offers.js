// server/flows/offers.js
import rules from '../config/rules.json' assert { type: 'json' };
import { fetchMatches } from '../lib/matcher.js';
import { aiConfirmSummary, aiHookForUnit } from '../lib/llm.js';
import { sendText, sendButtons, sendImages } from '../lib/messenger.js';

function imgList(u) {
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const k = u[`image_${i}`];
    if (k) out.push(k);
  }
  return out;
}

function unitLine(u, mode = 'cash') {
  const title = `${u.year || ''} ${u.brand || ''} ${u.model || ''} ${u.variant || ''}`.replace(/\s+/g,' ').trim();
  const loc = [u.city, u.province].filter(Boolean).join(' — ');
  if (mode === 'financing') {
    const range = u.all_in_range || u.all_in || u.allin || '';
    return { title, loc, price: `All-in: ${typeof range==='number' ? `₱${range.toLocaleString()}` : String(range)}` };
  }
  return { title, loc, price: `SRP: ₱${Number(u.srp||0).toLocaleString()} (negotiable upon viewing)` };
}

export async function showOffers({ psid, state }) {
  // Short natural summary
  const summary = await aiConfirmSummary(state);
  await sendText(psid, summary);

  const pool = await fetchMatches(state);
  state._pool = pool;
  if (!pool.length) {
    await sendText(psid, "Walang exact match sa filters na ’to. Pwede kitang i-tryhan ng alternatives — type mo “Others”.");
    return;
  }

  const showFirst = rules.match_show_first || 2;
  const head = pool.slice(0, showFirst);

  for (const u of head) {
    const hook = await aiHookForUnit(u);
    const line = unitLine(u, state.payment === 'financing' ? 'financing' : 'cash');
    const firstImg = imgList(u)[0];
    if (firstImg) await sendImages(psid, [firstImg]);
    await sendText(psid, `${line.title}\n${u.mileage ? `${u.mileage} km — ` : ''}${line.loc}\n${line.price}\n${hook}`);
  }

  const buttons = head.map((u, i) => ({ title: `Unit ${i + 1}`, payload: `CHOOSE_${i + 1}` }));
  if (pool.length > showFirst) buttons.push({ title: 'Others', payload: 'OTHERS' });
  await sendButtons(psid, 'Choose a unit or see Others:', buttons);
  state.phase = 'offers';
}

export async function handleOffersAction({ psid, state, text }) {
  if (/^CHOOSE_(\d+)/i.test(text)) {
    const idx = Number(text.match(/^CHOOSE_(\d+)/i)[1]) - 1;
    const unit = (state._pool || [])[idx];
    if (!unit) return;

    await sendText(psid, "Solid choice! 🔥 Sending full photos…");
    const imgs = imgList(unit);
    if (imgs.length) await sendImages(psid, imgs);

    // Move to Phase 3
    state.phase = state.payment === 'financing' ? 'financing_flow' : 'cash_flow';
    state.chosen_unit = unit;
    return { done: true };
  }

  if (/^OTHERS$/i.test(text)) {
    const pool = state._pool || [];
    const rest = pool.slice(2, 4);
    if (!rest.length) {
      await sendButtons(psid, "Gusto mo bang i-widen ko yung search? Pwede ko i-adjust body type or price range konti.", [
        { title: 'Widen search ✅', payload: 'WIDEN' },
        { title: 'Keep as is ❌', payload: 'KEEP' }
      ]);
      return;
    }
    for (const u of rest) {
      const hook = await aiHookForUnit(u);
      const line = unitLine(u, state.payment === 'financing' ? 'financing' : 'cash');
      const firstImg = imgList(u)[0];
      if (firstImg) await sendImages(psid, [firstImg]);
      await sendText(psid, `${line.title}\n${u.mileage ? `${u.mileage} km — ` : ''}${line.loc}\n${line.price}\n${hook}`);
    }
    await sendButtons(psid, 'Pick a unit or tweak search?', [
      { title: 'Unit 3', payload: 'CHOOSE_3' },
      { title: 'Unit 4', payload: 'CHOOSE_4' },
      { title: 'Widen', payload: 'WIDEN' }
    ]);
  }

  if (/^WIDEN$/i.test(text)) {
    // Loosen filters a bit (dev: your API can accept widen flag)
    state._widen = true;
    await sendText(psid, "Sige, i-widen ko ng konti. Saglit lang… then type mo “Others” ulit to see new set.");
  }
}
