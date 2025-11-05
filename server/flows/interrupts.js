// server/flows/interrupts.js
import { sendText } from '../lib/messenger.js';
import { nlg } from '../lib/ai.js';

const intents = [
  { key: 'tradein', re: /(trade[\s-]?in|i-trade in|i trade)/i,
    reply: 'Yes, we accept trade-ins depende sa appraisal — usually ginagawa during viewing.' },
  { key: 'lastprice', re: /(last\s*price|final price|tawad|lower\s*price)/i,
    reply: 'Negotiable po upon actual viewing, lalo na kung cash. Depende sa unit condition assessment.' },
  { key: 'lowerdp', re: /(lower\s*dp|baba\s*dp|downpayment\s*pwede\s*lower)/i,
    reply: 'Minsan nababawasan ang cash-out after review. Best kung makapag-send kayo ng basic docs para ma-assess agad.' },
  { key: 'location', re: /(saan|san)\s+(loc|location|branch|kayo)|address/i,
    reply: 'We share full address pagkatapos ma-secure ang viewing slot (name + mobile), para ma-prepare agad ang unit pagdating nyo.' },
  { key: 'mekaniko', re: /(mekaniko|mechanic|test\s*drive)/i,
    reply: 'Pwede magdala ng mekaniko at mag-test drive during scheduled viewing, basta available ang unit.' },
  { key: 'legit', re: /(legit|totoo|scam)/i,
    reply: 'We’re partnered with multiple dealers nationwide and follow standard processes — you’re in good hands 🙂' },
  { key: 'warranty', re: /(warranty|waranty)/i,
    reply: 'Warranty depends on the unit/dealer. May mga unit na may dealer/extended options — we’ll confirm sa viewing.' },
  { key: 'timeline', re: /(gaano\s*katagal|timeline|approval)/i,
    reply: 'Typical approval 1–3 days pag kumpleto ang docs. I’ll guide you para mapabilis.' },
  { key: 'insurance', re: /(kasama\s*insurance|insurance)/i,
    reply: 'Insurance options available depende sa unit at package — ma-e-explain during processing.' },
  { key: 'reservation', re: /(reserve|reservation\s*fee)/i,
    reply: 'Pwede mag-reserve with fee once decided/verified. Mas okay after viewing or at least basic ID check.' },
  { key: 'delivery', re: /(deliver|ipa-deliver|delivery)/i,
    reply: 'Pwede ipa-deliver after processing/approval. Coordinate natin schedule once ready.' },
  { key: 'docs', re: /(requirements|reqs|docu|document|co-?maker)/i,
    reply: 'Basic docs lang to start (ID, income proof). Co-maker depende sa profile — we’ll advise after pre-check.' },
  { key: 'unit_history', re: /(flooded|casa|record|mileage\s*real)/i,
    reply: 'We promote transparency. We’ll verify on viewing and share what’s known for the unit.' },
];

export async function handleInterrupts(psid, text, resumeLine) {
  if (!text) return { handled:false };
  const found = intents.find(i => i.re.test(text));
  if (!found) return { handled:false };

  const bridge = resumeLine ? `\n${resumeLine}` : '';
  const reply = `${found.reply}${bridge ? `\n${bridge}` : ''}`;
  await sendText(psid, reply);
  return { handled:true };
}

// LLM fallback for off-topic chitchat (keeps it short then resume)
export async function handleSmallTalk(psid, text, resumeLine) {
  const out = await nlg({
    user: `User says: "${text}". Reply in 1 short Taglish line, friendly. Then add: "${resumeLine}".`,
    context: 'You are assisting in buying a used car. Keep it short and warm.'
  });
  await sendText(psid, out);
  return { handled: true };
}
