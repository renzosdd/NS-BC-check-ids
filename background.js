import { decryptJSON } from "./crypto.js";

let unlockedCreds = null;
let lastUseTs = 0;
const IDLE_MS = 15 * 60 * 1000; // 15 minutes
const lastDetectedByTab = new Map();

async function getEncrypted() {
  const defaults = { bc_encrypted: null };
  return new Promise(resolve => chrome.storage.local.get(defaults, resolve));
}

async function setUnlocked(creds) {
  unlockedCreds = creds;
  lastUseTs = Date.now();
}

function ensureNotIdle() {
  if (unlockedCreds && Date.now() - lastUseTs > IDLE_MS) {
    unlockedCreds = null;
  }
}

async function getSettingsUnlocked() {
  ensureNotIdle();
  if (unlockedCreds) {
    lastUseTs = Date.now();
    return unlockedCreds;
  }
  throw new Error("LOCKED");
}

function authHeaders(cfg) {
  const h = { "X-Auth-Token": cfg.accessToken, "Accept": "application/json", "Content-Type": "application/json" };
  if (cfg.clientId) h["X-Auth-Client"] = cfg.clientId;
  return h;
}

async function bcLookup(sku) {
  const cfg = await getSettingsUnlocked();
  if (!cfg.storeHash || !cfg.accessToken) throw new Error("Incomplete configuration. Unlock in Options.");
  const base = `https://api.bigcommerce.com/stores/${cfg.storeHash}/v3`;

  // 1) variants?sku=
  {
    const url = `${base}/catalog/variants?sku=${encodeURIComponent(sku)}&limit=1`;
    const r = await fetch(url, { headers: authHeaders(cfg) });
    if (!r.ok) { const t = await r.text(); throw new Error(`Error variants: ${r.status} ${t}`); }
    const j = await r.json();
    const v = (j.data || [])[0];
    if (v) return { sku, bc_product_id: v.product_id, bc_variant_id: v.id, source: "variants?sku=" };
  }

  // 2) products?sku=&include=variants
  {
    const url = `${base}/catalog/products?sku=${encodeURIComponent(sku)}&include=variants&limit=1`;
    const r = await fetch(url, { headers: authHeaders(cfg) });
    if (!r.ok) { const t = await r.text(); throw new Error(`Error products: ${r.status} ${t}`); }
    const j = await r.json();
    const p = (j.data || [])[0];
    if (p) {
      const v = (p.variants || []).find(v => (v.sku || "").trim() === sku.trim());
      return { sku, bc_product_id: p.id, bc_variant_id: v ? v.id : null, source: v ? "products?sku=&include=variants (matched variant)" : "products?sku=&include=variants (no variant match)" };
    }
  }

  throw new Error(`SKU "${sku}" not found in BigCommerce.`);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "bc-lookup-selection", title: "Search in BigCommerce: \"%s\"", contexts: ["selection"] });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastDetectedByTab.delete(tabId);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "bc-lookup-selection" && info.selectionText) {
    const sku = info.selectionText.trim();
    try {
      const result = await bcLookup(sku);
      chrome.runtime.sendMessage({ type: "bc-lookup-result", sku, result });
    } catch (e) {
      chrome.runtime.sendMessage({ type: "bc-lookup-result", sku, result: { error: String(e) } });
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "netsuite-detected") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      if (msg.payload) {
        lastDetectedByTab.set(tabId, { ...msg.payload });
      } else {
        lastDetectedByTab.delete(tabId);
      }
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === "get-last-detected") {
    const tabId = msg.tabId ?? sender.tab?.id ?? null;
    const payload = tabId != null ? (lastDetectedByTab.get(tabId) || null) : null;
    sendResponse({ ok: true, payload });
    return;
  }

  (async () => {
    try {
      if (msg?.type === "bc-lookup") {
        const data = await bcLookup(msg.sku);
        sendResponse({ ok: true, data });
      } else if (msg?.type === "unlock-creds") {
        // msg.bundle (encrypted), msg.passphrase
        const { bc_encrypted } = await getEncrypted();
        const bundle = msg.bundle || bc_encrypted;
        if (!bundle) throw new Error("No credentials saved.");
        const creds = await decryptJSON(bundle, msg.passphrase);
        await setUnlocked(creds);
        sendResponse({ ok: true });
      } else if (msg?.type === "lock-creds") {
        unlockedCreds = null;
        sendResponse({ ok: true });
      } else if (msg?.type === "status-creds") {
        ensureNotIdle();
        sendResponse({ ok: true, unlocked: !!unlockedCreds, idleMs: unlockedCreds ? (Date.now()-lastUseTs) : null, idleLimitMs: IDLE_MS });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
