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

let lastLookupResult = null;

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

function normalizeLookupRequest(raw) {
  if (typeof raw === "string") {
    return { recordType: "item", sku: raw };
  }
  const request = raw && typeof raw === "object" ? { ...raw } : {};
  const recordType = (request.recordType || (request.sku ? "item" : "item")).toLowerCase();
  request.recordType = recordType;
  return request;
}

function normalizeItemResult({ source, sku, productId, variantId, productName, raw, request, extras }) {
  return {
    recordType: "item",
    source: source || null,
    request: request || null,
    data: {
      sku: sku ?? null,
      bcProductId: productId ?? null,
      bcVariantId: variantId ?? null,
      productName: productName ?? null,
    },
    raw: raw ?? null,
    extras: extras && typeof extras === "object" ? { ...extras } : null,
  };
}

function normalizeOrderResult({ source, order, request, extras }) {
  if (!order || typeof order !== "object") {
    return {
      recordType: "order",
      source: source || null,
      request: request || null,
      data: null,
      raw: null,
      extras: null,
    };
  }
  const billing = order.billing_address || {};
  const normalized = {
    id: order.id ?? null,
    orderNumber: order.order_number ?? order.id ?? null,
    statusId: order.status_id ?? null,
    status: order.status ?? null,
    reference: order.reference ?? null,
    customerId: order.customer_id ?? null,
    email: billing.email ?? order.customer_email ?? null,
    dateCreated: order.date_created ?? null,
    dateModified: order.date_modified ?? null,
    totalIncTax: order.total_inc_tax ?? null,
    totalExTax: order.total_ex_tax ?? null,
    currencyCode: order.currency_code ?? null,
  };
  return {
    recordType: "order",
    source: source || null,
    request: request || null,
    data: normalized,
    raw: order,
    extras: extras && typeof extras === "object" ? { ...extras } : null,
  };
}

function normalizeCustomerResult({ source, customer, request }) {
  if (!customer || typeof customer !== "object") {
    return {
      recordType: "customer",
      source: source || null,
      request: request || null,
      data: null,
      raw: null,
    };
  }
  const normalized = {
    id: customer.id ?? null,
    email: customer.email ?? null,
    firstName: customer.first_name ?? null,
    lastName: customer.last_name ?? null,
    company: customer.company ?? null,
    phone: customer.phone ?? null,
    customerGroupId: customer.customer_group_id ?? null,
    notes: customer.notes ?? null,
    dateCreated: customer.date_created ?? null,
    dateModified: customer.date_modified ?? null,
  };
  return {
    recordType: "customer",
    source: source || null,
    request: request || null,
    data: normalized,
    raw: customer,
  };
}

function uniqueStrings(...groups) {
  const ordered = [];
  const seen = new Set();
  groups.flat().forEach(value => {
    if (value == null) return;
    const str = String(value).trim();
    if (!str || seen.has(str)) return;
    seen.add(str);
    ordered.push(str);
  });
  return ordered;
}

function buildError(message, details) {
  const base = message || 'Request failed';
  if (!details) return base;
  return `${base}: ${details}`;
}

async function fetchOrderRelatedCollection(baseUrl, headers, orderId, resource) {
  if (!orderId) {
    return { entries: [], error: 'Missing order ID' };
  }
  const url = `${baseUrl}/orders/${encodeURIComponent(orderId)}/${resource}`;
  try {
    const response = await fetch(url, { headers });
    if (response.status === 404) {
      return { entries: [] };
    }
    if (!response.ok) {
      const text = await response.text();
      return { entries: [], error: buildError(`Error fetching order ${resource}`, `${response.status} ${text}`) };
    }
    const data = await response.json();
    return { entries: Array.isArray(data) ? data : [] };
  } catch (e) {
    return { entries: [], error: buildError(`Error fetching order ${resource}`, String(e)) };
  }
}

async function fetchProductMetafields(cfg, productId) {
  if (!productId) {
    return { entries: [], error: 'Missing product ID' };
  }
  const baseV3 = `https://api.bigcommerce.com/stores/${cfg.storeHash}/v3`;
  const headers = authHeaders(cfg);
  const url = `${baseV3}/catalog/products/${encodeURIComponent(productId)}/metafields?limit=250`;
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const text = await response.text();
      return { entries: [], error: buildError('Error fetching product metafields', `${response.status} ${text}`) };
    }
    const json = await response.json();
    const entries = Array.isArray(json?.data) ? json.data : [];
    return { entries };
  } catch (e) {
    return { entries: [], error: buildError('Error fetching product metafields', String(e)) };
  }
}

async function buildOrderExtras(baseUrl, headers, orderId) {
  const [shipping, coupons] = await Promise.all([
    fetchOrderRelatedCollection(baseUrl, headers, orderId, 'shipping_addresses'),
    fetchOrderRelatedCollection(baseUrl, headers, orderId, 'coupons'),
  ]);
  return {
    shippingAddresses: shipping.entries,
    shippingAddressesError: shipping.error || null,
    coupons: coupons.entries,
    couponsError: coupons.error || null,
  };
}

function cloneLookupResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(result);
    } catch (e) {
      // fall back to JSON clone
    }
  }
  try {
    return JSON.parse(JSON.stringify(result));
  } catch (e) {
    return { ...result };
  }
}

async function bcLookupItem(cfg, request) {
  const sku = (request?.sku || "").trim();
  if (!sku) throw new Error("Enter an SKU to look up.");
  const base = `https://api.bigcommerce.com/stores/${cfg.storeHash}/v3`;
  const headers = authHeaders(cfg);
  let candidate = null;

  {
    const url = `${base}/catalog/variants?sku=${encodeURIComponent(sku)}&limit=1`;
    const r = await fetch(url, { headers });
    if (!r.ok) { const t = await r.text(); throw new Error(`Error variants: ${r.status} ${t}`); }
    const j = await r.json();
    const v = (j.data || [])[0];
    if (v) {
      candidate = {
        source: "catalog/variants?sku=",
        productId: v.product_id ?? null,
        variantId: v.id ?? null,
        productName: v.product?.name ?? null,
        raw: v,
        request: { sku },
      };
    }
  }

  if (!candidate) {
    const url = `${base}/catalog/products?sku=${encodeURIComponent(sku)}&include=variants&limit=1`;
    const r = await fetch(url, { headers });
    if (!r.ok) { const t = await r.text(); throw new Error(`Error products: ${r.status} ${t}`); }
    const j = await r.json();
    const p = (j.data || [])[0];
    if (p) {
      const trimmedSku = sku.trim();
      const v = (p.variants || []).find(variant => (variant.sku || "").trim() === trimmedSku);
      candidate = {
        source: v ? "catalog/products?sku=&include=variants (matched variant)" : "catalog/products?sku=&include=variants (no variant match)",
        productId: p.id ?? null,
        variantId: v ? v.id ?? null : null,
        productName: p.name ?? null,
        raw: { product: p, variant: v || null },
        request: { sku },
      };
    }
  }

  if (!candidate) {
    throw new Error(`SKU "${sku}" not found in BigCommerce.`);
  }

  const metafieldsInfo = await fetchProductMetafields(cfg, candidate.productId);
  return normalizeItemResult({
    source: candidate.source,
    sku,
    productId: candidate.productId,
    variantId: candidate.variantId,
    productName: candidate.productName,
    raw: candidate.raw,
    request: candidate.request,
    extras: {
      metafields: metafieldsInfo.entries,
      metafieldsError: metafieldsInfo.error || null,
    },
  });
}

async function bcLookupOrder(cfg, request) {
  const baseV2 = `https://api.bigcommerce.com/stores/${cfg.storeHash}/v2`;
  const headers = authHeaders(cfg);
  const idCandidates = uniqueStrings(request.bcOrderId ?? null, ...(Array.isArray(request.bcOrderIds) ? request.bcOrderIds : []));
  const numberCandidates = uniqueStrings(...(Array.isArray(request.orderNumbers) ? request.orderNumbers : []));
  const requestDetails = { bcOrderIds: idCandidates.slice(), orderNumbers: numberCandidates.slice() };

  const numericIds = [];
  const otherNumbers = [...numberCandidates];
  idCandidates.forEach(value => {
    if (/^\d+$/.test(value)) {
      numericIds.push(value);
    } else {
      otherNumbers.push(value);
    }
  });

  const tried = new Set();

  for (const id of numericIds) {
    if (tried.has(`id:${id}`)) continue;
    tried.add(`id:${id}`);
    const url = `${baseV2}/orders/${encodeURIComponent(id)}`;
    const r = await fetch(url, { headers });
    if (r.status === 404) continue;
    if (!r.ok) { const t = await r.text(); throw new Error(`Error fetching order ${id}: ${r.status} ${t}`); }
    const order = await r.json();
    if (order && typeof order === "object") {
      const extras = await buildOrderExtras(baseV2, headers, order.id ?? id);
      return normalizeOrderResult({ source: `orders/${id}`, order, request: requestDetails, extras });
    }
  }

  for (const number of otherNumbers) {
    if (!number) continue;
    if (tried.has(`number:${number}`)) continue;
    tried.add(`number:${number}`);
    const url = `${baseV2}/orders?reference=${encodeURIComponent(number)}&limit=1`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Error searching order by reference "${number}": ${r.status} ${text}`);
    }
    const orders = await r.json();
    if (Array.isArray(orders) && orders.length > 0) {
      const order = orders[0];
      if (order && typeof order === "object") {
        const extras = await buildOrderExtras(baseV2, headers, order.id ?? null);
        return normalizeOrderResult({ source: `orders?reference=${number}`, order, request: requestDetails, extras });
      }
    }
  }

  throw new Error("Order not found in BigCommerce.");
}

async function bcLookupCustomer(cfg, request) {
  const baseV3 = `https://api.bigcommerce.com/stores/${cfg.storeHash}/v3`;
  const headers = authHeaders(cfg);
  const idCandidates = uniqueStrings(request.bcCustomerId ?? null, ...(Array.isArray(request.customerIds) ? request.customerIds : []));
  const emailCandidates = uniqueStrings(request.email ?? null, ...(Array.isArray(request.emails) ? request.emails : []));
  const requestDetails = { customerIds: idCandidates.slice(), emails: emailCandidates.slice() };

  for (const id of idCandidates) {
    const url = `${baseV3}/customers?id:in=${encodeURIComponent(id)}&limit=1`;
    const r = await fetch(url, { headers });
    if (!r.ok) { const t = await r.text(); throw new Error(`Error fetching customer ${id}: ${r.status} ${t}`); }
    const j = await r.json();
    const customer = (j.data || []).find(entry => String(entry.id) === String(id));
    if (customer) {
      return normalizeCustomerResult({ source: `customers?id:in=${id}`, customer, request: requestDetails });
    }
  }

  for (const email of emailCandidates) {
    if (!email) continue;
    const url = `${baseV3}/customers?email:in=${encodeURIComponent(email)}&limit=1`;
    const r = await fetch(url, { headers });
    if (!r.ok) { const t = await r.text(); throw new Error(`Error fetching customer by email ${email}: ${r.status} ${t}`); }
    const j = await r.json();
    const lower = email.toLowerCase();
    const customer = (j.data || []).find(entry => (entry.email || "").toLowerCase() === lower);
    if (customer) {
      return normalizeCustomerResult({ source: `customers?email:in=${email}`, customer, request: requestDetails });
    }
  }

  throw new Error("Customer not found in BigCommerce.");
}

async function bcLookup(rawRequest) {
  const request = normalizeLookupRequest(rawRequest);
  const cfg = await getSettingsUnlocked();
  if (!cfg.storeHash || !cfg.accessToken) throw new Error("Incomplete configuration. Unlock in Options.");

  let result;
  if (request.recordType === "order") {
    result = await bcLookupOrder(cfg, request);
  } else if (request.recordType === "customer") {
    result = await bcLookupCustomer(cfg, request);
  } else {
    result = await bcLookupItem(cfg, request);
  }
  lastLookupResult = cloneLookupResult(result);
  return result;
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

  if (msg?.type === "get-last-lookup-result") {
    sendResponse({ ok: true, result: cloneLookupResult(lastLookupResult) });
    return;
  }

  (async () => {
    try {
      if (msg?.type === "bc-lookup") {
        const data = await bcLookup(msg);
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
