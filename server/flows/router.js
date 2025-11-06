// server/flows/router.js
// LLM-first policy: model writes the reply, we keep light guardrails & matching trigger.

import { planWithLLM, mergeSlots, isGoodEnough, summarizeSlots } from "./qualifier.js";
import { matchUnits, formatUnitReply } from "./offers.js";
import { handleCashFlow } from "./cash.js";
import { handleFinancingFlow } from "./financing.js";
import { handleInterrupts } from "../lib/interrupts.js";

export async function router(ctx) {
  const { psid, text = "", state = {} } = ctx;
  const replies = [];
  const now = Date.now();

  // hydrate session
  const s = {
    phase: state.phase || "qualifying",
    slots: state.slots || {},
    history: state.history || "",       // short rolling summary (optional)
    last_seen_at: state.last_seen_at || now,
    last_phase: state.last_phase || "qualifying",
    last_ask: state.last_ask || null,   // { field, count }
    _offeredUnits: state._offeredUnits || [],
    _backupUnits: state._backupUnits || [],
    _welcomed: state._welcomed || false,
  };

  // 0) interrupts (FAQ/objection/small-talk)
  const interrupt = await handleInterrupts(text, s);
  if (interrupt) {
    replies.push({ type: "text", text: interrupt.reply });
    if (interrupt.resume) replies.push({ type: "text", text: interrupt.resume });
    return { replies, newState: { ...s, last_seen_at: now } };
  }

  // 1) re-entry handling
  const returning = state.last_seen_at && (now - state.last_seen_at < 7 * 864e5);
  if (!s._welcomed) {
    if (returning && Object.keys(s.slots).length) {
      replies.push({
        type: "buttons",
        text: `Welcome back! 😊 Continue (“${summarizeSlots(s.slots)}”) or start over?`,
        buttons: [
          { type: "postback", title: "Continue", payload: "CONTINUE_FLOW" },
          { type: "postback", title: "Start over", payload: "START_OVER" },
        ],
      });
      s._welcomed = true;
      return { replies, newState: { ...s, last_seen_at: now } };
    }
    replies.push({ type: "text", text: "Hello! I’ll help you find the best unit, mabilis at human—not checklist. 🚗" });
    s._welcomed = true;
  }

  // explicit resets
  if (/START_OVER/.test(text) || /^start( over)?$/i.test(text) || /reset/i.test(text)) {
    const fresh = { phase: "qualifying", slots: {}, history: "", _welcomed: true, last_seen_at: now };
    replies.push({ type: "text", text: "Fresh start tayo. 👍" });
    return { replies, newState: fresh };
  }
  if (/CONTINUE_FLOW/.test(text)) {
    replies.push({ type: "text", text: "Sige, itutuloy ko kung saan tayo huli. Saglit lang…" });
  }

  // 2) Let the LLM decide the move for this turn (it writes the reply)
  const plan = await planWithLLM({
    userText: text,
    slots: s.slots,
    lastAsk: s.last_ask,
    history: s.history,
  });

  // Merge any extracted slots
  s.slots = mergeSlots(s.slots, plan.updated_slots);
  s.last_seen_at = now;

  // Anti-loop: if model keeps asking the same field, increment count; if >1 we’ll bias to proceed/check matches next turn
  if (plan.ask_next) {
    if (s.last_ask?.field === plan.ask_next) {
      s.last_ask = { field: plan.ask_next, count: (s.last_ask.count || 0) + 1 };
    } else {
      s.last_ask = { field: plan.ask_next, count: 1 };
    }
  }

  // 3) Decide if we should match now: model suggestion OR our guard says it's good enough
  const wantMatch = Boolean(plan.proceed_to_matching) || isGoodEnough(s.slots) || (s.last_ask?.count >= 2);

  // Always send the LLM-crafted reply text first (human, AAL)
  if (plan.reply_text) replies.push({ type: "text", text: plan.reply_text });

  if (s.phase === "qualifying" && wantMatch) {
    s.phase = "matching";
  }

  // 4) Matching flow
  if (s.phase === "matching") {
    const { mainUnits, backupUnits } = await matchUnits(s.slots);

    if ((mainUnits?.length || 0) === 0 && (backupUnits?.length || 0) === 0) {
      // graceful fallback—ask for two most useful hints
      replies.push({ type: "text", text: "Para tumama pa lalo, share mo lang budget range at location—mabilis ko i-aadjust." });
      s.phase = "qualifying";
      s.last_ask = { field: "budget", count: 1 };
      return { replies, newState: s };
    }

    s._offeredUnits = mainUnits;
    s._backupUnits  = backupUnits;

    for (const u of (mainUnits || []).slice(0, 2)) {
      replies.push(await formatUnitReply(u, s.slots.payment));
    }
    replies.push({
      type: "buttons",
      text: "Gusto mong i-view alin dito? Pwede ring ‘Others’ para dagdagan ko pa.",
      buttons: [
        ...(mainUnits || []).slice(0, 2).map((u, i) => ({ type: "postback", title: `Unit ${i + 1}`, payload: `UNIT_PICK_${u.SKU}` })),
        { type: "postback", title: "Others", payload: "SHOW_OTHERS" },
      ],
    });
    return { replies, newState: s };
  }

  // 5) Cash / Financing specialized flows (kept for Phase 3 after unit pick)
  if (s.phase === "cash")       return await handleCashFlow({ ctx, replies, newState: s, text });
  if (s.phase === "financing")  return await handleFinancingFlow({ ctx, replies, newState: s, text });

  // Default: keep conversing in qualifying with the LLM-crafted reply
  return { replies, newState: s };
}

export { router as route };
