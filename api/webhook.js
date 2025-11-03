// api/webhook.js (Vercel Node runtime - req/res)
import {
  sendText,
  sendQuickReplies,
  sendImage,
  sendGallery,
  buildImageElements,
  isRestart,
  isGreeting,
} from './lib/messenger.js';

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const INVENTORY_API_URL = process.env.INVENTORY_API_URL;
const MODEL_DEFAULT = process.env.MODEL_DEFAULT || 'gpt-4.1';
const TEMP_DEFAULT = Number(process.env.TEMP_DEFAULT || '0.30');

const sessions = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function freshSession() {
  return { phase: 'qualifying', collected: {}, last: Date.now(), offerShown: false, lastMatches: [], page: 0 };
}
function getSession(id) {
  let s = sessions.get(id);
  if (!s || Date.now() - s.last > SESSION_TTL_MS) { s = freshSession(); sessions.set(id, s); }
  return s;
}
function resetSession(id) { const s = freshSession(); sessions.set(id, s); return s; }

function lower(s){return (s||'').toString().trim().toLowerCase();}
function num(x){ if(x==null)return null; const n=Number((x+'').replace(/[^\d.]/g,'')); return Number.isFinite(n)?n:null;}

function parsePayload(entry){
  const m = entry.messaging?.[0];
  if(!m) return {};
  return {
    senderId: m.sender?.id,
    text: m.message?.text,
    payload: m.postback?.payload || m.message?.quick_reply?.payload || null,
    raw: m
  };
}

async function askPayment(id){
  await sendQuickReplies(id,"Una: Cash ba o Financing ang plan mo? 🙂",[
    {title:"Cash",payload:"PAYMENT_CASH"},
    {title:"Financing",payload:"PAYMENT_FINANCING"},
    {title:"Undecided",payload:"PAYMENT_UNDECIDED"},
  ]);
}
async function askBudgetCash(id){ await sendText(id,"Magkano ang budget range mo (cash)? Hal: ₱450k to ₱600k."); }
async function askDownpayment(id){ await sendText(id,"Magkano ang ready cash out (downpayment)? Hal: ₱150k."); }
async function askLocation(id){ await sendText(id,"Saan location ninyo? (city/province)"); }
async function askModel(id){ await sendText(id,"May preferred model ka ba? (Hal: Vios, NV350). Puwede ring 'any sedan/SUV'."); }
async function askTransmission(id){
  await sendQuickReplies(id,"Transmission?",[
    {title:"Automatic",payload:"TX_AT"},
    {title:"Manual",payload:"TX_MT"},
    {title:"Any",payload:"TX_ANY"},
  ]);
}

function hasEnough(c){
  const havePayment = !!c.payment;
  const haveBudget = (c.payment==='cash' && (c.budget_cash_min||c.budget_cash_max)) ||
                     (c.payment==='financing' && c.downpayment);
  const haveLocation = !!c.location;
  return havePayment && haveBudget && haveLocation;
}

function extractBudget(text){
  const t=(text||'').toLowerCase();
  const rr=t.match(/(\d[\d,.]*)\s*(k|m)?\s*(?:-|to|–|—)\s*(\d[\d,.]*)\s*(k|m)?/i);
  const scale=(v,s)=>{let n=Number((v+'').replace(/[^\d.]/g,'')); if(!Number.isFinite(n))return null; if(s==='k')n*=1e3; if(s==='m')n*=1e6; return Math.round(n);};
  if(rr){return{min:scale(rr[1],rr[2]||''),max:scale(rr[3],rr[4]||'')};}
  const r1=t.match(/(\d[\d,.]*)\s*(k|m)?/i);
  if(r1){return{min:scale(r1[1],r1[2]||''),max:null};}
  return {};
}

async function fetchInventory(){
  const res = await fetch(INVENTORY_API_URL,{method:'GET',headers:{'Cache-Control':'no-cache'}});
  if(!res.ok) throw new Error(`Inventory HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.items)?data.items:[];
}

function scoreAndPick(items,col){
  const pay=col.payment, tx=(col.transmission||'any').toLowerCase();
  const wantModel=lower(col.model||''), loc=lower(col.location||'');
  let filtered=items.filter(it=>{
    if(String(it.lock_flag||'').toUpperCase()==='Y') return false;
    if(pay==='cash'){
      const price=num(it.srp); const min=col.budget_cash_min||0, max=col.budget_cash_max||Infinity;
      if(price&&(price<min||price>max)) return false;
    } else if(pay==='financing'){
      const allIn=num(it.all_in), dp=col.downpayment?Number(col.downpayment):0;
      if(allIn && dp && allIn>dp) return false;
    }
    if(tx!=='any'){
      const invTx=lower(it.transmission||''); const want=tx==='at'?'a':'m';
      if(!(invTx.includes('a')&&want==='a') && !(invTx.includes('m')&&want==='m')) return false;
    }
    if(wantModel){
      const joined=`${it.brand||''} ${it.model||''} ${it.variant||''}`.toLowerCase();
      if(!joined.includes(wantModel)) return false;
    }
    return true;
  });

  filtered=filtered.map(it=>{
    let score=0;
    const status=(it.price_status||'').toLowerCase();
    if(status.includes('priority')) score+=1000;
    if(loc){
      const locJoined=`${it.city||''} ${it.province||''} ${it.complete_address||''}`.toLowerCase();
      if(locJoined.includes(loc)) score+=50;
    }
    const mileage=num(it.mileage)||0; score+=Math.max(0,500-Math.min(500,mileage/100));
    const year=Number(it.year||0); score+=Math.max(0,(year-2000));
    return {...it,__score:score};
  });

  filtered.sort((a,b)=>b.__score-a.__score);
  return filtered.slice(0,2);
}

function titleLine(it){
  const yr=it.year?`${it.year} `:''; const name=`${yr}${it.brand||''} ${it.model||''} ${it.variant||''}`.replace(/\s+/g,' ').trim();
  return `🚗 ${name}`;
}
function priceLine(it,col){
  if(col.payment==='cash'){ const p=num(it.srp); return `Cash: ₱${(p||0).toLocaleString('en-PH')}`; }
  const a=num(it.all_in); return `All-in: ₱${(a||0).toLocaleString('en-PH')}`;
}
function metaLine(it){
  const city=it.city||it.province||''; const km=num(it.mileage); const kmTxt=Number.isFinite(km)?`${km.toLocaleString('en-PH')} km`:'';
  return `${city}${kmTxt?` — ${kmTxt}`:''}`;
}

async function sendTwoOffers(senderId,matches,col,session){
  if(!matches.length){
    await sendText(senderId,"Walang exact match. Okay ba i-expand ng kaunti ang budget o nearby cities para may maipakita ako?");
    return;
  }
  await sendText(senderId,"Ito yung best na swak sa details mo (priority muna).");
  for(const it of matches){
    const img=it.image_1||it.image1||it.image||null;
    if(img) await sendImage(senderId,img);
    const msg=`${titleLine(it)}\n${priceLine(it,col)}\n${metaLine(it)}`;
    await sendText(senderId,msg);
  }
  session.lastMatches=matches; session.offerShown=true; session.last=Date.now();
  const qrs=matches.map((it,idx)=>({title:`${(it.year||'')} ${it.brand||''} ${it.model||''}`.trim().slice(0,20)||`Option ${idx+1}`,payload:`SELECT_UNIT:${it.SKU||it.sku||`IDX${idx}`}`}));
  qrs.push({title:"Show other units",payload:"SHOW_OTHERS"});
  qrs.push({title:"Start over",payload:"RESTART"});
  await sendQuickReplies(senderId,"Anong pipiliin mo?",qrs);
}
function findBySku(session,sku){
  return (session.lastMatches||[]).find(u=>String(u.SKU||u.sku||'').trim()===sku);
}

// ---- helpers for Node runtime body parsing ----
async function readBody(req){
  if (req.body) return req.body;
  return await new Promise((resolve)=>{
    let data=''; req.on('data',ch=>data+=ch);
    req.on('end',()=>{ try{ resolve(data?JSON.parse(data):null);}catch{ resolve(null);} });
  });
}

export default async function handler(req, res){
  try{
    // GET verify
    if(req.method==='GET'){
      const mode=req.query?.['hub.mode'] ?? new URL(req.url, 'http://x').searchParams.get('hub.mode');
      const token=req.query?.['hub.verify_token'] ?? new URL(req.url, 'http://x').searchParams.get('hub.verify_token');
      const challenge=req.query?.['hub.challenge'] ?? new URL(req.url, 'http://x').searchParams.get('hub.challenge');
      if(mode==='subscribe' && token===VERIFY_TOKEN){
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    // POST
    const body = await readBody(req);
    if(!body?.entry?.length) return res.status(200).send('no entry');

    for(const entry of body.entry){
      const { senderId, text, payload } = parsePayload(entry);
      if(!senderId) continue;
      const session=getSession(senderId); session.last=Date.now();

      const tnorm=(text||'').trim();
      if(isRestart(tnorm) || (isGreeting(tnorm) && (session.offerShown || session.phase!=='qualifying'))){
        resetSession(senderId);
        await sendText(senderId,"Sige! 🔄 Fresh start tayo. Consultant mode—goal natin: ma-match ka sa best unit (no endless scrolling).");
        await askPayment(senderId);
        continue;
      }

      if(payload){
        if(payload==='PAYMENT_CASH'){ session.collected.payment='cash'; await sendText(senderId,"Got it: Cash ✅"); await askBudgetCash(senderId); continue; }
        if(payload==='PAYMENT_FINANCING'){ session.collected.payment='financing'; await sendText(senderId,"Got it: Financing ✅"); await askDownpayment(senderId); continue; }
        if(payload==='PAYMENT_UNDECIDED'){ session.collected.payment='undecided'; await sendText(senderId,"Sige, puwede tayong mag-compare."); await askLocation(senderId); continue; }
        if(payload==='TX_AT'){ session.collected.transmission='AT'; await askModel(senderId); continue; }
        if(payload==='TX_MT'){ session.collected.transmission='MT'; await askModel(senderId); continue; }
        if(payload==='TX_ANY'){ session.collected.transmission='ANY'; await askModel(senderId); continue; }

        if(payload.startsWith('SELECT_UNIT:')){
          const sku=payload.split(':')[1];
          const unit=findBySku(session,sku);
          if(unit){
            const urls=[unit.image_1,unit.image_2,unit.image_3,unit.image_4,unit.image_5,unit.image_6,unit.image_7,unit.image_8,unit.image_9,unit.image_10].filter(Boolean);
            if(urls.length){ await sendGallery(senderId, buildImageElements(urls)); }
            else { await sendText(senderId,"Walang extra photos sa record, pero puwede tayong mag-request sa dealer. 🙂"); }
            await sendQuickReplies(senderId,"Anong next gusto mo?",[
              {title:"Schedule viewing",payload:`SCHEDULE:${sku}`},
              {title:"Show other units",payload:"SHOW_OTHERS"},
              {title:"Start over",payload:"RESTART"},
            ]);
          } else {
            await sendText(senderId,"Di ko mahanap yung unit na ’yon. Piliin ulit or show other units tayo. 🙂");
          }
          continue;
        }

        if(payload.startsWith('MORE_PHOTOS:')){
          const sku=payload.split(':')[1];
          const unit=findBySku(session,sku);
          if(unit){
            const urls=[unit.image_1,unit.image_2,unit.image_3,unit.image_4,unit.image_5,unit.image_6,unit.image_7,unit.image_8,unit.image_9,unit.image_10].filter(Boolean);
            if(urls.length) await sendGallery(senderId, buildImageElements(urls));
            else await sendText(senderId,"Walang extra photos sa record, pero puwede tayong mag-request. 🙂");
          }
          continue;
        }

        if(payload==='SHOW_OTHERS'){ await sendText(senderId,"Sige! Refine natin—ibang model o adjust budget/location?"); continue; }
        if(payload==='RESTART'){ resetSession(senderId); await sendText(senderId,"Reset done. 🔄"); await askPayment(senderId); continue; }
      }

      // Qualifying free-text
      if(session.phase==='qualifying'){
        const col=session.collected;
        if(col.payment==='cash'){
          const b=extractBudget(text); if(b.min||b.max){ col.budget_cash_min=b.min||null; col.budget_cash_max=b.max||null; await sendText(senderId,"Noted ang cash budget. ✅"); if(!col.location){ await askLocation(senderId); continue; } }
        } else if(col.payment==='financing'){
          const dp=extractBudget(text).min || num(text); if(dp){ col.downpayment=dp; await sendText(senderId,"Noted ang ready downpayment. ✅"); if(!col.location){ await askLocation(senderId); continue; } }
        }
        const t=lower(text);
        if(!col.location && /city|quezon|manila|cebu|davao|laguna|bulacan|cavite|rizal|pampanga|iloilo|bacolod|quezon city|makati|pasig|taguig|pasay|mandaluyong/i.test(text||'')){ col.location=text.trim(); await sendText(senderId,`Got it, location: ${col.location} ✅`); }
        if(!col.model && /\b(vios|mirage|innova|fortuner|terrav?a|nv350|urvan|hiace|traviz|city|civic|almera|br-v|xpander|stargazer|wigo|raize|brio|crosswind|accent|livina)\b/i.test(text||'')){ col.model=text.trim(); await sendText(senderId,`Noted sa preferred model: ${col.model} ✅`); }
        if(!col.transmission && /\b(at|automatic|auto)\b/i.test(t)) col.transmission='AT';
        else if(!col.transmission && /\b(mt|manual)\b/i.test(t)) col.transmission='MT';

        if(!col.payment){ await askPayment(senderId); continue; }
        if(col.payment==='cash' && !(col.budget_cash_min||col.budget_cash_max)){ await askBudgetCash(senderId); continue; }
        if(col.payment==='financing' && !col.downpayment){ await askDownpayment(senderId); continue; }
        if(!col.location){ await askLocation(senderId); continue; }
        if(!col.transmission){ await askTransmission(senderId); continue; }
        if(!col.model){ await askModel(senderId); continue; }

        if(hasEnough(col)){
          await sendText(senderId,"GOT IT! ✅ I now have everything I need. I can now search available units for you.");
          try{
            const all=await fetchInventory();
            const picks=scoreAndPick(all,col);
            await sendTwoOffers(senderId,picks,col,session);
            session.phase='offer';
          }catch(e){ console.error('Inventory error',e); await sendText(senderId,"Nagka-issue sa inventory lookup. Subukan natin ulit mamaya."); }
        }
        continue;
      }

      if(session.phase==='offer'){
        const t=lower(text);
        if(/more|photos|pictures|pics|images|kuha/i.test(t)){
          const one=session.lastMatches?.[0];
          if(one){
            const urls=[one.image_1,one.image_2,one.image_3,one.image_4,one.image_5,one.image_6,one.image_7,one.image_8,one.image_9,one.image_10].filter(Boolean);
            if(urls.length) await sendGallery(senderId, buildImageElements(urls));
            else await sendText(senderId,"Please tap a unit first para ma-show ang gallery. 🙂");
          }
          continue;
        }
        if(/schedule|view|test drive|testdrive|tingin/i.test(t)){
          await sendText(senderId,"Sige! Paki-send ng preferred day/time at full name. Iche-check ko agad availability ng unit. 🙂");
          continue;
        }
        if(/iba|other|more options|show other/i.test(t)){
          await sendText(senderId,"Copy! Refine natin—may model ka bang gusto pa o adjust natin budget/location?");
          continue;
        }
      }
    }

    return res.status(200).send('ok');
  }catch(err){
    console.error('webhook error',err);
    return res.status(200).send('error'); // keep 200 so Meta doesn't retry-loop aggressively
  }
}
