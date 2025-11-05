// /server/flows/router.js
// Central conversation router: Phase 1 (qualifiers) → Phase 2 (offers) → Phase 3 (cash/financing)

import * as Qualifier from "./qualifier.js";
import * as Offers from "./offers.js";
import * as CashFlow from "./cash.js";
import * as FinancingFlow from "./financing.js";
import { nlgLine } from "../lib/ai.js";

const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);

// simple in-memory session store
const SESS = new Map();

function isStale(ts) {
  const ttl = MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000;
  return !ts || Date.now() - ts > ttl;
}

function needPhase1(qual) {
  return !(qual?.payment && qual?.budget && qual?.location && qual?.transmission && qual?.bodyType);
}

function humanAskMissing(qual) {
  if (!qual.payment)
    return "We can do cash or hulugan — alin ang mas okay sa’yo?";
  if (!qual.budget)
    return "Para hindi ako lumagpas, mga magkano ang target budget mo?";
  if (!qual.location)
    return "Nationwide tayo — saan ka nakabase para ma-match ko sa pinakamalapit?";
  if (!qual.transmission)
    return "Automatic, manual, or ok lang kahit alin?";
  if (!qual.bodyType)
    return "5-seater sedan/hatch, 7-seater MPV/SUV, or van/pickup ang hanap mo?";
  return "";
}

function summaryLine(qual) {
  const prefs = [];
  if (qual.brand) prefs.push(qual.brand);
  if (qual.model) prefs.push(qual.model);
  if (qual.variant) prefs.push(qual.variant);
  if (qual.year) prefs.push(String(qual.year));
  const prefStr = prefs.length ? `\n• Pref: ${prefs.join(" ")}` : "";
  return [
    "Alright, ito’ng hahanapin ko for you:",
    `• ${qual.payment === "cash" ? "Cash buyer" : "Financing"}`,
    `• Budget ~ ₱${(qual.budget||0).toLocaleString()}`,
    `• Location: ${qual.location}`,
    `• Trans: ${qual.transmission}`,
    `• Body: ${qual.bodyType}${prefStr}`
  ].join("\n");
}

function initSession(psid, firstName="") {
  const now = Date.now();
  const session = {
    psid,
    createdAtTs: now,
    phase: "phase1",
    qualifier: {},
    funnel: {},
    _welcomed: false,
    name: firstName || ""
  };
  SESS.set(psid, session);
  return session;
}

export function getSession(psid, firstName="") {
  const s = SESS.get(psid);
  if (!s || isStale(s.createdAtTs)) return initSession(psid, firstName);
  if (firstName && !s.name) s.name = firstName;
  return s;
}

function welcomeBlock(session) {
  const who = session.name ? ` ${session.name}` : "";
  if (!session._welcomed) {
    session._welcomed = true;
    return [{
      type: "text",
      text: `Hi${who}! 👋 I’m your BentaCars consultant. Ako na bahala mag-match ng best unit para sa’yo.`
    }];
  }
  return [{
    type: "buttons",
    text: `Welcome back${who}! 😊 Itutuloy natin kung saan tayo huli, or start over?`,
    buttons: [
      { title: "Continue", payload: "CONTINUE" },
      { title: "Start over", payload: "start over" }
    ]
  }];
}

export async function route(session, userText, rawEvent) {
  const messages = [];
  const txt = String(userText || "");
  const payload = rawEvent?.postback?.payload ? String(rawEvent.postback.payload).toLowerCase() : "";

  // Reset flow if user tapped start over
  if (payload === "start over") {
    session.phase = "phase1";
    session.qualifier = {};
    session.funnel = {};
    session._welcomed = false;
  }

  // Phase 1: welcome + collect qualifiers in any order
  if (session.phase === "phase1") {
    // welcome block
    if (!session._welcomed) messages.push(...welcomeBlock(session));

    // absorb any qualifiers from this text
    if (txt) {
      try {
        session.qualifier = Qualifier.absorb(session.qualifier, txt);
      } catch (e) {
        console.warn("qualifier.absorb error", e);
      }
    }

    // ask only the missing one (with LLM tone)
    if (needPhase1(session.qualifier)) {
      const rawAsk = humanAskMissing(session.qualifier);
      const ask = await nlgLine(
        `User said: "${txt}". We need to ask just this missing item, warm Taglish: "${rawAsk}"`,
        rawAsk
      );
      messages.push({ type: "text", text: ask });
      return { session, messages };
    }

    // Summarize + move to offers
    const sum = summaryLine(session.qualifier);
    messages.push({ type: "text", text: `${sum}\nSaglit, I’ll pull the best units that fit this. 🔎` });
    session.phase = "phase2";
  }

  // Phase 2: offers
  if (session.phase === "phase2") {
    const step = await Offers.step(session, userText, rawEvent);
    messages.push(...step.messages);
    session = step.session;

    if (session.nextPhase === "cash") session.phase = "cash";
    else if (session.nextPhase === "financing") session.phase = "financing";
    else return { session, messages };
  }

  // Phase 3A: Cash path
  if (session.phase === "cash") {
    const step = await (CashFlow.step?.(session, userText, rawEvent) || Promise.resolve({ session, messages: [{ type:"text", text:"(Cash flow coming soon)"}]}));
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  // Phase 3B: Financing path
  if (session.phase === "financing") {
    const step = await (FinancingFlow.step?.(session, userText, rawEvent) || Promise.resolve({ session, messages: [{ type:"text", text:"(Financing flow coming soon)"}]}));
    messages.push(...step.messages);
    session = step.session;
    return { session, messages };
  }

  // Fallback
  messages.push({ type: "text", text: "Sige, tuloy lang tayo. Cash or financing ang plan mo para ma-match ko properly?" });
  session.phase = "phase1";
  return { session, messages };
}

// Public entry used by webhook
export async function handleMessage({ psid, text, raw, attachments, postback, firstName }) {
  let session = getSession(psid, firstName || "");
  const result = await route(session, text, { ...raw, attachments, postback });
  // persist
  SESS.set(psid, result.session);
  return result.messages;
}

export default { handleMessage };
