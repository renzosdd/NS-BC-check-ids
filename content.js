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
function fieldExists(field){
  const selectors = new Set([
    `[name="${field}"]`,
    `[id="${field}"]`,
    `[name$=".${field}"]`,
    `[id$="${field}"]`,
    `[data-fieldid="${field}"]`,
    `[data-fieldid="${field}"] input`,
    `[data-fieldid="${field}"] span`,
    `input[name="${field}"]`,
    `input[id="${field}"]`,
    `input[name$=".${field}"]`,
    `input[id$="${field}"]`,
    `span[name="${field}"]`,
    `span[id="${field}"]`,
    `span[id^="${field}_"][id$="_val"]`,
    `div[id^="${field}_"][id$="_val"]`,
  ]);
  for (const sel of selectors) {
    if (document.querySelector(sel)) {
      return true;
    }
  }
  return false;
}

function getFieldCandidates(field){
  const names=[field,`${field}_display`];
  const selectors=new Set();
  const labelSelectors=new Set();
  const labelValueSelectors=[".uir-field-value",".inputreadonly",".value",".smalltextnolink"];
  for(const name of names){
    selectors.add(`input[name="${name}"]`);
    selectors.add(`input[id="${name}"]`);
    selectors.add(`input[name$=".${name}"]`);
    selectors.add(`input[id$="${name}"]`);
    selectors.add(`[name="${name}"]`);
    selectors.add(`#${name}`);
    selectors.add(`#${name}_val`);
    selectors.add(`[data-fieldid="${name}"] input`);
    selectors.add(`[data-fieldid="${name}"] span`);
    selectors.add(`[data-fieldid="${name}"] .uir-field-input`);
    selectors.add(`[data-fieldid="${name}"] .uir-field-text`);
    selectors.add(`span#${name}`);
    selectors.add(`span[name="${name}"]`);
    selectors.add(`span[id$="${name}"]`);
    selectors.add(`span[id^="${name}_"][id$="_val"]`);
    selectors.add(`span[id*="${name}"][id$="_val"]`);
    selectors.add(`div[id^="${name}_"][id$="_val"]`);
    selectors.add(`div[id*="${name}"][id$="_val"]`);
    selectors.add(`[id^="${name}_"][id$="_val"]`);
    selectors.add(`[id*="${name}"][id$="_val"]`);
    selectors.add(`#${name}_val span`);
    selectors.add(`#${name}_val div`);
    const fsBases=[
      `#${name}_fs`,
      `[id^="${name}_"][id$="_fs"]`,
      `[id*="${name}"][id$="_fs"]`,
      `div[id^="${name}_"][id$="_fs"]`,
      `div[id*="${name}"][id$="_fs"]`,
      `span[id^="${name}_"][id$="_fs"]`,
      `span[id*="${name}"][id$="_fs"]`,
      `td[id^="${name}_"][id$="_fs"]`,
      `td[id*="${name}"][id$="_fs"]`
    ];
    const fsDescendants=[
      "",
      " .uir-field",
      " .inputreadonly",
      " .value",
      " .value *",
      " a",
      " .uir-field-value",
      " .uir-field-value *",
      " .uir-field-wrapper",
      " .uir-field-wrapper *"
    ];
    for(const baseSel of fsBases){
      for(const suffix of fsDescendants){
        selectors.add(`${baseSel}${suffix}`);
      }
    }
    labelSelectors.add(`#${name}_fs_lbl`);
    labelSelectors.add(`#${name}_lbl`);
    labelSelectors.add(`[id^="${name}_"][id$="_fs_lbl"]`);
    labelSelectors.add(`[id*="${name}"][id$="_fs_lbl"]`);
    labelSelectors.add(`[id^="${name}_"][id$="_lbl"]`);
    labelSelectors.add(`[id*="${name}"][id$="_lbl"]`);
    labelSelectors.add(`[data-fieldid="${name}"] label`);
    labelSelectors.add(`[data-fieldid="${name}"] .uir-label`);
    labelSelectors.add(`label[for="${name}"]`);
  }
  const vals=new Set();
  const labelElements=new Set();
  labelSelectors.forEach(sel=>{
    document.querySelectorAll(sel).forEach(el=>labelElements.add(el));
  });
  labelElements.forEach(label=>{
    const container=label.closest('tr,div,li');
    if(!container) return;
    const roots=new Set([container]);
    const addSearchRoot=el=>{
      if(!el||el.nodeType!==1) return;
      let shouldAdd=!!(el.classList&&el.classList.contains('uir-field-wrapper'));
      if(!shouldAdd){
        for(const sel of labelValueSelectors){
          if((el.matches&&el.matches(sel))||(el.querySelector&&el.querySelector(sel))){
            shouldAdd=true;
            break;
          }
        }
      }
      if(shouldAdd) roots.add(el);
    };
    addSearchRoot(container.previousElementSibling);
    addSearchRoot(container.nextElementSibling);
    roots.forEach(root=>{
      for(const sel of labelValueSelectors){
        if(root.matches&&root.matches(sel)){
          const t=(root.textContent||"").trim();
          if(t) vals.add(t);
        }
        root.querySelectorAll(sel).forEach(node=>{
          const v=(node.textContent||"").trim();
          if(v) vals.add(v);
        });
      }
    });
  });
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

function pickFirstFieldValue(){
  for(let i=0;i<arguments.length;i+=1){
    const field=arguments[i];
    if(!field) continue;
    const value=pickFieldValue(field);
    if(value) return value;
  }
  return null;
}

function detectRecordType(){
  try{
    const heading=document.querySelector('h1.uir-record-type');
    const headingText=(heading?.textContent||"").trim().toLowerCase();
    if(headingText){
      if(/sales\s*order/.test(headingText)) return "order";
      if(/customer/.test(headingText)) return "customer";
      if(/item/.test(headingText)) return "item";
    }
  }catch(e){
    // ignore heading detection errors
  }
  try{
    if(fieldExists("custbody_tt_bc_order_id")) return "order";
    if(fieldExists("custentity_tt_bc_cust_id")) return "customer";
  }catch(e){
    // ignore detection errors
  }
  let href="";
  try{
    href=(window.location&&window.location.href)||"";
  }catch(e){ href=""; }
  const lowerHref=(href||"").toLowerCase();
  if(/recordtype=salesorder|salesord\.nl|\/app\/accounting\/transactions\//.test(lowerHref)) return "order";
  if(/recordtype=customer|entity\.nl|\/app\/common\/entity\//.test(lowerHref)) return "customer";
  return "item";
}

function gatherItemPayload(){
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

function gatherOrderPayload(){
  const internalId=pickFieldValue("id");
  const tranId=pickFieldValue("tranid");
  const bcOrderId=pickFieldValue("custbody_tt_bc_order_id");
  const customerName=pickFirstFieldValue(
    "entityname",
    "entity_display",
    "entity",
    "customer",
    "custbody_customer_name",
    "custbody_customer"
  );
  return {
    internalId: internalId||null,
    tranId: tranId||null,
    bcOrderId: bcOrderId||null,
    customerName: customerName||null
  };
}

function gatherCustomerPayload(){
  const internalId=pickFieldValue("id");
  const entityId=pickFieldValue("entityid");
  const email=pickFieldValue("email");
  const bcCustomerId=pickFieldValue("custentity_tt_bc_cust_id");
  return {
    internalId: internalId||null,
    entityId: entityId||null,
    email: email||null,
    bcCustomerId: bcCustomerId||null
  };
}

function gatherBasePayload(){
  const type=detectRecordType();
  let data=null;
  if(type==="order"){
    data=gatherOrderPayload();
  }else if(type==="customer"){
    data=gatherCustomerPayload();
  }else{
    data=gatherItemPayload();
  }
  return { type, data };
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
function itemDataEquals(a,b){
  if(!a&&!b) return true;
  if(!a||!b) return false;
  return (a.sku||null)===(b.sku||null)
    && (a.internalId||null)===(b.internalId||null)
    && (a.bcProductId||null)===(b.bcProductId||null)
    && (a.bcVariantId||null)===(b.bcVariantId||null)
    && (a.detectedSkuCount||0)===(b.detectedSkuCount||0)
    && arraysEqual(a.skuCandidates,b.skuCandidates);
}

function orderDataEquals(a,b){
  if(!a&&!b) return true;
  if(!a||!b) return false;
  return (a.internalId||null)===(b.internalId||null)
    && (a.tranId||null)===(b.tranId||null)
    && (a.bcOrderId||null)===(b.bcOrderId||null)
    && (a.customerName||null)===(b.customerName||null);
}

function customerDataEquals(a,b){
  if(!a&&!b) return true;
  if(!a||!b) return false;
  return (a.internalId||null)===(b.internalId||null)
    && (a.entityId||null)===(b.entityId||null)
    && (a.email||null)===(b.email||null)
    && (a.bcCustomerId||null)===(b.bcCustomerId||null);
}

function payloadEquals(a,b){
  if(!a&&!b) return true;
  if(!a||!b) return false;
  const typeA=a?.type||null;
  const typeB=b?.type||null;
  if(typeA!==typeB) return false;
  const dataA=a?.data||null;
  const dataB=b?.data||null;
  if(typeA==="order") return orderDataEquals(dataA,dataB);
  if(typeA==="customer") return customerDataEquals(dataA,dataB);
  return itemDataEquals(dataA,dataB);
}

function hasDetectionData(payload){
  if(!payload) return false;
  const { type, data } = payload;
  if(!data) return false;
  if(type==="order"){
    return !!(data.internalId||data.tranId||data.bcOrderId||data.customerName);
  }
  if(type==="customer"){
    return !!(data.internalId||data.entityId||data.email||data.bcCustomerId);
  }
  return !!(data.sku||data.internalId||data.bcProductId||data.bcVariantId||data.detectedSkuCount);
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
  const detection=gatherBasePayload();
  const hasAny=hasDetectionData(detection);
  if(!hasAny){
    if(lastDetectedPayload!==null){
      lastDetectedPayload=null;
      notifyDetection(null);
    }
    return;
  }
  if(!payloadEquals(detection,lastDetectedPayload)){
    lastDetectedPayload={ type:detection.type, data:{...detection.data} };
    if(Array.isArray(detection.data?.skuCandidates)){
      lastDetectedPayload.data.skuCandidates=detection.data.skuCandidates.slice();
    }
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
    const sku=lastDetectedPayload&&lastDetectedPayload.type==="item"?lastDetectedPayload.data?.sku||null:null;
    sendResponse({sku,payload:lastDetectedPayload});
  } else if(msg?.type==="get-detected-payload"){
    updateDetectedPayload();
    sendResponse({payload:lastDetectedPayload});
  }
});
