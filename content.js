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
function findSKU(){
  const a=getItemIdCandidates(); const fromItemId=pickSKU(a); if(fromItemId) return fromItemId;
  const b=getFallbackCandidates(); const fromFallback=pickSKU(b); if(fromFallback) return fromFallback;
  return null;
}
let lastDetectedSKU=null;
function updateDetectedSKU(){
  const sku=findSKU();
  if(sku && sku!==lastDetectedSKU){ lastDetectedSKU=sku; chrome.runtime.sendMessage({type:"sku-detected", sku}); }
}
const obs=new MutationObserver(()=>updateDetectedSKU());
obs.observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('load',updateDetectedSKU);
updateDetectedSKU();
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==="get-sku"){ updateDetectedSKU(); sendResponse({sku:lastDetectedSKU}); }
});
