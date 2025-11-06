// server/flows/router.js
// LLM-first policy: model writes the reply; we keep light guardrails & strict matching trigger.

import { matchUnits, formatUnitReply } from "./offers.js";
import { handleCashFlow } from "./cash.js";
import { handleFinancingFlow } from "./financing.js";
import { handleInterrupts } from "../lib/interrupts.js";
import { planWithLLM, mergeSlots, summarizeSlots, hasAllCore } from "./qualifier.js";

const CORE_FIELDS = ["payment", "budget", "location", "transmission", "bodyType"];
const OPTIONAL_PREFS = ["brand", "model", "variant", "year", "color", "coding"];

export async function router(ctx) {
  const { psid, text = "", attachments = [], state = {} } = ctx;
  const replies = [];
  const now = Date.now();

  // --- hydrate session ---
  const s = {
    phase: state.phase || "qualifying",
    slots: state.slots || {},
    history: state.history || [],       // optional running summary
    last_seen_at: state.last_seen_at || now,
    last_phase: state.last_phase || "qualifying",
    last_ask: state.last_ask || null,   // { field, count }
    offeredUnits: state.offeredUnits || [],
    backupUnits: state.backupUnits || [],
    welcomed: state.welcomed || false,
  };

  // --- 0) interrupts (FAQ / objection / small-talk) ---
  const interrupt = await handleInterrupts(text, s);
  if (interrupt) {
    replies.push({ type: "text", text: interrupt.reply });
    if (interrupt.resume) replies.push({ type: "text", text: interrupt.resume });
    return { replies, newState: { ...s, last_seen_at: now } };
  }

  // --- 1) re-entry handling / welcome ---
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

  // Start over / continue
  if (/^start over$/i.test(text) || text === "START_OVER") {
    return {
      replies: [{ type: "text", text: "Sige, from the top tayo. Sagutin ko lang isa-isa para tumama agad. 😊" }],
      newState: { phase: "qualifying", slots: {}, history: [], last_seen_at: now, welcomed: true },
    };
  }
  if (/^continue$/i.test(text) || text === "CONTINUE_FLOW") {
    replies.push({ type: "text", text: "Got it — tuloy tayo where we left off. 👍" });
  }

  // --- 2) Let the model update slots + craft the single next ask (AAL) ---
  const plan = await planWithLLM({
    userText: text,
    slots: s.slots,
    lastAsk: s.last_ask,
    history: s.history?.slice(-6).join(" • ") || "",
  });

  // merge newly extracted slots (don’t overwrite confirmed ones)
  if (plan?.updated_slots) {
    s.slots = mergeSlots(s.slots, plan.updated_slots);
  }

  // Always send the LLM-crafted reply text first (human, AAL)
  if (plan?.reply_text) {
    replies.push({ type: "text", text: plan.reply_text });
  }

 // --- 3) STRICT gate: only match when ALL core fields are present (any order) ---
const wantMatch = hasAllCore(s.slots);   // <-- NEW guard

if (!wantMatch) {
  // still qualifying — steer the model to the ONE missing field
  const missing = CORE_FIELDS.filter(k => !s.slots[k] || String(s.slots[k]).trim() === "");
  const nextField = plan?.ask_next || missing[0] || null;

  if (nextField) {
    s.last_ask = {
      field: nextField,
      count: s.last_ask?.field === nextField ? (s.last_ask.count || 0) + 1 : 1,
    };
  }

  s.phase = "qualifying";
  return { replies, newState: { ...s, last_seen_at: now } };
}


  // --- 4) All fields complete → matching ---
  s.phase = "matching";

  const { mainUnits = [], backupUnits = [] } = await matchUnits(s.slots);

  // No matches → ask LLM to craft a gentle adjustment (still human, no hardcoded loop)
  if (mainUnits.length === 0 && backupUnits.length === 0) {
    const nudge = await planWithLLM({
      userText: "Walang exact match — please craft a gentle adjustment ask based on current slots.",
      slots: s.slots,
      lastAsk: s.last_ask,
      history: s.history?.slice(-6).join(" • ") || "",
    });
    if (nudge?.reply_text) {
      replies.push({ type: "text", text: nudge.reply_text });
    } else {
      replies.push({
        type: "text",
        text: "Medyo wala pang exact match. Pwede ba nating i-adjust ng kaunti ang budget, body type, o brand para may ma-suggest ako?",
      });
    }
    s.phase = "qualifying";
    // hint model where to go next (budget is often the flexible lever)
    s.last_ask = { field: nudge?.ask_next || "budget", count: 1 };
    return { replies, newState: { ...s, last_seen_at: now } };
  }

  // --- 5) Show up to 2 units, then ask which to view ---
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

  // --- 6) Specialized flows (kept for Phase 3 after unit pick) ---
  if (s.phase === "cash")        return await handleCashFlow({ ctx, replies, newState: s, text });
  if (s.phase === "financing")   return await handleFinancingFlow({ ctx, replies, newState: s, text });

  return { replies, newState: { ...s, last_seen_at: now } };
}

export { router as route };
