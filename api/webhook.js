import { sendText, sendQuickReplies, sendImage } from '../lib/messenger.js';
import { fetchInventory, extractWants, relaxWants, rankMatches, bestImage, cardText } from '../lib/matching.js';
import { qualifierPrompt, chat, STOP_LINE } from '../lib/llm.js';

const MAX_TURNS = 18;
const sessions = new Map();
const uiState  = new Map();

function historyFor(psid, sys) {
  if (!sessions.has(psid)) sessions.set(psid, [{ role: 'system', content: sys }]);
  return sessions.get(psid);
}
function clamp(arr){ const sys=arr[0]; const tail=arr.slice(-MAX_TURNS*2); return [sys,...tail]; }
function stateFor(psid){ if(!uiState.has(psid)) uiState.set(psid,{stage:'idle'}); return uiState.get(psid); }
const yes = t => /^(yes|yep|sure|sige|ok|okay|game|go|opo|oo|ayos|tara)\b/i.test(t.trim());

export default async function handler(req,res){
  // Verify
  if (req.method === 'GET') {
    const { ['hub.mode']:mode, ['hub.verify_token']:tok, ['hub.challenge']:chal } = req.query;
    if (mode==='subscribe' && tok===process.env.FB_VERIFY_TOKEN) return res.status(200).send(chal);
    return res.status(403).send('Forbidden');
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const sys = await qualifierPrompt();
    const body = req.body;
    if (body.object !== 'page') return res.status(404).send('Not a page');

    for (const entry of body.entry || []) for (const ev of entry.messaging || []) {
      const psid = ev?.sender?.id;
      const text = ev?.message?.text || ev?.postback?.title || '';
      if (!psid || !text) continue;

      const state = stateFor(psid);

      // === Phase 3 state machine (selection + scheduling)
      if (state.stage === 'awaiting_selection') {
        const n = parseInt(text.trim(),10);
        if (Number.isFinite(n) && n>=1 && n<= (state.last?.length||0)) {
          const row = state.last[n-1];
          const img = bestImage(row);
          if (img) await sendImage(psid, img);
          await sendText(psid, `🚗 ${cardText(row, state.wants || {})}`);
          await sendQuickReplies(psid, 'Gusto mo bang i-schedule ang viewing?', ['Schedule viewing','Show other units']);
          state.stage='after_choice'; uiState.set(psid,state); continue;
        }
        if (/see more|more|iba pa/i.test(text)) { await sendText(psid,'Pagination soon. Pili muna sa 1–3.'); continue; }
      } else if (state.stage === 'after_choice') {
        if (/schedule/i.test(text)) { await sendText(psid,'Anong preferred date & time? (e.g., "Fri 3pm")'); state.stage='awaiting_when'; uiState.set(psid,state); continue; }
        if (/show other|iba/i.test(text)) { await sendText(psid,'Sige, pili ka ulit sa list or sabihin mo model.'); state.stage='awaiting_selection'; uiState.set(psid,state); continue; }
      } else if (state.stage === 'awaiting_when') {
        state.schedule = { when: text.trim() }; await sendText(psid,'Pakibigay ang mobile number (e.g., 0917xxxxxxx).'); state.stage='awaiting_phone'; uiState.set(psid,state); continue;
      } else if (state.stage === 'awaiting_phone') {
        state.schedule.phone = text.trim();
        const u = state.lastSelected || state.last?.[0] || {};
        await sendText(psid, `✅ Tentative viewing set!\nUnit: ${u.year||''} ${u.brand||''} ${u.model||''} ${u.variant||''}\nWhen: ${state.schedule.when}\nBuyer: ${state.schedule.phone}\nLocation: ${u.complete_address||u.city||'branch to confirm'}`);
        await sendText(psid, 'Our team will confirm the exact schedule. Anything else?');
        state.stage='idle'; uiState.set(psid,state); continue;
      }

      // === If user says YES after no-match -> relaxed matching immediately
      if (yes(text) && state.stage==='idle' && state.noMatch) {
        const inv = await fetchInventory();
        const wants = relaxWants(extractWants(historyFor(psid,sys), inv));
        const top = rankMatches(inv, wants).slice(0,3);
        if (top.length) {
          await sendText(psid,'Nag-relax ako ng criteria para may maipakita:');
          for (const r of top) { const img=bestImage(r); if (img) await sendImage(psid,img); await sendText(psid, `🚗 ${cardText(r,wants)}`); }
          await sendQuickReplies(psid,'Anong number ang pipiliin mo?',['1','2','3','See more']);
          Object.assign(state,{ stage:'awaiting_selection', last:top, wants, noMatch:false }); uiState.set(psid,state);
        } else { await sendText(psid,'Wala pa rin. Pwede tayong maghanap ng ibang model or budget.'); }
        // fallthrough to LLM ack
      }

      // === Phase 1: LLM conversation
      const hist = historyFor(psid, sys);
      hist.push({ role:'user', content:text });
      const reply = await chat(hist);
      if (reply) { hist.push({ role:'assistant', content:reply }); sessions.set(psid, clamp(hist)); await sendText(psid, reply); }

      // === Phase 2 trigger
      if (reply && reply.includes(STOP_LINE)) {
        try {
          const inv = await fetchInventory();
          const wants = extractWants(hist, inv);
          const top = rankMatches(inv, wants).slice(0,3);
          if (top.length) {
            await sendText(psid,'Ito yung best na swak sa details mo:');
            for (const r of top) { const img=bestImage(r); if (img) await sendImage(psid,img); await sendText(psid, `🚗 ${cardText(r,wants)}`); }
            await sendQuickReplies(psid,'Anong number ang pipiliin mo?',['1','2','3','See more']);
            Object.assign(state,{ stage:'awaiting_selection', last:top, wants, noMatch:false }); uiState.set(psid,state);
          } else {
            await sendText(psid,'Walang exact match. Okay i-expand nang konti ang budget or nearby cities?');
            state.noMatch = true; uiState.set(psid,state);
          }
        } catch (e) {
          console.error('matching error', e);
          await sendText(psid,'Nagkaproblema sa paghanap ng units. Subukan natin ulit mamaya.');
        }
      }
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).send('Server error');
  }
}

export const config = { api: { bodyParser: true } };
