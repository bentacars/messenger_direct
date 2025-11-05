// Central conversation router (Phase 1 → Phase 2 → Phase 3)
// Uses Qualifier.* (your existing module) and Offers.step()

import * as Qualifier from "./qualifier.js";
import * as Offers from "./offers.js";
import { sendText, sendButtons, sendImage, sendCarousel, sendTypingOn, sendTypingOff } from "../lib/messenger.js";
import { nlgLine } from "../lib/ai.js";

const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);

// In-memory session store (works fine for dev)
const SESS = new Map();

function isStale(ts) {
  const ttl = MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000;
  return !ts || Date.now() - ts > ttl;
}

function needPhase1(qual) {
  return !(qual?.payment && qual?.budget && qual?.location && qual?.transmission && qual?.bodyType);
}

function shortAskForMissing(qual) {
  if (!qual.payment)  return "Pwede cash or hulugan—alin ang mas okay sa’yo?";
  if (!qual.budget)   return "Para hindi ako lumagpas, mga magkano ang target budget mo?";
  if (!qual.location) return "Nationwide tayo—saan ka based para ma-match ko sa pinakamalapit?";
  if (!qual.transmission) return "Automatic, manual, or ok lang kahit alin?";
  if (!qual.bodyType) return "Body type mo—sedan, 7-seater/MPV/SUV, or van/pickup?";
  return null;
}

function welcomeBlock(session) {
  const firstTime = !session.createdAtTs || isStale(session.createdAtTs);
  if (firstTime) {
    return [{
      type: "text",
      text: "Hi! 👋 I’m your BentaCars consultant. Ako na bahala mag-match ng best unit—hindi mo na kailangang mag-scroll. Let’s find your car fast."
    }];
  }
  return [{
    type: "buttons",
    text: "Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?",
    buttons: [
      { title: "Continue", payload: "CONTINUE" },
      { title: "Start over", payload: "START_OVER" }
    ]
  }];
}

async function deliver(psid, out = []) {
  for (const m of out) {
    if (m.type === "text") await sendText(psid, m.text);
    else if (m.type === "buttons") await sendButtons(psid, m.text, m.buttons);
    else if (m.type === "image") await sendImage(psid, m.url);
    else if (m.type === "carousel") await sendCarousel(psid, m.elements);
  }
}

export async function handleMessage({ psid, text, raw, attachments }) {
  await sendTypingOn(psid);

  // load session
  const now = Date.now();
  let session = SESS.get(psid) || {
    createdAtTs: now,
    phase: "phase1",
    qualifier: {},
    funnel: {}
  };

  // navigation buttons
  const payload = (raw?.postback?.payload || "").toString();
  if (payload === "START_OVER") {
    session = { createdAtTs: now, phase: "phase1", qualifier: {}, funnel: {} };
  } else if (payload === "CONTINUE") {
    // keep session as is
  }

  const out = [];

  // Phase 1: welcome + collect qualifiers
  if (session.phase === "phase1") {
    if (!session._welcomed) {
      out.push(...welcomeBlock(session));
      session._welcomed = true;
    }

    // absorb any info from this turn
    if (text) session.qualifier = Qualifier.absorb(session.qualifier, text);

    if (needPhase1(session.qualifier)) {
      const ask = shortAskForMissing(session.qualifier);
      const prompt = `User said: "${text}". We need to ask ONLY this missing item in a warm Taglish line: "${ask}"`;
      const nlg = await nlgLine(prompt, ask);
      out.push({ type: "text", text: nlg });
      await deliver(psid, out);
      SESS.set(psid, session);
      await sendTypingOff(psid);
      return;
    }

    // summarize then move to phase2
    const sum = Qualifier.summary(session.qualifier);
    out.push({ type: "text", text: `Alright, ito’ng hahanapin ko for you:\n${sum}\nSaglit, I’ll pull the best units that fit this. 🔎` });
    session.phase = "phase2";
  }

  // Phase 2: offers
  if (session.phase === "phase2") {
    const step = await Offers.step(session, text, raw);
    out.push(...step.messages);
    session = step.session;

    if (session.nextPhase === "cash") session.phase = "cash";
    else if (session.nextPhase === "financing") session.phase = "financing";
    else {
      await deliver(psid, out);
      SESS.set(psid, session);
      await sendTypingOff(psid);
      return;
    }
  }

  // Phase 3 placeholders (you can wire your own flows)
  if (session.phase === "cash") {
    out.push({ type: "text", text: "Proceeding with cash path—iset natin viewing schedule at contact details. 👌" });
    await deliver(psid, out);
    SESS.set(psid, session);
    await sendTypingOff(psid);
    return;
  }
  if (session.phase === "financing") {
    out.push({ type: "text", text: "Proceeding with financing path—kuha tayo ng contact details at i-run ko ang approval steps. 👌" });
    await deliver(psid, out);
    SESS.set(psid, session);
    await sendTypingOff(psid);
    return;
  }

  // fallback
  out.push({ type: "text", text: "Sige, tuloy lang tayo. Cash or financing ang plan mo?" });
  await deliver(psid, out);
  SESS.set(psid, session);
  await sendTypingOff(psid);
}

export default { handleMessage };
