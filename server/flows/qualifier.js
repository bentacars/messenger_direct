// server/flows/qualifier.js
import { extractQualifiers } from '../lib/llm.js';
import { sendText, sendButtons } from '../lib/messenger.js';
import { applyExtraction, missingFields } from '../lib/state.js';

export async function phase1({ psid, state, text }) {
  // Use extractor to update state
  const ex = await extractQualifiers(text);
  applyExtraction(state, ex);

  const need = missingFields(state);

  if (need.length === 0) {
    state.phase = 'matching';
    state.pending = 'match';
    return { done: true };
  }

  // Ask only ONE missing thing to sound natural
  const ask = {
    payment: "Sige. Cash or financing ang plan mo?",
    budget: "Para hindi ako lumampas, mga magkano ang budget mo?",
    location: "Saan ka based (city/province) para malapit ang options?",
    transmission: "Auto or manual prefer mo? (Pwede rin 'any'.)",
    body: "Body type mo—sedan, hatchback, SUV/MPV, van o pickup?"
  };

  const key = need[0];
  await sendText(psid, ask[key]);
  state.pending = key;
  return { done: false };
}

export async function welcome({ psid, returning }) {
  if (returning) {
    await sendButtons(psid, "Welcome back! 😊 Itutuloy natin kung saan tayo huli, or start over?", [
      { title: 'Continue', payload: 'Continue' },
      { title: 'Start over', payload: 'Start over' }
    ]);
  } else {
    await sendText(psid, "Hi! 👋 I’m your BentaCars consultant. Ako na bahala mag-match ng best unit para sa’yo—hindi mo na kailangang mag-scroll nang mag-scroll. Let’s find your car, fast.");
  }
}
