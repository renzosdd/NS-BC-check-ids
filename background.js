import { decryptJSON } from "./crypto.js";

let unlockedCreds = null;
let lastUseTs = 0;
const IDLE_MS = 15 * 60 * 1000; // 15 minutes
const lastDetectedByTab = new Map();
const LOCK_BADGE_TEXT = "🔒";
const UNLOCK_BADGE_TEXT = "✅";
const BADGE_COLORS = {
  locked: "#5F6368",
  noDetection: "#34A853",
  detectedSingle: "#1A73E8",
  detectedMultiple: "#9334E6",
};

function getDetectedSkuCount(payload) {
  if (!payload) return 0;
  const type = payload.type || null;
  if (type === "item" && payload.data) {
    const data = payload.data || {};
    if (typeof data.detectedSkuCount === "number" && !Number.isNaN(data.detectedSkuCount)) {
      return Math.max(0, Math.floor(data.detectedSkuCount));
    }
    if (Array.isArray(data.skuCandidates)) {
      return data.skuCandidates.filter(Boolean).length;
    }
    return data.sku ? 1 : 0;
  }
  if (typeof payload.detectedSkuCount === "number" && !Number.isNaN(payload.detectedSkuCount)) {
    return Math.max(0, Math.floor(payload.detectedSkuCount));
  }
  if (Array.isArray(payload.skuCandidates)) {
    return payload.skuCandidates.filter(Boolean).length;
  }
  return payload.sku ? 1 : 0;
}

function badgeColorForState(locked, detectedCount) {
  if (locked) return BADGE_COLORS.locked;
  if (detectedCount > 1) return BADGE_COLORS.detectedMultiple;
  if (detectedCount === 1) return BADGE_COLORS.detectedSingle;
  return BADGE_COLORS.noDetection;
}

async function applyBadgeToTab(tabId, locked, detectedCount) {
  const text = locked ? LOCK_BADGE_TEXT : UNLOCK_BADGE_TEXT;
  const color = badgeColorForState(locked, detectedCount);
  const descriptor = [
    locked ? "Credentials locked" : "Credentials unlocked",
    detectedCount > 0 ? `${detectedCount} SKU${detectedCount === 1 ? "" : "s"} detected` : "No SKU detected",
  ].join(" · ");
  const updates = [
    chrome.action.setBadgeText({ tabId, text }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {}),
  ];
  updates.push(chrome.action.setTitle({ tabId, title: `BC SKU Lookup — ${descriptor}` }).catch(() => {}));
  await Promise.all(updates);
}

async function refreshBadgeForTab(tabId, lockedOverride) {
  if (tabId == null) return;
  let locked;
  if (typeof lockedOverride === "boolean") {
    locked = lockedOverride;
  } else {
    ensureNotIdle();
    locked = !unlockedCreds;
  }
  const payload = lastDetectedByTab.get(tabId) || null;
  const detectedCount = getDetectedSkuCount(payload);
  try {
    await applyBadgeToTab(tabId, locked, detectedCount);
  } catch (e) {
    // Tab might have gone away; make sure we don't leak detection state.
    lastDetectedByTab.delete(tabId);
  }
}

async function refreshAllBadges() {
  ensureNotIdle();
  const locked = !unlockedCreds;
  const text = locked ? LOCK_BADGE_TEXT : UNLOCK_BADGE_TEXT;
  const color = badgeColorForState(locked, 0);
  await Promise.all([
    chrome.action.setBadgeText({ text }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ color }).catch(() => {}),
    chrome.action.setTitle({ title: locked ? "BC SKU Lookup — Credentials locked" : "BC SKU Lookup — Credentials unlocked" }).catch(() => {}),
  ]);
  const tabIds = Array.from(lastDetectedByTab.keys());
  await Promise.all(tabIds.map(tabId => refreshBadgeForTab(tabId, locked)));
}

function scheduleBadgeRefreshForTab(tabId) {
  if (tabId == null) return;
  refreshBadgeForTab(tabId).catch(() => {});
}

function scheduleBadgeRefreshAll() {
  refreshAllBadges().catch(() => {});
}

async function getEncrypted() {
  const defaults = { bc_encrypted: null };
  return new Promise(resolve => chrome.storage.local.get(defaults, resolve));
}

async function setUnlocked(creds) {
  unlockedCreds = creds;
  lastUseTs = Date.now();
  await refreshAllBadges();
}

function ensureNotIdle() {
  if (unlockedCreds && Date.now() - lastUseTs > IDLE_MS) {
    unlockedCreds = null;
    setTimeout(scheduleBadgeRefreshAll, 0);
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
  scheduleBadgeRefreshAll();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastDetectedByTab.delete(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  scheduleBadgeRefreshForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    lastDetectedByTab.delete(tabId);
    scheduleBadgeRefreshForTab(tabId);
  }
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
  if (msg?.type === "netsuite-detected" || msg?.type === "ns-detected") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      if (msg.payload) {
        const payload = { ...msg.payload };
        if (typeof payload.detectedSkuCount !== "number") {
          payload.detectedSkuCount = getDetectedSkuCount(payload);
        }
        lastDetectedByTab.set(tabId, payload);
      } else {
        lastDetectedByTab.delete(tabId);
      }
      scheduleBadgeRefreshForTab(tabId);
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === "refresh-badge") {
    const tabId = msg.tabId ?? sender.tab?.id ?? null;
    if (tabId != null) {
      scheduleBadgeRefreshForTab(tabId);
    } else {
      scheduleBadgeRefreshAll();
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
        await refreshAllBadges();
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

scheduleBadgeRefreshAll();
