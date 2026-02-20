import {
  ensureActiveAccount,
  getActiveAccount,
  getActiveAccountId,
  getAccountById,
  listAccounts,
  listAccountSummaries,
  mergeAccounts,
  replaceAccounts,
  removeAccount,
  setActiveAccountId,
  upsertAccount,
} from "./account-store.js";

const lastDetectedByTab = new Map();
const READY_BADGE_TEXT = "✅";
const MISSING_BADGE_TEXT = "⚠️";
const BADGE_COLORS = {
  missing: "#EA4335",
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

async function accountAvailable() {
  try {
    const account = await getActiveAccount();
    return !!(account && account.storeHash && account.accessToken);
  } catch (e) {
    return false;
  }
}

function badgeColorForState(hasAccount, detectedCount) {
  if (!hasAccount) return BADGE_COLORS.missing;
  if (detectedCount > 1) return BADGE_COLORS.detectedMultiple;
  if (detectedCount === 1) return BADGE_COLORS.detectedSingle;
  return BADGE_COLORS.noDetection;
}

async function applyBadgeToTab(tabId, hasAccount, detectedCount) {
  const text = hasAccount ? READY_BADGE_TEXT : MISSING_BADGE_TEXT;
  const color = badgeColorForState(hasAccount, detectedCount);
  const descriptor = [
    hasAccount ? "Account configured" : "No account configured",
    detectedCount > 0 ? `${detectedCount} SKU${detectedCount === 1 ? "" : "s"} detected` : "No SKU detected",
  ].join(" · ");
  const updates = [
    chrome.action.setBadgeText({ tabId, text }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {}),
  ];
  updates.push(chrome.action.setTitle({ tabId, title: `BC SKU Lookup — ${descriptor}` }).catch(() => {}));
  await Promise.all(updates);
}

async function refreshBadgeForTab(tabId, hasAccountOverride) {
  if (tabId == null) return;
  let hasAccount;
  if (typeof hasAccountOverride === "boolean") {
    hasAccount = hasAccountOverride;
  } else {
    hasAccount = await accountAvailable();
  }
  const payload = lastDetectedByTab.get(tabId) || null;
  const detectedCount = getDetectedSkuCount(payload);
  try {
    await applyBadgeToTab(tabId, hasAccount, detectedCount);
  } catch (e) {
    // Tab might have gone away; make sure we don't leak detection state.
    lastDetectedByTab.delete(tabId);
  }
}

async function refreshAllBadges() {
  const hasAccount = await accountAvailable();
  const text = hasAccount ? READY_BADGE_TEXT : MISSING_BADGE_TEXT;
  const color = badgeColorForState(hasAccount, 0);
  await Promise.all([
    chrome.action.setBadgeText({ text }).catch(() => {}),
    chrome.action.setBadgeBackgroundColor({ color }).catch(() => {}),
    chrome.action.setTitle({ title: hasAccount ? "BC SKU Lookup — Account configured" : "BC SKU Lookup — No account configured" }).catch(() => {}),
  ]);
  const tabIds = Array.from(lastDetectedByTab.keys());
  await Promise.all(tabIds.map(tabId => refreshBadgeForTab(tabId, hasAccount)));
}

function scheduleBadgeRefreshForTab(tabId) {
  if (tabId == null) return;
  refreshBadgeForTab(tabId).catch(() => {});
}

function scheduleBadgeRefreshAll() {
  refreshAllBadges().catch(() => {});
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
  const requestedType = String(request.recordType || (request.sku ? "item" : "item")).toLowerCase();
  if (requestedType === "order" || requestedType === "customer" || requestedType === "item") {
    request.recordType = requestedType;
    return request;
  }
  const normalizedB2BType = requestedType === "b2b" ? null : requestedType;
  const normalizedEntity = String(request.b2bEntity || "").toLowerCase();
  const entity = normalizedEntity || (normalizedB2BType && normalizedB2BType.startsWith("b2b-") ? normalizedB2BType.slice(4) : "");
  if (entity === "company" || entity === "company-user" || entity === "order" || entity === "invoice" || entity === "quote") {
    request.recordType = `b2b-${entity}`;
    request.b2bEntity = entity;
    return request;
  }
  request.recordType = "item";
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

const B2B_ENTITY_CONFIG = {
  company: {
    label: "company",
    idPaths: ["companies/{id}", "company/{id}"],
    emailPaths: [
      "companies?email={email}",
      "companies?email:in={email}",
      "companies?company_email={email}",
      "companies?keyword={email}",
    ],
    listPaths: ["companies?limit=250", "companies"],
  },
  "company-user": {
    label: "company user",
    idPaths: [
      "company-users/{id}",
      "company-users?id={id}",
      "users/{id}",
      "users?id={id}",
      "companyUsers/{id}",
    ],
    emailPaths: [
      "company-users?email={email}",
      "company-users?email:in={email}",
      "company-users?user_email={email}",
      "users?email={email}",
      "users?email:in={email}",
      "users?user_email={email}",
      "companyUsers?email={email}",
      "company-users?keyword={email}",
      "users?keyword={email}",
    ],
    listPaths: ["company-users?limit=250", "users?limit=250", "companyUsers?limit=250"],
  },
  order: {
    label: "B2B order",
    idPaths: ["orders/{id}"],
    emailPaths: [],
  },
  invoice: {
    label: "invoice",
    idPaths: ["invoices/{id}"],
    emailPaths: [],
  },
  quote: {
    label: "quote",
    idPaths: ["quotes/{id}"],
    emailPaths: [],
  },
};

function buildB2BBaseUrls(storeHash) {
  const hash = encodeURIComponent(storeHash);
  return [
    `https://api-b2b.bigcommerce.com/api/v3/io/stores/${hash}`,
    `https://api-b2b.bigcommerce.com/api/v2/io/stores/${hash}`,
  ];
}

function resolveB2BPaths(paths, replacements) {
  return (Array.isArray(paths) ? paths : []).map((path) => {
    let resolved = String(path || "");
    Object.entries(replacements || {}).forEach(([key, value]) => {
      resolved = resolved.replaceAll(`{${key}}`, encodeURIComponent(String(value ?? "")));
    });
    return resolved;
  }).filter(Boolean);
}

function extractB2BPayload(json) {
  if (!json) return null;
  if (Array.isArray(json)) {
    return json[0] || null;
  }
  if (typeof json !== "object") {
    return null;
  }
  if (Array.isArray(json.data)) {
    return json.data[0] || null;
  }
  if (json.data && typeof json.data === "object") {
    return json.data;
  }
  if (Array.isArray(json.results)) {
    return json.results[0] || null;
  }
  if (json.result && typeof json.result === "object") {
    return json.result;
  }
  return json;
}

function normalizeB2BData(entityType, payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const base = {
    id: data.id ?? data.company_id ?? data.user_id ?? data.order_id ?? data.invoice_id ?? data.quote_id ?? null,
    companyId: data.company_id ?? data.companyId ?? null,
    email: data.email ?? data.user_email ?? data.company_email ?? null,
    status: data.status ?? data.state ?? null,
    dateCreated: data.date_created ?? data.created_at ?? data.createdAt ?? null,
    dateModified: data.date_modified ?? data.updated_at ?? data.updatedAt ?? null,
  };
  if (entityType === "company") {
    return {
      ...base,
      name: data.name ?? data.company_name ?? null,
      phone: data.phone ?? null,
      customerGroupId: data.customer_group_id ?? null,
    };
  }
  if (entityType === "company-user") {
    return {
      ...base,
      firstName: data.first_name ?? data.firstName ?? null,
      lastName: data.last_name ?? data.lastName ?? null,
      role: data.role ?? data.role_name ?? null,
    };
  }
  if (entityType === "order") {
    return {
      ...base,
      orderId: data.id ?? data.order_id ?? null,
      orderNumber: data.order_number ?? data.orderNumber ?? null,
      totalIncTax: data.total_inc_tax ?? data.grand_total ?? data.total ?? null,
      currencyCode: data.currency_code ?? data.currency ?? null,
    };
  }
  if (entityType === "invoice") {
    return {
      ...base,
      invoiceId: data.id ?? data.invoice_id ?? null,
      invoiceNumber: data.invoice_number ?? data.number ?? null,
      orderId: data.order_id ?? null,
      total: data.total ?? data.grand_total ?? null,
      currencyCode: data.currency_code ?? data.currency ?? null,
    };
  }
  if (entityType === "quote") {
    return {
      ...base,
      quoteId: data.id ?? data.quote_id ?? null,
      quoteNumber: data.quote_number ?? data.number ?? null,
      total: data.total ?? data.grand_total ?? null,
      currencyCode: data.currency_code ?? data.currency ?? null,
    };
  }
  return base;
}

function normalizeB2BResult({ entityType, source, payload, request }) {
  return {
    recordType: `b2b-${entityType}`,
    source,
    request: request || null,
    data: normalizeB2BData(entityType, payload),
    raw: payload ?? null,
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
    const text = await response.text();
    if (!text) {
      return { entries: [] };
    }
    try {
      const data = JSON.parse(text);
      return { entries: Array.isArray(data) ? data : [] };
    } catch (e) {
      return { entries: [], error: buildError(`Error fetching order ${resource}`, `Invalid JSON response: ${e}`) };
    }
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

async function listProductMetafields(productId) {
  const normalizedProductId = String(productId || '').trim();
  if (!normalizedProductId) {
    throw new Error('Missing product ID.');
  }
  const cfg = await ensureActiveAccount();
  const details = await fetchProductMetafields(cfg, normalizedProductId);
  if (details.error) {
    throw new Error(details.error);
  }
  return details.entries;
}

async function deleteProductMetafield(productId, metafieldId) {
  const normalizedProductId = String(productId || '').trim();
  const normalizedMetafieldId = String(metafieldId || '').trim();
  if (!normalizedProductId || !normalizedMetafieldId) {
    throw new Error('Missing product ID or metafield ID.');
  }
  const cfg = await ensureActiveAccount();
  const baseV3 = `https://api.bigcommerce.com/stores/${cfg.storeHash}/v3`;
  const headers = authHeaders(cfg);
  const url = `${baseV3}/catalog/products/${encodeURIComponent(normalizedProductId)}/metafields/${encodeURIComponent(normalizedMetafieldId)}`;
  const response = await fetch(url, { method: 'DELETE', headers });
  if (response.status === 404) {
    throw new Error('Metafield not found. It may have already been deleted.');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(buildError('Error deleting product metafield', `${response.status} ${text}`));
  }
}

async function buildOrderExtras(baseUrl, headers, orderId) {
  const [shipping, coupons, products] = await Promise.all([
    fetchOrderRelatedCollection(baseUrl, headers, orderId, 'shipping_addresses'),
    fetchOrderRelatedCollection(baseUrl, headers, orderId, 'coupons'),
    fetchOrderRelatedCollection(baseUrl, headers, orderId, 'products'),
  ]);
  return {
    shippingAddresses: shipping.entries,
    shippingAddressesError: shipping.error || null,
    coupons: coupons.entries,
    couponsError: coupons.error || null,
    products: products.entries,
    productsError: products.error || null,
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

  let productDetails = null;
  let variantDetails = null;
  if (candidate.raw && typeof candidate.raw === "object") {
    if (candidate.raw.product || candidate.raw.variant) {
      productDetails = candidate.raw.product || null;
      variantDetails = candidate.raw.variant || null;
    } else {
      variantDetails = candidate.raw;
    }
  }

  let variantsError = null;
  if (!productDetails && candidate.productId) {
    try {
      const productUrl = `${base}/catalog/products/${encodeURIComponent(candidate.productId)}?include=variants`;
      const productResponse = await fetch(productUrl, { headers });
      if (!productResponse.ok) {
        const text = await productResponse.text();
        variantsError = buildError("Error fetching product", `${productResponse.status} ${text}`);
      } else {
        const productJson = await productResponse.json();
        if (productJson && typeof productJson === "object") {
          productDetails = productJson.data || null;
        }
      }
    } catch (e) {
      variantsError = buildError("Error fetching product", String(e));
    }
  }

  let variantsList = [];
  if (productDetails && Array.isArray(productDetails.variants)) {
    variantsList = productDetails.variants.slice();
  }

  if (!variantDetails && candidate.variantId != null) {
    const matched = variantsList.find(entry => String(entry.id) === String(candidate.variantId));
    if (matched) variantDetails = matched;
  }

  if (productDetails && !candidate.productName) {
    candidate.productName = productDetails.name ?? candidate.productName ?? null;
  }

  if (productDetails || variantDetails) {
    candidate.raw = { product: productDetails || null, variant: variantDetails || null };
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
      variants: variantsList,
      variantsError,
      parentProductId: productDetails?.id ?? candidate.productId ?? null,
      parentProductName: productDetails?.name ?? candidate.productName ?? null,
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

async function fetchB2BEntityWithPaths({ cfg, entityType, paths }) {
  const baseUrls = buildB2BBaseUrls(cfg.storeHash);
  const headers = authHeaders(cfg);
  let lastNon404Error = null;

  for (const path of paths) {
    for (const baseUrl of baseUrls) {
      const url = `${baseUrl}/${path}`;
      try {
        const response = await fetch(url, { headers });
        if (response.status === 404) {
          continue;
        }
        if (!response.ok) {
          const errorText = await response.text();
          lastNon404Error = `Error fetching ${B2B_ENTITY_CONFIG[entityType].label}: ${response.status} ${errorText}`;
          continue;
        }
        const text = await response.text();
        if (!text) continue;
        const json = JSON.parse(text);
        const payload = extractB2BPayload(json);
        if (payload && typeof payload === "object") {
          return { payload, source: `${baseUrl}/${path}` };
        }
      } catch (error) {
        lastNon404Error = `Error fetching ${B2B_ENTITY_CONFIG[entityType].label}: ${String(error)}`;
      }
    }
  }
  if (lastNon404Error) {
    throw new Error(lastNon404Error);
  }
  return null;
}

function matchesB2BEntity(entityType, payload, { lookupId = "", email = "" } = {}) {
  const data = payload && typeof payload === "object" ? payload : {};
  const idNeedle = String(lookupId || "").trim();
  const emailNeedle = String(email || "").trim().toLowerCase();
  const candidateIds = [
    data.id,
    data.company_id,
    data.user_id,
    data.order_id,
    data.invoice_id,
    data.quote_id,
  ].filter((value) => value != null).map((value) => String(value).trim());
  const candidateEmails = [
    data.email,
    data.user_email,
    data.company_email,
    data.contact_email,
  ].filter((value) => value != null).map((value) => String(value).trim().toLowerCase());
  if (idNeedle && candidateIds.some((value) => value === idNeedle)) {
    return true;
  }
  if (emailNeedle && candidateEmails.some((value) => value === emailNeedle)) {
    return true;
  }
  return false;
}

async function fetchB2BEntityFromList({ cfg, entityType, lookupId, email }) {
  const entityConfig = B2B_ENTITY_CONFIG[entityType];
  const listPaths = Array.isArray(entityConfig?.listPaths) ? entityConfig.listPaths : [];
  if (listPaths.length === 0) {
    return null;
  }
  const baseUrls = buildB2BBaseUrls(cfg.storeHash);
  const headers = authHeaders(cfg);

  for (const listPath of listPaths) {
    for (const baseUrl of baseUrls) {
      const url = `${baseUrl}/${listPath}`;
      try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
          continue;
        }
        const text = await response.text();
        if (!text) continue;
        const json = JSON.parse(text);
        let entries = [];
        if (Array.isArray(json)) {
          entries = json;
        } else if (Array.isArray(json?.data)) {
          entries = json.data;
        } else if (Array.isArray(json?.results)) {
          entries = json.results;
        }
        if (!entries.length) continue;
        const match = entries.find((entry) => matchesB2BEntity(entityType, entry, { lookupId, email }));
        if (match) {
          return { payload: match, source: `${baseUrl}/${listPath} (filtered)` };
        }
      } catch (error) {
        // continue trying other list endpoints
      }
    }
  }
  return null;
}

async function bcLookupB2B(cfg, request) {
  const entityType = String(request.b2bEntity || "").toLowerCase();
  const entityConfig = B2B_ENTITY_CONFIG[entityType];
  if (!entityConfig) {
    throw new Error("Unsupported B2B entity type.");
  }

  const rawLookupId = uniqueStrings(request.lookupId ?? null, request.id ?? null)[0] || "";
  const rawEmail = uniqueStrings(request.email ?? null)[0] || "";
  const requestDetails = {
    entity: entityType,
    lookupId: rawLookupId || null,
    email: rawEmail || null,
  };

  if (!rawLookupId && !rawEmail) {
    throw new Error(`Provide a ${entityType === "company-user" ? "company user" : entityType} ID${entityConfig.emailPaths.length > 0 ? " or email" : ""}.`);
  }
  if (!rawLookupId && rawEmail && entityConfig.emailPaths.length === 0) {
    throw new Error(`${entityConfig.label} lookups support ID only.`);
  }

  if (rawLookupId) {
    const idPaths = resolveB2BPaths(entityConfig.idPaths, { id: rawLookupId });
    const byId = await fetchB2BEntityWithPaths({ cfg, entityType, paths: idPaths });
    if (byId?.payload) {
      return normalizeB2BResult({
        entityType,
        source: byId.source,
        payload: byId.payload,
        request: requestDetails,
      });
    }
  }

  if (rawEmail && entityConfig.emailPaths.length > 0) {
    const emailPaths = resolveB2BPaths(entityConfig.emailPaths, { email: rawEmail });
    const byEmail = await fetchB2BEntityWithPaths({ cfg, entityType, paths: emailPaths });
    if (byEmail?.payload) {
      return normalizeB2BResult({
        entityType,
        source: byEmail.source,
        payload: byEmail.payload,
        request: requestDetails,
      });
    }
  }

  const byList = await fetchB2BEntityFromList({
    cfg,
    entityType,
    lookupId: rawLookupId,
    email: rawEmail,
  });
  if (byList?.payload) {
    return normalizeB2BResult({
      entityType,
      source: byList.source,
      payload: byList.payload,
      request: requestDetails,
    });
  }

  throw new Error(`${entityConfig.label} not found in BigCommerce B2B.`);
}

async function bcLookup(rawRequest) {
  const request = normalizeLookupRequest(rawRequest);
  const cfg = await ensureActiveAccount();

  let result;
  if (request.recordType === "order") {
    result = await bcLookupOrder(cfg, request);
  } else if (request.recordType === "customer") {
    result = await bcLookupCustomer(cfg, request);
  } else if (request.recordType.startsWith("b2b-")) {
    result = await bcLookupB2B(cfg, request);
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
      } else if (msg?.type === "account:get-list") {
        const [accounts, activeAccountId] = await Promise.all([
          listAccountSummaries(),
          getActiveAccountId(),
        ]);
        sendResponse({ ok: true, accounts, activeAccountId });
      } else if (msg?.type === "account:get") {
        const account = await getAccountById(msg?.id);
        sendResponse({ ok: true, account: account || null });
      } else if (msg?.type === "account:save") {
        const saved = await upsertAccount(msg?.account || {});
        const activeId = await getActiveAccountId();
        const shouldActivate = msg?.activate === true || !activeId;
        if (shouldActivate) {
          await setActiveAccountId(saved.id);
        }
        await refreshAllBadges();
        sendResponse({ ok: true, account: saved, activeAccountId: shouldActivate ? saved.id : activeId });
      } else if (msg?.type === "account:delete") {
        const removed = await removeAccount(msg?.id);
        await refreshAllBadges();
        const [accounts, activeAccountId] = await Promise.all([
          listAccountSummaries(),
          getActiveAccountId(),
        ]);
        sendResponse({ ok: removed, accounts, activeAccountId });
      } else if (msg?.type === "account:set-active") {
        await setActiveAccountId(msg?.id || null);
        await refreshAllBadges();
        sendResponse({ ok: true });
      } else if (msg?.type === "account:get-active") {
        const account = await getActiveAccount();
        sendResponse({ ok: true, account: account || null });
      } else if (msg?.type === "account:export") {
        const [accounts, activeAccountId] = await Promise.all([
          listAccounts(),
          getActiveAccountId(),
        ]);
        sendResponse({
          ok: true,
          payload: {
            format: 'bc-account-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            activeAccountId: activeAccountId || null,
            accounts,
          },
        });
      } else if (msg?.type === "account:import") {
        const payload = msg?.payload && typeof msg.payload === 'object' ? msg.payload : null;
        if (!payload || payload.format !== 'bc-account-backup' || payload.version !== 1 || !Array.isArray(payload.accounts)) {
          throw new Error('Invalid backup file format.');
        }
        const mode = msg?.mode === 'replace' ? 'replace' : 'merge';
        const result = mode === 'replace'
          ? await replaceAccounts(payload.accounts, payload.activeAccountId || null)
          : await mergeAccounts(payload.accounts, payload.activeAccountId || null);
        await refreshAllBadges();
        const accounts = await listAccountSummaries();
        sendResponse({
          ok: true,
          mode,
          importedCount: payload.accounts.length,
          totalCount: result.count,
          activeAccountId: result.activeAccountId,
          accounts,
        });
      } else if (msg?.type === 'metafields:list') {
        const productId = msg?.productId;
        const entries = await listProductMetafields(productId);
        sendResponse({ ok: true, productId, entries });
      } else if (msg?.type === 'metafields:delete') {
        const productId = msg?.productId;
        const metafieldId = msg?.metafieldId;
        await deleteProductMetafield(productId, metafieldId);
        const entries = await listProductMetafields(productId);
        sendResponse({ ok: true, productId, entries });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

scheduleBadgeRefreshAll();
