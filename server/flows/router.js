// server/flows/router.js
// LLM-first policy: model writes the reply; we keep light guardrails & matching trigger.

import { planWithLLM, mergeSlots, isGoodEnough, summarizeSlots } from "./qualifier.js";
import { matchUnits, formatUnitReply } from "./offers.js";
import { handleCashFlow } from "./cash.js";
import { handleFinancingFlow } from "./financing.js";
import { handleInterrupts } from "../lib/interrupts.js";

const REQUIRED = ["payment", "budget", "location", "transmission", "bodyType"];
const OPTIONAL_PREFS = ["brand", "model", "variant", "year", "color", "coding"]; // captured and passed to matcher

export async function router(ctx) {
  const { psid, text = "", attachments = [], state = {} } = ctx;
  const replies = [];
  const now = Date.now();

  // hydrate session
  const s = {
    phase: state.phase || "qualifying",
    slots: state.slots || {},
    history: state.history || [],        // short rolling summary (optional)
    last_seen_at: state.last_seen_at || now,
    last_phase: state.last_phase || "qualifying",
    last_ask: state.last_ask || null,    // { field, count }
    offeredUnits: state.offeredUnits || [],
    backupUnits: state.backupUnits || [],
    welcomed: state.welcomed || false,
  };

  // 0) interrupts (FAQ/objection/small-talk)
  const interrupt = await handleInterrupts(text, s);
  if (interrupt) {
    replies.push({ type: "text", text: interrupt.reply });
    if (interrupt.resume) replies.push({ type: "text", text: interrupt.resume });
    return { replies, newState: { ...s, last_seen_at: now } };
  }

  // 1) re-entry handling (welcome once)
  const returning = state.last_seen_at && (now - state.last_seen_at < 7 * 864e5);
  if (!s.welcomed) {
    s.welcomed = true;
    if (returning && Object.keys(s.slots).length) {
      replies.push({
        type: "buttons",
        text: "Welcome back! Continue where we left off, or start over?",
        buttons: [
          { type: "postback", title: "Continue", payload: "CONTINUE_FLOW" },
          { type: "postback", title: "Start over", payload: "START_OVER" },
        ],
      });
      return { replies, newState: { ...s, last_seen_at: now } };
    }
    replies.push({
      type: "text",
      text: "Hi! 👋 BentaCars AI here — tutulungan kitang mahanap ang swak na unit, mabilis at diretsuhan. Taglish tayo para human & clear. 😊",
    });
  }

  // handle start over
  if (/^start over$/i.test(text) || text === "START_OVER") {
    return {
      replies: [{ type: "text", text: "Sige, from the top tayo. Sagutin ko lang isa-isa para tumama agad. 😊" }],
      newState: { phase: "qualifying", slots: {}, history: [], last_seen_at: now, welcomed: true },
    };
  }
  if (/^continue$/i.test(text) || text === "CONTINUE_FLOW") {
    replies.push({ type: "text", text: "Got it — tuloy tayo where we left off. 👍" });
  }

  // 2) Let the model read the latest user message and update slots / decide next ask
  //    planWithLLM should:
  //    - extract newly mentioned fields (incl. optional prefs),
  //    - decide next field to ask,
  //    - write a short human/AAL reply (reply_text)
  const plan = await planWithLLM({
    text,
    priorSlots: s.slots,
    requiredKeys: REQUIRED,
    optionalKeys: OPTIONAL_PREFS,
  });

  // merge extracted slots (never lose what we already had)
  if (plan?.slots) {
    s.slots = mergeSlots(s.slots, plan.slots);
  }

  // Always send the LLM-crafted reply text first (human, AAL) when present
  if (plan?.reply_text) {
    replies.push({ type: "text", text: plan.reply_text });
  }

  // 3) Gate: do NOT match until ALL required qualifiers are present
  const missing = REQUIRED.filter((k) => !s.slots[k] || String(s.slots[k]).trim() === "");
  if (missing.length > 0) {
    // Ask only the next missing one (LLM already decided — plan.ask_next)
    // If the model didn’t pick one (rare), just choose the first missing.
    const nextField = plan?.ask_next || missing[0];
    // Nudge the model to ask precisely for that one field next time
    s.last_ask = { field: nextField, count: (s.last_ask?.field === nextField ? (s.last_ask.count || 0) + 1 : 1) };
    // Stay in qualifying until all fields complete
    s.phase = "qualifying";
    return { replies, newState: { ...s, last_seen_at: now } };
  }

  // 4) All fields complete → move to matching
  s.phase = "matching";

  const { mainUnits = [], backupUnits = [] } = await matchUnits(s.slots);

  // If no units matched, keep it human: ask LLM to suggest a gentle adjustment (but remain in qualifying)
  if (mainUnits.length === 0 && backupUnits.length === 0) {
    // Let the model craft a polite, specific adjustment ask (no hardcoded text)
    const retryPlan = await planWithLLM({
      text: "", // let it use the current slots to compose a helpful nudge
      priorSlots: s.slots,
      requiredKeys: REQUIRED,
      optionalKeys: OPTIONAL_PREFS,
      intent: "no_results_adjustment",
    });
    if (retryPlan?.reply_text) {
      replies.push({ type: "text", text: retryPlan.reply_text });
    } else {
      // ultra-safe fallback (rarely used)
      replies.push({
        type: "text",
        text: "Medyo wala pang exact match. Pwede ba nating i-adjust ng kaunti ang budget, body type, o brand para may ma-suggest ako?",
      });
    }
    s.phase = "qualifying";
    s.last_ask = { field: retryPlan?.ask_next || "budget", count: 1 };
    return { replies, newState: { ...s, last_seen_at: now } };
  }

  // 5) Have matches — show up to 2 first, then ask which to view
  s.offeredUnits = mainUnits;
  s.backupUnits = backupUnits;

  for (const u of mainUnits.slice(0, 2)) {
    replies.push(await formatUnitReply(u, s.slots.payment));
  }

  const btns = mainUnits.slice(0, 2).map((u, i) => ({
    type: "postback",
    title: `Unit ${i + 1}`,
    payload: `UNIT_PICK_${u.SKU}`,
  }));
  btns.push({ type: "postback", title: "Others", payload: "SHOW_OTHERS" });

  replies.push({
    type: "buttons",
    text: "Alin gusto mong i-view? Pwede ring “Others” para dagdagan ko pa. 🙂",
    buttons: btns,
  });

  // 6) Specialized flows (kept for Phase 3 after unit pick)
  if (s.phase === "cash")   return await handleCashFlow({ ctx, replies, newState: s, text });
  if (s.phase === "financing") return await handleFinancingFlow({ ctx, replies, newState: s, text });

  return { replies, newState: { ...s, last_seen_at: now } };
}

export { router as route };
