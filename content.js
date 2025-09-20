// Priorizar itemid en NetSuite
function getItemIdCandidates() {
  const selectors = [
    'input[name="itemid"]','input#itemid','[data-fieldid="itemid"] input','[data-fieldid="itemid"] span','[name="itemid"]',
    'input[name$=".itemid"]','input[id$="itemid"]','span#itemid','span[data-fieldid="itemid"]'
  ];
  const vals = new Set();
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      let v = (el.tagName === "INPUT" || el.tagName === "TEXTAREA") ? (el.value || "") : (el.textContent || "");
      v = (v || "").trim();
      if (v) vals.add(v);
    });
  }
  return Array.from(vals);
}
function getFallbackCandidates() {
  const selectors = [
    'input[name="custitem_sku"]','[data-fieldid="custitem_sku"] input','[data-fieldid="custitem_sku"] span',
    'input[name="sku"]','span[name="sku"]','td[name="sku"]','.uir-field-input','.uir-field-text','.nlobj-field'
  ];
  const vals = new Set();
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      let v = (el.tagName === "INPUT" || el.tagName === "TEXTAREA") ? (el.value || "") : (el.textContent || "");
      v = (v || "").trim();
      if (v) vals.add(v);
    });
  }
  document.querySelectorAll('label, span, div').forEach(el => {
    const t = (el.textContent || "").trim();
    if (/\b(Item\s*ID|ItemID|SKU)\b/i.test(t)) {
      const next = el.closest('tr,div,li')?.querySelector('input,span,div');
      const val = (next?.value || next?.textContent || "").trim();
      if (val) vals.add(val);
    }
  });
  return Array.from(vals);
}
function looksLikeSKU(s){ return /^[A-Za-z0-9_\-\.\/]+$/.test(s) && s.length>=2 && s.length<=120; }
function pickSKU(c){ const f=c.filter(looksLikeSKU); if(!f.length) return null; const sep=f.filter(s=>/[-_\.]/.test(s)); return sep[0]||f[0]; }
function collectSkuDetection(){
  const itemIdCandidates=getItemIdCandidates();
  const fallbackCandidates=getFallbackCandidates();
  const sku=pickSKU(itemIdCandidates)||pickSKU(fallbackCandidates)||null;
  const seen=new Set();
  const ordered=[];
  for(const val of [...itemIdCandidates,...fallbackCandidates]){
    const normalized=(val||"").trim();
    if(!normalized) continue;
    if(!looksLikeSKU(normalized)) continue;
    if(seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return { sku, skuCandidates: ordered };
}
function getFieldCandidates(field){
  const names=[field,`${field}_display`];
  const selectors=new Set();
  for(const name of names){
    selectors.add(`input[name="${name}"]`);
    selectors.add(`input[id="${name}"]`);
    selectors.add(`input[name$=".${name}"]`);
    selectors.add(`input[id$="${name}"]`);
    selectors.add(`[name="${name}"]`);
    selectors.add(`#${name}`);
    selectors.add(`[data-fieldid="${name}"] input`);
    selectors.add(`[data-fieldid="${name}"] span`);
    selectors.add(`[data-fieldid="${name}"] .uir-field-input`);
    selectors.add(`[data-fieldid="${name}"] .uir-field-text`);
    selectors.add(`span#${name}`);
    selectors.add(`span[name="${name}"]`);
    selectors.add(`span[id$="${name}"]`);
  }
  const vals=new Set();
  selectors.forEach(sel=>{
    document.querySelectorAll(sel).forEach(el=>{
      let v=(el.tagName==="INPUT"||el.tagName==="TEXTAREA")?(el.value||""):(el.textContent||"");
      v=(v||"").trim();
      if(v) vals.add(v);
    });
  });
  return Array.from(vals);
}
function pickFieldValue(field){ const vals=getFieldCandidates(field); return vals.length?vals[0]:null; }
function gatherBasePayload(){
  const { sku, skuCandidates } = collectSkuDetection();
  const internalId=pickFieldValue("id");
  const bcProductId=pickFieldValue("custitem_tt_bc_product_id");
  const bcVariantId=pickFieldValue("custitem_tt_bc_variant_id");
  return {
    sku: sku||null,
    skuCandidates,
    detectedSkuCount: skuCandidates.length,
    internalId: internalId||null,
    bcProductId: bcProductId||null,
    bcVariantId: bcVariantId||null
  };
}
function arraysEqual(a,b){
  const arrA=Array.isArray(a)?a:[];
  const arrB=Array.isArray(b)?b:[];
  if(arrA.length!==arrB.length) return false;
  for(let i=0;i<arrA.length;i++){
    if(arrA[i]!==arrB[i]) return false;
  }
  return true;
}
function baseEquals(a,b){
  if(!a&&!b) return true;
  if(!a||!b) return false;
  return (a.sku||null)===(b.sku||null)
    && (a.internalId||null)===(b.internalId||null)
    && (a.bcProductId||null)===(b.bcProductId||null)
    && (a.bcVariantId||null)===(b.bcVariantId||null)
    && (a.detectedSkuCount||0)===(b.detectedSkuCount||0)
    && arraysEqual(a.skuCandidates,b.skuCandidates);
}
let lastDetectedPayload=null;
function notifyDetection(payload){
  try{
    const message={type:"ns-detected", payload};
    const sendPromise=chrome.runtime.sendMessage(message);
    if(sendPromise&&typeof sendPromise.catch==="function") sendPromise.catch(()=>{});
  }catch(e){
    // ignore background errors
  }
}
function updateDetectedPayload(){
  const base=gatherBasePayload();
  const hasAny=!!(base.sku||base.internalId||base.bcProductId||base.bcVariantId||base.detectedSkuCount);
  if(!hasAny){
    if(lastDetectedPayload!==null){
      lastDetectedPayload=null;
      notifyDetection(null);
    }
    return;
  }
  const prevBase=lastDetectedPayload?{
    sku:lastDetectedPayload.sku||null,
    internalId:lastDetectedPayload.internalId||null,
    bcProductId:lastDetectedPayload.bcProductId||null,
    bcVariantId:lastDetectedPayload.bcVariantId||null,
    detectedSkuCount:lastDetectedPayload.detectedSkuCount||0,
    skuCandidates:Array.isArray(lastDetectedPayload.skuCandidates)?lastDetectedPayload.skuCandidates.slice():[]
  }:null;
  if(!baseEquals(base,prevBase)){
    lastDetectedPayload={...base, detectedAt: Date.now()};
    notifyDetection(lastDetectedPayload);
  }
}
const obs=new MutationObserver(()=>updateDetectedPayload());
obs.observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('load',updateDetectedPayload);
updateDetectedPayload();
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==="get-sku"){
    updateDetectedPayload();
    const sku=lastDetectedPayload?lastDetectedPayload.sku||null:null;
    sendResponse({sku,payload:lastDetectedPayload});
  } else if(msg?.type==="get-detected-payload"){
    updateDetectedPayload();
    sendResponse({payload:lastDetectedPayload});
  }
});
