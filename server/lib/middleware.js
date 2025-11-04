// api/lib/middleware.js
import { sendText } from './messenger.js';

// Short Taglish answers; keep human + credible
const replies = {
  legit: "Legit tayo. We work with verified partner dealers nationwide.🙂",
  addressGate: "Full address ibinibigay once ma-lock ang viewing schedule + contact details mo, para ma-prepare ang unit at ma-assist ka nang maayos.",
  lastPrice: "Best to discuss upon viewing—negotiable upon actual inspection. 😉",
  flood: "We screen units. Pwede i-check sa viewing (undercarriage, smell, signs of repair).",
  accident: "Disclosure first policy. Kung may claim/repair history, sasabihin namin.",
  mileage: "We check records/visual cues. Pwede mo ring i-verify sa viewing.",
  warranty: "Unit-specific. Some dealers offer limited warranty; we’ll confirm for you.",
  deliver: "Usually pick-up after payment/release. Delivery—case-to-case depende sa dealer.",
  bank: "We work with multiple financing partners; we’ll route where you have best chance.",
  repo: "May lumalabas minsan; depende sa availability. Sabihin mo kung ok sa’yo.",
  color: "Color depends sa available unit. If may preferred color ka, i-note natin.",
  testdrive: "Pwedeng ma-test, depende sa dealer’s policy. Confirm natin sa viewing.",
  tradein: "Pwede trade-in in many cases. Dalhin mo details sa viewing para ma-appraise.",
  reserve: "May reservation fee sa iba, deductible upon purchase. Confirm natin per unit.",
  ci: "Case-to-case. Send basic docs lang so we can pre-check and advise quickly.",
};

const rules = [
  { key:'legit',      test:/\blegit|totoo ba|scam|registered|dti|sec\b/i },
  { key:'addressGate',test:/\baddress|location|tamang lugar|saan banda\b/i },
  { key:'lastPrice',  test:/\blast price|last na|final price|pwede tawad|can you lower\b/i },
  { key:'flood',      test:/\bflood|baha|nabaha\b/i },
  { key:'accident',   test:/\baccident|na bangga|collision|repair history\b/i },
  { key:'mileage',    test:/\bmileage|odo|odometer|tinamper\b/i },
  { key:'warranty',   test:/\bwarranty|waranti\b/i },
  { key:'deliver',    test:/\bdeliver|delivery|pa-deliver\b/i },
  { key:'bank',       test:/\bbank|financing partner|partner bank\b/i },
  { key:'repo',       test:/\brepo|repossessed\b/i },
  { key:'color',      test:/\bcolor|kulay\b/i },
  { key:'testdrive',  test:/\btest ?drive|test-drive\b/i },
  { key:'tradein',    test:/\btrade ?in|trade-in\b/i },
  { key:'reserve',    test:/\breserve|reservation fee|rsrv\b/i },
  { key:'ci',         test:/\bno ci|without ci|skip ci|credit investigation\b/i },
];

export async function faqMiddleware(psid, session, raw) {
  const txt = String(raw || '');
  for (const r of rules) {
    if (r.test.test(txt)) {
      // Special guard: address ask before contact (Phase 3)
      if (r.key === 'addressGate') {
        const needsGate = (!session.contact || !session.contact.mobile || !session.contact.fullname);
        if (needsGate) {
          await sendText(psid, replies.addressGate);
          return true; // handled
        }
        // if contact complete, let phase handler answer address normally
        return false;
      }
      await sendText(psid, replies[r.key]);
      return true; // handled
    }
  }
  return false; // not handled
}
