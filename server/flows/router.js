// /server/flows/router.js
// Central conversation router: Phase 1 → Phase 2 → Phase 3 (cash/financing stubs)

import * as Qualifier from './qualifier.js';
import Offers from './offers.js';
import { sendText, sendButtons, flushMessages } from '../lib/messenger.js';
import { nlg } from '../lib/ai.js';

const MEMORY_TTL_DAYS = Number(process.env.MEMORY_TTL_DAYS || 7);

// simple in-memory session (works on single lambda/container lifetime)
const SESSIONS = globalThis.__SESSIONS || (globalThis.__SESSIONS = new Map());
function getSession(psid) {
  const now = Date.now();
  let s = SESSIONS.get(psid);
  if (!s) {
    s = { createdAtTs: now, phase: 'phase1', qualifier: {}, funnel: {} };
    SESSIONS.set(psid, s);
  }
  // TTL
  const ttl = MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000;
  if (!s.createdAtTs || (now - s.createdAtTs) > ttl) {
    s = { createdAtTs: now, phase: 'phase1', qualifier: {}, funnel: {} };
    SESSIONS.set(psid, s);
  }
  return s;
}

function sessionReset(psid) {
  const s = { createdAtTs: Date.now(), phase: 'phase1', qualifier: {}, funnel: {} };
  SESSIONS.set(psid, s);
  return s;
}

async function welcomeBlock(session, isReturning) {
  if (!isReturning) {
    const t = await nlg(
      "Hi! 👋 I’m your BentaCars consultant. Ako na bahala mag-match ng best unit para sa’yo—no need mag-scroll nang mag-scroll. Let’s find your car, fast.",
      { persona: "friendly" }
    );
    return [{ type: 'text', text: t }];
  }
  const txt = await nlg("Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?", { persona: "friendly" });
  return [{
    type: 'buttons',
    text: txt,
    buttons: [
      { title: 'Continue', payload: 'CONTINUE' },
      { title: 'Start over', payload: 'START_OVER' },
    ],
  }];
}

export async function handleMessage({ psid, text, raw, attachments, postback }) {
  const userText = (text || "").trim();
  const payload = (postback?.payload || "").toString();

  let session = getSession(psid);

  // Start-over / Continue handling (returning users)
  if (/^START_OVER$/.test(payload) || /^start over$/i.test(userText)) {
    session = sessionReset(psid);
  }
  if (/^CONTINUE$/.test(payload)) {
    // proceed with current session state
  }

  // Phase 1
  if (session.phase === 'phase1') {
    if (!session._welcomed) {
      const isReturning = !!session._hadInteraction;
      const msgs = await welcomeBlock(session, isReturning);
      await flushMessages(psid, msgs);
      session._welcomed = true;
      session._hadInteraction = true;
      // fall-through to absorb same-turn text
    }

    if (userText) {
      session.qualifier = Qualifier.absorb(session.qualifier, userText);
    }

    if (Qualifier.needPhase1(session.qualifier)) {
      const ask = Qualifier.shortAskForMissing(session.qualifier);
      const toned = await nlg(ask, { persona: "friendly" });
      await sendText(psid, toned);
      return;
    }

    // Completed Phase 1 → move Phase 2
    const sum = Qualifier.summary(session.qualifier);
    const preface = await nlg(
      `Got it. ✅ Here’s what I’ll match:\n• ${sum}\nIche-check ko ang inventory, then ibabalik ko 2 options na swak.`,
      { persona: "friendly" }
    );
    await sendText(psid, preface);

    session.phase = 'phase2';
  }

  // Phase 2 — offers
  if (session.phase === 'phase2') {
    try {
      const step = await Offers(session, userText, raw);
      session = step.session;
      await flushMessages(psid, step.messages);

      if (session.nextPhase === 'cash') {
        session.phase = 'cash';
        await sendText(psid, await nlg("Noted — cash path tayo. (Phase 3A stub here)", { persona: "friendly" }));
        return;
      } else if (session.nextPhase === 'financing') {
        session.phase = 'financing';
        await sendText(psid, await nlg("Financing path tayo. (Phase 3B stub here)", { persona: "friendly" }));
        return;
      }
      return;
    } catch (err) {
      console.error("offers step error", err);
      await sendText(psid, "⚠️ Nagka-issue sa inventory. Try ulit after a moment or adjust filters (e.g., “SUV AT ₱800k QC”).");
      return;
    }
  }

  // Phase 3 stubs
  if (session.phase === 'cash') {
    await sendText(psid, "Cash flow stub: schedule viewing → contact → address. (To be implemented)");
    return;
  }
  if (session.phase === 'financing') {
    await sendText(psid, "Financing flow stub: schedule → contact → address → docs. (To be implemented)");
    return;
  }

  // Fallback
  await sendText(psid, "Sige, tuloy lang tayo. Cash or financing ang plan mo para ma-match ko properly?");
}
