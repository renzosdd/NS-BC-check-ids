function $(id){ return document.getElementById(id); }

function createEmptyComparisonSummary() {
  return {
    hasNetSuite: false,
    hasBcResult: false,
    hasDifferences: false,
    hasComparableValues: false,
    allMatch: false,
  };
}

function normalizeLookupType(rawType) {
  const value = typeof rawType === 'string' ? rawType.toLowerCase() : '';
  if (value === 'order' || value === 'customer') return value;
  return 'item';
}

let latestNetSuitePayload = null;
let lastDetectionType = null;
let lastSearchResult = null;
let lastComparisonSummary = createEmptyComparisonSummary();
let currentLookupType = 'item';
let lookupTypeLockedByUser = false;
let currentPayloadJsonText = '';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function requestBadgeRefresh(tabId = null) {
  const message = tabId != null ? { type: "refresh-badge", tabId } : { type: "refresh-badge" };
  try {
    await chrome.runtime.sendMessage(message);
  } catch (e) {
    // ignore background errors
  }
}

function setStatus(msg, ok=null){
  const el = $('status');
  const statusClass = (ok === true)
    ? 'ok'
    : (ok === false)
      ? 'bad'
      : (ok === 'warn')
        ? 'warn'
        : 'muted';
  el.textContent = msg || '';
  el.className = `status ${statusClass}`;
}

function handleLookupError(errorMessage) {
  const message = (typeof errorMessage === 'string' && errorMessage.trim() !== '') ? errorMessage : 'Error';
  setStatus(message, false);
  if (/LOCKED/.test(message)) {
    setStatus('Locked 🔒 — use "Unlock" or Options to unlock.', false);
  }
}

function toast(msg){
  const t = $('toast');
  t.textContent = msg || 'Copied';
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 900);
}

function attachCopyHandlers(root){
  root.querySelectorAll('.copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sel = btn.getAttribute('data-copy');
      const el = root.querySelector(sel);
      const text = el?.textContent?.trim() || '';
      if (text) {
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied');
        } catch (e) {
          toast('Could not copy');
        }
      }
    });
  });
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value);
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeValue(value);
    if (normalized !== '') return normalized;
  }
  return '';
}

const ITEM_PAYLOAD_KEYS = ['sku', 'internalId', 'bcProductId', 'bcVariantId'];
const ORDER_PAYLOAD_KEYS = ['tranId', 'internalId', 'bcOrderId'];
const CUSTOMER_PAYLOAD_KEYS = ['entityId', 'email', 'internalId', 'bcCustomerId'];

function getComparableItemValue(itemData, key) {
  if (!itemData || typeof itemData !== 'object') return '';
  return normalizeValue(itemData[key]);
}

function arraysShallowEqual(a, b) {
  const arrA = Array.isArray(a) ? a : [];
  const arrB = Array.isArray(b) ? b : [];
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i += 1) {
    if (arrA[i] !== arrB[i]) return false;
  }
  return true;
}

function itemPayloadsAreEqual(a, b) {
  return ITEM_PAYLOAD_KEYS.every((key) => getComparableItemValue(a, key) === getComparableItemValue(b, key))
    && arraysShallowEqual(a?.skuCandidates, b?.skuCandidates)
    && (Number.isFinite(a?.detectedSkuCount) ? a.detectedSkuCount : 0) === (Number.isFinite(b?.detectedSkuCount) ? b.detectedSkuCount : 0);
}

function fieldsMatch(a, b, keys) {
  const safeKeys = Array.isArray(keys) ? keys : [];
  return safeKeys.every((key) => normalizeValue(a?.[key]) === normalizeValue(b?.[key]));
}

function payloadsAreEqual(a, b) {
  const typeA = a?.type || null;
  const typeB = b?.type || null;
  if (typeA !== typeB) return false;
  if (!typeA) return !typeB;
  if (typeA === 'order') {
    return fieldsMatch(a?.data || null, b?.data || null, ORDER_PAYLOAD_KEYS);
  }
  if (typeA === 'customer') {
    return fieldsMatch(a?.data || null, b?.data || null, CUSTOMER_PAYLOAD_KEYS);
  }
  return itemPayloadsAreEqual(a?.data || null, b?.data || null);
}

function normalizeDetectedPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  if (rawPayload.type && rawPayload.data && typeof rawPayload.data === 'object') {
    const type = rawPayload.type;
    const data = { ...rawPayload.data };
    if (type === 'item') {
      if (Array.isArray(data.skuCandidates)) {
        data.skuCandidates = data.skuCandidates.slice();
      } else if (Array.isArray(rawPayload.skuCandidates)) {
        data.skuCandidates = rawPayload.skuCandidates.slice();
      } else {
        data.skuCandidates = [];
      }
      if (!Number.isFinite(data.detectedSkuCount)) {
        const candidateCount = Array.isArray(data.skuCandidates) ? data.skuCandidates.filter(Boolean).length : 0;
        if (Number.isFinite(rawPayload.detectedSkuCount)) {
          data.detectedSkuCount = rawPayload.detectedSkuCount;
        } else {
          const fallbackCount = candidateCount || (data.sku ? 1 : 0);
          data.detectedSkuCount = fallbackCount;
        }
      }
    }
    return { type, data };
  }

  const skuCandidates = Array.isArray(rawPayload.skuCandidates) ? rawPayload.skuCandidates.slice() : [];
  let detectedSkuCount = 0;
  if (Number.isFinite(rawPayload.detectedSkuCount)) {
    detectedSkuCount = rawPayload.detectedSkuCount;
  } else if (skuCandidates.length > 0) {
    detectedSkuCount = skuCandidates.filter(Boolean).length;
  } else if (rawPayload.sku) {
    detectedSkuCount = 1;
  }

  return {
    type: 'item',
    data: {
      sku: rawPayload.sku ?? null,
      internalId: rawPayload.internalId ?? null,
      bcProductId: rawPayload.bcProductId ?? null,
      bcVariantId: rawPayload.bcVariantId ?? null,
      skuCandidates,
      detectedSkuCount,
    },
  };
}

function normalizeLookupResult(rawResult) {
  if (!rawResult || typeof rawResult !== 'object') return null;
  const recordType = normalizeLookupType(rawResult.recordType);
  const data = rawResult.data && typeof rawResult.data === 'object' ? { ...rawResult.data } : null;
  const normalized = {
    recordType,
    source: rawResult.source || null,
    data,
    raw: rawResult.raw ?? null,
  };
  if (rawResult.request && typeof rawResult.request === 'object') {
    normalized.request = { ...rawResult.request };
  }
  if (rawResult.extras && typeof rawResult.extras === 'object') {
    try {
      normalized.extras = JSON.parse(JSON.stringify(rawResult.extras));
    } catch (e) {
      normalized.extras = { ...rawResult.extras };
    }
  }
  return normalized;
}

function getLookupTypeLabel(type) {
  const normalized = normalizeLookupType(type);
  if (normalized === 'order') return 'order';
  if (normalized === 'customer') return 'customer';
  return 'item';
}

function updateLookupTypeButtons() {
  const buttons = document.querySelectorAll('.lookup-type-btn');
  buttons.forEach((btn) => {
    const type = normalizeLookupType(btn?.getAttribute('data-type'));
    const isActive = type === currentLookupType;
    if (isActive) {
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    } else {
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    }
  });
}

function setLookupType(type, { userInitiated = false, syncWithDetection = false } = {}) {
  const nextType = normalizeLookupType(type);
  const changed = currentLookupType !== nextType;
  currentLookupType = nextType;
  if (userInitiated) {
    lookupTypeLockedByUser = true;
  }
  updateLookupTypeButtons();
  updateLookupControls();
  if (syncWithDetection) {
    setLookupInputFromDetection(latestNetSuitePayload, { force: true });
  } else if (changed && latestNetSuitePayload && normalizeLookupType(latestNetSuitePayload.type) === currentLookupType) {
    setLookupInputFromDetection(latestNetSuitePayload, { force: true });
  }
}

function detectionHasData(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const { type, data } = payload;
  if (!data || typeof data !== 'object') return false;
  if (type === 'order') {
    return [data.tranId, data.internalId, data.bcOrderId].some((value) => normalizeValue(value) !== '');
  }
  if (type === 'customer') {
    return [data.entityId, data.email, data.internalId, data.bcCustomerId].some((value) => normalizeValue(value) !== '');
  }
  if (type === 'item') {
    return [data.sku, data.internalId, data.bcProductId, data.bcVariantId].some((value) => normalizeValue(value) !== '')
      || (Array.isArray(data.skuCandidates) && data.skuCandidates.length > 0);
  }
  return false;
}

function renderIdRow(label, id, value, options = {}) {
  const { copy = false, highlight = false, matchState = null, note = null } = options;
  const normalized = normalizeValue(value);
  const display = normalized !== '' ? escapeHtml(normalized) : '&mdash;';
  const classes = ['id-row'];
  if (copy) classes.push('has-action');
  if (highlight) classes.push('highlight');
  if (matchState === 'match') classes.push('match');
  else if (matchState === 'mismatch') classes.push('mismatch');
  const copyButton = copy ? `<button class="btn ghost copy" data-copy="#${id}">Copy</button>` : '';
  const noteHtml = (typeof note === 'string' && note.trim() !== '') ? note : '';
  return `
    <div class="${classes.join(' ')}">
      <div class="id-label">${escapeHtml(label)}</div>
      <code class="id-value" id="${id}">${display}</code>
      ${copyButton}
      ${noteHtml}
    </div>
  `;
}

function determineMatchState(netsuiteValue, bcValue) {
  const ns = normalizeValue(netsuiteValue);
  const bc = normalizeValue(bcValue);
  const nsEmpty = ns === '';
  const bcEmpty = bc === '';
  if (nsEmpty && bcEmpty) return null;
  if (nsEmpty || bcEmpty) return 'mismatch';
  return ns === bc ? 'match' : 'mismatch';
}

function renderNetSuiteRow(label, id, nsValue, bcValue, matchState, options = {}) {
  const { copy = false, highlight = false, note: customNote } = options;
  let note = '';
  if (customNote !== undefined) {
    note = customNote || '';
  } else if (matchState === 'mismatch') {
    const bcNormalized = normalizeValue(bcValue);
    const bcDisplay = bcNormalized !== '' ? escapeHtml(bcNormalized) : '&mdash;';
    note = `<div class="comparison-note">BigCommerce: <code>${bcDisplay}</code></div>`;
  }
  return renderIdRow(label, id, nsValue, { copy, highlight, matchState, note });
}

function renderItemSummary(itemData) {
  const nsRoot = $('itemSummary');
  const nsMeta = $('itemMeta');
  const summaryMeta = $('summaryMeta');

  const comparisonSummary = createEmptyComparisonSummary();
  const bcResult = (lastSearchResult?.recordType === 'item') ? lastSearchResult : null;
  const bcData = bcResult?.data || null;

  const netsuiteSku = itemData?.sku ?? null;
  const netsuiteInternalId = itemData?.internalId ?? null;
  const netsuiteBcProductId = itemData?.bcProductId ?? null;
  const netsuiteBcVariantId = itemData?.bcVariantId ?? null;

  const bcSku = bcData?.sku ?? null;
  const bcProductId = bcData?.bcProductId ?? null;
  const bcVariantId = bcData?.bcVariantId ?? null;

  const productMatchState = bcResult ? determineMatchState(netsuiteBcProductId, bcProductId) : null;
  const variantMatchState = bcResult ? determineMatchState(netsuiteBcVariantId, bcVariantId) : null;
  const skuMatchState = bcResult ? determineMatchState(netsuiteSku, bcSku) : null;

  const nsValues = itemData ? [netsuiteSku, netsuiteInternalId, netsuiteBcProductId, netsuiteBcVariantId] : [];
  const nsHasAny = nsValues.some((value) => normalizeValue(value) !== '');
  comparisonSummary.hasNetSuite = nsHasAny;

  if (nsRoot) {
    if (nsHasAny || bcResult) {
      const rows = [
        renderNetSuiteRow('SKU', 'ns-item-sku', netsuiteSku, bcSku, skuMatchState),
        renderNetSuiteRow('Internal ID', 'ns-item-internal', netsuiteInternalId, null, null),
        renderNetSuiteRow('BC Product ID', 'ns-bc-product', netsuiteBcProductId, bcProductId, productMatchState),
        renderNetSuiteRow('BC Variant ID', 'ns-bc-variant', netsuiteBcVariantId, bcVariantId, variantMatchState),
      ];
      nsRoot.innerHTML = rows.join('');
    } else {
      nsRoot.innerHTML = '<div class="placeholder muted">No detected data.</div>';
    }
  }

  if (nsMeta) {
    nsMeta.textContent = nsHasAny ? 'NetSuite item data detected.' : 'Waiting for detected data.';
  }

  let hasDifferences = false;
  let hasComparableValues = false;
  if (bcResult) {
    const comparisons = [
      { matchState: productMatchState },
      { matchState: variantMatchState },
      { matchState: skuMatchState },
    ];
    comparisons.forEach(({ matchState }) => {
      if (!matchState) return;
      hasComparableValues = true;
      if (matchState === 'mismatch') {
        hasDifferences = true;
      }
    });
  }

  comparisonSummary.hasBcResult = !!bcResult;
  comparisonSummary.hasDifferences = hasDifferences;
  comparisonSummary.hasComparableValues = !!bcResult && hasComparableValues;
  if (comparisonSummary.hasBcResult) {
    comparisonSummary.allMatch = comparisonSummary.hasComparableValues && !comparisonSummary.hasDifferences;
  }

  let summaryMetaText = 'Review detected NetSuite item identifiers. BigCommerce differences will appear inline after a lookup.';
  if (summaryMeta) {
    if (bcResult) {
      if (comparisonSummary.hasComparableValues) {
        summaryMetaText = comparisonSummary.hasDifferences
          ? 'BigCommerce differences appear inline below.'
          : 'All comparable BigCommerce values match NetSuite.';
      } else {
        summaryMetaText = 'Lookup completed, but there were no comparable IDs to review.';
      }
      if (bcResult?.source) {
        summaryMetaText += ` · ${bcResult.source}`;
      }
    }
    summaryMeta.textContent = summaryMetaText;
  }

  return { comparisonSummary, summaryMetaText };
}

function renderOrderSummary(orderData) {
  const nsRoot = $('orderSummary');
  const nsMeta = $('orderMeta');
  const summaryMeta = $('summaryMeta');

  const comparisonSummary = createEmptyComparisonSummary();
  const bcResult = (lastSearchResult?.recordType === 'order') ? lastSearchResult : null;
  const bcData = bcResult?.data || null;

  const netsuiteTranId = orderData?.tranId ?? null;
  const netsuiteInternalId = orderData?.internalId ?? null;
  const netsuiteBcOrderId = orderData?.bcOrderId ?? null;

  const bcOrderId = bcData?.id ?? null;
  const bcOrderNumber = bcData?.orderNumber ?? null;
  const bcReference = bcData?.reference ?? null;

  const orderIdMatchState = bcResult ? determineMatchState(netsuiteBcOrderId, bcOrderId) : null;

  let orderNumberMatchState = null;
  let orderNumberNote;
  if (bcResult) {
    const nsNormalized = normalizeValue(netsuiteTranId);
    const bcNumberNormalized = normalizeValue(bcOrderNumber);
    const bcReferenceNormalized = normalizeValue(bcReference);
    const hasBcNumber = bcNumberNormalized !== '';
    const hasBcReference = bcReferenceNormalized !== '';
    const matchesNumber = nsNormalized !== '' && nsNormalized === bcNumberNormalized;
    const matchesReference = nsNormalized !== '' && nsNormalized === bcReferenceNormalized;

    if (matchesNumber || matchesReference) {
      orderNumberMatchState = 'match';
    } else if (nsNormalized === '') {
      orderNumberMatchState = (hasBcNumber || hasBcReference) ? 'mismatch' : null;
    } else if (hasBcNumber || hasBcReference) {
      orderNumberMatchState = 'mismatch';
    }

    if (orderNumberMatchState === 'mismatch') {
      const bcParts = [];
      if (hasBcNumber) bcParts.push(`Order #: <code>${escapeHtml(bcNumberNormalized)}</code>`);
      if (hasBcReference) bcParts.push(`Reference: <code>${escapeHtml(bcReferenceNormalized)}</code>`);
      const joined = bcParts.length ? bcParts.join(' · ') : '<code>&mdash;</code>';
      orderNumberNote = `<div class="comparison-note">BigCommerce: ${joined}</div>`;
    }
  }

  const nsValues = orderData ? [netsuiteTranId, netsuiteInternalId, netsuiteBcOrderId] : [];
  const nsHasAny = nsValues.some((value) => normalizeValue(value) !== '');
  comparisonSummary.hasNetSuite = nsHasAny;

  if (nsRoot) {
    if (nsHasAny || bcResult) {
      const rows = [
        renderNetSuiteRow('Tran ID', 'ns-order-tranid', netsuiteTranId, bcOrderNumber || bcReference, orderNumberMatchState, { note: orderNumberNote }),
        renderNetSuiteRow('Internal ID', 'ns-order-internal', netsuiteInternalId, null, null),
        renderNetSuiteRow('BC Order ID', 'ns-bc-order', netsuiteBcOrderId, bcOrderId, orderIdMatchState),
      ];
      nsRoot.innerHTML = rows.join('');
    } else {
      nsRoot.innerHTML = '<div class="placeholder muted">No detected data.</div>';
    }
  }

  if (nsMeta) {
    nsMeta.textContent = nsHasAny ? 'NetSuite order data detected.' : 'Waiting for detected data.';
  }

  let hasDifferences = false;
  let hasComparableValues = false;
  if (bcResult) {
    const comparisons = [
      { matchState: orderNumberMatchState },
      { matchState: orderIdMatchState },
    ];
    comparisons.forEach(({ matchState }) => {
      if (!matchState) return;
      hasComparableValues = true;
      if (matchState === 'mismatch') {
        hasDifferences = true;
      }
    });
  }

  comparisonSummary.hasBcResult = !!bcResult;
  comparisonSummary.hasDifferences = hasDifferences;
  comparisonSummary.hasComparableValues = !!bcResult && hasComparableValues;
  if (comparisonSummary.hasBcResult) {
    comparisonSummary.allMatch = comparisonSummary.hasComparableValues && !comparisonSummary.hasDifferences;
  }

  let summaryMetaText = 'Review detected NetSuite order identifiers. BigCommerce differences will appear inline after a lookup.';
  if (summaryMeta) {
    if (bcResult) {
      if (comparisonSummary.hasComparableValues) {
        summaryMetaText = comparisonSummary.hasDifferences
          ? 'BigCommerce differences appear inline below.'
          : 'All comparable BigCommerce values match NetSuite.';
      } else {
        summaryMetaText = 'Lookup completed, but there were no comparable IDs to review.';
      }
      if (bcResult?.source) {
        summaryMetaText += ` · ${bcResult.source}`;
      }
    }
    summaryMeta.textContent = summaryMetaText;
  }

  return { comparisonSummary, summaryMetaText };
}

function renderCustomerSummary(customerData) {
  const nsRoot = $('customerSummary');
  const nsMeta = $('customerMeta');
  const summaryMeta = $('summaryMeta');

  const comparisonSummary = createEmptyComparisonSummary();
  const bcResult = (lastSearchResult?.recordType === 'customer') ? lastSearchResult : null;
  const bcData = bcResult?.data || null;

  const netsuiteEntityId = customerData?.entityId ?? null;
  const netsuiteInternalId = customerData?.internalId ?? null;
  const netsuiteEmail = customerData?.email ?? null;
  const netsuiteBcCustomerId = customerData?.bcCustomerId ?? null;

  const bcCustomerId = bcData?.id ?? null;
  const bcEmail = bcData?.email ?? null;

  const customerIdMatchState = bcResult ? determineMatchState(netsuiteBcCustomerId, bcCustomerId) : null;
  const emailMatchState = bcResult ? determineMatchState(netsuiteEmail, bcEmail) : null;

  const nsValues = customerData ? [netsuiteEntityId, netsuiteInternalId, netsuiteEmail, netsuiteBcCustomerId] : [];
  const nsHasAny = nsValues.some((value) => normalizeValue(value) !== '');
  comparisonSummary.hasNetSuite = nsHasAny;

  if (nsRoot) {
    if (nsHasAny || bcResult) {
      const rows = [
        renderNetSuiteRow('Entity ID', 'ns-customer-entityid', netsuiteEntityId, null, null),
        renderNetSuiteRow('Email', 'ns-customer-email', netsuiteEmail, bcEmail, emailMatchState),
        renderNetSuiteRow('Internal ID', 'ns-customer-internal', netsuiteInternalId, null, null),
        renderNetSuiteRow('BC Customer ID', 'ns-bc-customer', netsuiteBcCustomerId, bcCustomerId, customerIdMatchState),
      ];
      nsRoot.innerHTML = rows.join('');
    } else {
      nsRoot.innerHTML = '<div class="placeholder muted">No detected data.</div>';
    }
  }

  if (nsMeta) {
    nsMeta.textContent = nsHasAny ? 'NetSuite customer data detected.' : 'Waiting for detected data.';
  }

  let hasDifferences = false;
  let hasComparableValues = false;
  if (bcResult) {
    const comparisons = [
      { matchState: emailMatchState },
      { matchState: customerIdMatchState },
    ];
    comparisons.forEach(({ matchState }) => {
      if (!matchState) return;
      hasComparableValues = true;
      if (matchState === 'mismatch') {
        hasDifferences = true;
      }
    });
  }

  comparisonSummary.hasBcResult = !!bcResult;
  comparisonSummary.hasDifferences = hasDifferences;
  comparisonSummary.hasComparableValues = !!bcResult && hasComparableValues;
  if (comparisonSummary.hasBcResult) {
    comparisonSummary.allMatch = comparisonSummary.hasComparableValues && !comparisonSummary.hasDifferences;
  }

  let summaryMetaText = 'Review detected NetSuite customer identifiers. BigCommerce differences will appear inline after a lookup.';
  if (summaryMeta) {
    if (bcResult) {
      if (comparisonSummary.hasComparableValues) {
        summaryMetaText = comparisonSummary.hasDifferences
          ? 'BigCommerce differences appear inline below.'
          : 'All comparable BigCommerce values match NetSuite.';
      } else {
        summaryMetaText = 'Lookup completed, but there were no comparable IDs to review.';
      }
      if (bcResult?.source) {
        summaryMetaText += ` · ${bcResult.source}`;
      }
    }
    summaryMeta.textContent = summaryMetaText;
  }

  return { comparisonSummary, summaryMetaText };
}

function renderIdSummary(){
  const card = $('idSummaryCard');
  const summaryMeta = $('summaryMeta');
  const itemSection = $('itemSummarySection');
  const orderSection = $('orderSummarySection');
  const customerSection = $('customerSummarySection');

  let metaText = 'NetSuite identifiers appear automatically when viewing a record.';
  let comparisonSummary = createEmptyComparisonSummary();

  if (!card) {
    lastComparisonSummary = comparisonSummary;
    return comparisonSummary;
  }

  const detection = latestNetSuitePayload || null;
  const detectionType = normalizeLookupType(detection?.type || null);
  const detectionData = detection?.data || null;

  card.classList.remove('hidden');
  if (itemSection) itemSection.classList.add('hidden');
  if (orderSection) orderSection.classList.add('hidden');
  if (customerSection) customerSection.classList.add('hidden');

  let summaryResult = null;
  if (detectionType === 'order') {
    if (orderSection) orderSection.classList.remove('hidden');
    summaryResult = renderOrderSummary(detectionData);
  } else if (detectionType === 'customer') {
    if (customerSection) customerSection.classList.remove('hidden');
    summaryResult = renderCustomerSummary(detectionData);
  } else {
    if (itemSection) itemSection.classList.remove('hidden');
    summaryResult = renderItemSummary(detectionData);
  }

  if (summaryResult && typeof summaryResult === 'object') {
    if (summaryResult.comparisonSummary) {
      comparisonSummary = summaryResult.comparisonSummary;
    }
    if (summaryResult.summaryMetaText) {
      metaText = summaryResult.summaryMetaText;
    }
  }

  if (summaryMeta) {
    summaryMeta.textContent = metaText;
  }

  attachCopyHandlers(card);
  lastComparisonSummary = comparisonSummary;
  return comparisonSummary;
}

function renderBcSummaryRow(label, value) {
  const normalized = normalizeValue(value);
  const display = normalized !== '' ? escapeHtml(normalized) : '&mdash;';
  return `
    <div class="bc-summary-row">
      <div class="bc-summary-label">${escapeHtml(label)}</div>
      <div class="bc-summary-value">${display}</div>
    </div>
  `;
}

function getResultPayloadObject(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.raw && typeof result.raw === 'object') return result.raw;
  if (result.data && typeof result.data === 'object') return result.data;
  return null;
}

function buildSuggestedFilename(result) {
  const type = getLookupTypeLabel(result?.recordType || 'item');
  let hint = '';
  if (type === 'order') {
    hint = normalizeValue(result?.data?.orderNumber || result?.data?.id || '');
  } else if (type === 'customer') {
    hint = normalizeValue(result?.data?.email || result?.data?.id || '');
  } else {
    hint = normalizeValue(result?.data?.sku || result?.data?.bcProductId || '');
  }
  if (!hint) {
    hint = String(Date.now());
  } else {
    hint = hint.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  return `bigcommerce-${type}-${hint || 'payload'}.json`;
}

function renderBigCommerceDetails() {
  const card = $('bcResultCard');
  const meta = $('bcResultMeta');
  const summary = $('bcResultSummary');
  const copyBtn = $('bcCopyJson');
  const downloadBtn = $('bcDownloadJson');
  const viewBtn = $('bcViewPayload');
  const title = $('bcResultTitle');
  if (!card || !meta || !summary || !copyBtn || !downloadBtn || !viewBtn || !title) return;

  const result = lastSearchResult || null;
  if (!result) {
    title.textContent = 'BigCommerce Result';
    meta.textContent = 'Run a lookup to view the BigCommerce payload.';
    summary.innerHTML = '<div class="placeholder muted">No lookup yet.</div>';
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
    viewBtn.disabled = true;
    currentPayloadJsonText = '';
    return;
  }

  const type = getLookupTypeLabel(result.recordType);
  const typeTitle = type.charAt(0).toUpperCase() + type.slice(1);
  title.textContent = `BigCommerce ${typeTitle}`;

  const metaParts = [`${typeTitle} result`];
  if (result.source) metaParts.push(result.source);
  meta.textContent = metaParts.join(' · ');

  let summaryHtml = '';
  const data = result.data || {};
  if (type === 'order') {
    summaryHtml = [
      renderBcSummaryRow('Order ID', data.id),
      renderBcSummaryRow('Order number', data.orderNumber),
      renderBcSummaryRow('Reference', data.reference),
      renderBcSummaryRow('Customer ID', data.customerId),
      renderBcSummaryRow('Email', data.email),
      renderBcSummaryRow('Status', data.status || data.statusId),
      renderBcSummaryRow('Total (inc tax)', data.totalIncTax),
    ].join('');
  } else if (type === 'customer') {
    summaryHtml = [
      renderBcSummaryRow('Customer ID', data.id),
      renderBcSummaryRow('Email', data.email),
      renderBcSummaryRow('Name', [data.firstName, data.lastName].filter(Boolean).join(' ') || null),
      renderBcSummaryRow('Company', data.company),
      renderBcSummaryRow('Phone', data.phone),
      renderBcSummaryRow('Group', data.customerGroupId),
    ].join('');
  } else {
    summaryHtml = [
      renderBcSummaryRow('SKU', data.sku),
      renderBcSummaryRow('Product ID', data.bcProductId),
      renderBcSummaryRow('Variant ID', data.bcVariantId),
      renderBcSummaryRow('Product name', data.productName),
    ].join('');
  }
  summary.innerHTML = summaryHtml || '<div class="placeholder muted">No summary data returned.</div>';

  const payload = getResultPayloadObject(result);
  currentPayloadJsonText = payload ? JSON.stringify(payload, null, 2) : '';
  const hasPayload = currentPayloadJsonText !== '';
  copyBtn.disabled = !hasPayload;
  downloadBtn.disabled = !hasPayload;
  viewBtn.disabled = !result;
}

async function copyPayloadJson() {
  if (!currentPayloadJsonText) {
    toast('No payload to copy');
    return;
  }
  try {
    await navigator.clipboard.writeText(currentPayloadJsonText);
    toast('JSON copied');
  } catch (e) {
    toast('Could not copy JSON');
  }
}

function downloadPayloadJson() {
  if (!currentPayloadJsonText || !lastSearchResult) {
    toast('No payload to download');
    return;
  }
  try {
    const blob = new Blob([currentPayloadJsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = buildSuggestedFilename(lastSearchResult);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('Download started');
  } catch (e) {
    toast('Could not download JSON');
  }
}

async function openPayloadViewer() {
  if (!lastSearchResult) {
    toast('No payload to show');
    return;
  }
  try {
    const recordType = normalizeLookupType(lastSearchResult.recordType || 'item');
    const url = chrome.runtime.getURL(`viewer.html?type=${encodeURIComponent(recordType)}`);
    await chrome.windows.create({ url, type: 'popup', width: 720, height: 640 });
  } catch (e) {
    toast('Could not open viewer');
  }
}

function renderBCCard(result){
  if (arguments.length > 0) {
    if (result && typeof result === 'object' && !result.error) {
      const normalized = normalizeLookupResult(result);
      lastSearchResult = normalized;
      if (normalized?.recordType) {
        if (!lookupTypeLockedByUser || currentLookupType !== normalizeLookupType(normalized.recordType)) {
          setLookupType(normalized.recordType);
        }
      }
    } else {
      lastSearchResult = null;
    }
  }
  renderBigCommerceDetails();
  return renderIdSummary();
}

function updateLookupControls() {
  const lookupType = currentLookupType || 'item';
  const input = $('sku');
  const lookupBtn = $('lookup');
  if (input) {
    if (lookupType === 'order') {
      input.placeholder = 'BigCommerce order ID or number...';
    } else if (lookupType === 'customer') {
      input.placeholder = 'Customer email or BigCommerce ID...';
    } else {
      input.placeholder = 'SKU...';
    }
  }
  if (lookupBtn) {
    if (lookupType === 'order') {
      lookupBtn.textContent = 'Look up order';
    } else if (lookupType === 'customer') {
      lookupBtn.textContent = 'Look up customer';
    } else {
      lookupBtn.textContent = 'Look up';
    }
  }
}

function setLookupInputFromDetection(payload, { force = false } = {}) {
  const input = $('sku');
  if (!input) return;
  const existing = normalizeValue(input.value);
  if (!force && existing !== '') return;
  const detectionType = normalizeLookupType(payload?.type || null);
  if (!force && detectionType !== currentLookupType) return;
  const data = payload?.data || null;
  let nextValue = '';
  if (detectionType === 'order') {
    nextValue = pickFirstNonEmpty(data?.bcOrderId, data?.tranId, data?.internalId);
  } else if (detectionType === 'customer') {
    nextValue = pickFirstNonEmpty(data?.email, data?.bcCustomerId, data?.entityId);
  } else {
    nextValue = pickFirstNonEmpty(data?.sku, data?.internalId);
  }
  input.value = nextValue;
}

function collectOrderLookupCriteria() {
  const criteria = { bcOrderIds: [], orderNumbers: [] };
  const detectionData = latestNetSuitePayload?.data || null;
  const inputValue = normalizeValue($('sku')?.value ?? '');
  const idSet = new Set();
  const numberSet = new Set();

  const addId = (value) => {
    const normalized = normalizeValue(value);
    if (!normalized) return;
    idSet.add(normalized);
  };
  const addNumber = (value) => {
    const normalized = normalizeValue(value);
    if (!normalized) return;
    numberSet.add(normalized);
  };

  if (inputValue) {
    addNumber(inputValue);
    if (/^\d+$/.test(inputValue)) {
      addId(inputValue);
    }
  }
  if (detectionData) {
    if (detectionData.bcOrderId) {
      addId(detectionData.bcOrderId);
      addNumber(detectionData.bcOrderId);
    }
    if (detectionData.tranId) {
      addNumber(detectionData.tranId);
    }
  }

  criteria.bcOrderIds = Array.from(idSet);
  criteria.orderNumbers = Array.from(numberSet);
  return criteria;
}

function collectCustomerLookupCriteria() {
  const criteria = { customerIds: [], emails: [] };
  const detectionData = latestNetSuitePayload?.data || null;
  const inputValue = normalizeValue($('sku')?.value ?? '');
  const idSet = new Set();
  const emailSet = new Set();

  const addId = (value) => {
    const normalized = normalizeValue(value);
    if (!normalized) return;
    idSet.add(normalized);
  };
  const addEmail = (value) => {
    const normalized = normalizeValue(value);
    if (!normalized) return;
    emailSet.add(normalized);
  };

  if (inputValue) {
    if (/^\d+$/.test(inputValue)) {
      addId(inputValue);
    }
    if (/@/.test(inputValue)) {
      addEmail(inputValue);
    }
  }
  if (detectionData) {
    if (detectionData.bcCustomerId) {
      addId(detectionData.bcCustomerId);
    }
    if (detectionData.email) {
      addEmail(detectionData.email);
    }
  }

  criteria.customerIds = Array.from(idSet);
  criteria.emails = Array.from(emailSet);
  return criteria;
}

async function performItemLookup() {
  const sku = normalizeValue($('sku')?.value ?? '');
  if (!sku) {
    setStatus('Enter an SKU.', false);
    return;
  }
  setStatus('Looking up...');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'bc-lookup', recordType: 'item', sku });
    if (res?.ok) {
      const summary = renderBCCard(res?.data ?? null);
      applyLookupStatusFromSummary(summary, 'item');
    } else {
      renderBCCard(null);
      handleLookupError(res?.error);
    }
  } catch (e) {
    renderBCCard(null);
    handleLookupError(String(e));
  }
}

async function performOrderLookup() {
  const { bcOrderIds, orderNumbers } = collectOrderLookupCriteria();
  if (bcOrderIds.length === 0 && orderNumbers.length === 0) {
    setStatus('Provide a BigCommerce order ID or order number.', false);
    return;
  }
  setStatus('Looking up order...');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'bc-lookup',
      recordType: 'order',
      bcOrderIds,
      orderNumbers,
    });
    if (res?.ok) {
      const summary = renderBCCard(res?.data ?? null);
      applyLookupStatusFromSummary(summary, 'order');
    } else {
      renderBCCard(null);
      handleLookupError(res?.error);
    }
  } catch (e) {
    renderBCCard(null);
    handleLookupError(String(e));
  }
}

async function performCustomerLookup() {
  const { customerIds, emails } = collectCustomerLookupCriteria();
  if (customerIds.length === 0 && emails.length === 0) {
    setStatus('Provide a BigCommerce customer ID or email.', false);
    return;
  }
  setStatus('Looking up customer...');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'bc-lookup',
      recordType: 'customer',
      customerIds,
      emails,
    });
    if (res?.ok) {
      const summary = renderBCCard(res?.data ?? null);
      applyLookupStatusFromSummary(summary, 'customer');
    } else {
      renderBCCard(null);
      handleLookupError(res?.error);
    }
  } catch (e) {
    renderBCCard(null);
    handleLookupError(String(e));
  }
}

function getLookupStatusFromSummary(summary, lookupType = null) {
  const detectionType = normalizeLookupType(latestNetSuitePayload?.type || null);
  const requestedType = normalizeLookupType(lookupType || currentLookupType || detectionType);
  const matchingResult = (lastSearchResult?.recordType === requestedType) ? lastSearchResult : null;
  const label = requestedType === 'order'
    ? 'BigCommerce order'
    : requestedType === 'customer'
      ? 'BigCommerce customer'
      : 'BigCommerce item';

  if (!matchingResult) {
    return { message: `No ${label} found.`, tone: false };
  }

  if (requestedType !== detectionType) {
    return { message: `${label} retrieved.`, tone: true };
  }

  const effectiveSummary = (summary && typeof summary === 'object') ? summary : lastComparisonSummary;
  if (!effectiveSummary || !effectiveSummary.hasBcResult) {
    return { message: `${label} retrieved.`, tone: true };
  }
  if (effectiveSummary.hasDifferences) {
    if (requestedType === 'order') {
      return { message: 'BigCommerce order differs from NetSuite values.', tone: 'warn' };
    }
    if (requestedType === 'customer') {
      return { message: 'BigCommerce customer differs from NetSuite values.', tone: 'warn' };
    }
    return { message: 'Discrepancies found — see inline BigCommerce values.', tone: 'warn' };
  }
  if (effectiveSummary.allMatch) {
    if (requestedType === 'order') {
      return { message: 'BigCommerce order matches NetSuite values.', tone: true };
    }
    if (requestedType === 'customer') {
      return { message: 'BigCommerce customer matches NetSuite values.', tone: true };
    }
    return { message: 'All comparable BigCommerce values match NetSuite.', tone: true };
  }
  if (!effectiveSummary.hasComparableValues) {
    return { message: 'Lookup completed, but there were no IDs to compare.', tone: null };
  }
  return { message: 'Lookup completed. BigCommerce results are shown inline.', tone: null };
}

function applyLookupStatusFromSummary(summary, lookupType = null) {
  const { message, tone } = getLookupStatusFromSummary(summary, lookupType);
  setStatus(message, tone);
}


function renderNetSuite(payload){
  const nextPayload = normalizeDetectedPayload(payload) || null;
  const payloadChanged = !payloadsAreEqual(latestNetSuitePayload, nextPayload);
  const previousType = lastDetectionType;
  const nextType = normalizeLookupType(nextPayload?.type || null);
  latestNetSuitePayload = nextPayload;
  if (payloadChanged && lastSearchResult) {
    lastSearchResult = null;
    renderBigCommerceDetails();
  }
  const detectionTypeChanged = previousType !== nextType;
  if (!lookupTypeLockedByUser) {
    setLookupType(nextType, { syncWithDetection: true });
  } else if (detectionTypeChanged) {
    updateLookupControls();
  }
  setLookupInputFromDetection(nextPayload, { force: !lookupTypeLockedByUser && detectionTypeChanged });
  lastDetectionType = nextType;
  renderIdSummary();
  renderBigCommerceDetails();
}

async function fetchDetectedPayloadForTab(tabId){
  let payload = null;
  let hadResponse = false;
  try {
    const res = await chrome.runtime.sendMessage({ type: "get-last-detected", tabId });
    if (res?.ok) {
      hadResponse = true;
      if (Object.prototype.hasOwnProperty.call(res, 'payload')) {
        payload = res.payload ?? null;
      }
    }
  } catch (e) {
    // ignore background errors
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "get-detected-payload" });
    if (res) {
      hadResponse = true;
      if (typeof res === 'object') {
        if (res && Object.prototype.hasOwnProperty.call(res, 'payload')) {
          payload = res.payload ?? null;
        } else if (res) {
          payload = res;
        }
      }
    }
  } catch (e) {
    if (!hadResponse) throw e;
  }
  if (!hadResponse) {
    throw new Error('NO_RESPONSE');
  }
  return normalizeDetectedPayload(payload) || null;
}

async function applyDetectedFromPage(context='load'){
  const tab = await getActiveTab();
  if (!tab) {
    renderNetSuite(null);
    if (context === 'use') {
      setStatus('No active tab.', false);
    } else {
      setStatus('No SKU detected. You can enter it manually.', null);
    }
    await requestBadgeRefresh();
    return null;
  }
  let payload = null;
  try {
    payload = await fetchDetectedPayloadForTab(tab.id);
    renderNetSuite(payload);
    const detectionType = payload?.type || null;
    const detectionData = payload?.data || null;
    if (detectionType === 'item' && detectionData?.sku) {
      $('sku').value = detectionData.sku;
    }
    const hasAny = detectionHasData(payload);
    if (context === 'load') {
      if (detectionType === 'item') {
        if (detectionData?.sku) {
          setStatus('SKU detected automatically.', true);
        } else if (hasAny) {
          setStatus('NetSuite item data detected automatically.', true);
        } else {
          setStatus('No SKU detected. You can enter it manually.', null);
        }
      } else if (detectionType === 'order') {
        setStatus(hasAny ? 'NetSuite order detected automatically.' : 'No NetSuite order data detected.', hasAny ? true : null);
      } else if (detectionType === 'customer') {
        setStatus(hasAny ? 'NetSuite customer detected automatically.' : 'No NetSuite customer data detected.', hasAny ? true : null);
      } else {
        setStatus('No SKU detected. You can enter it manually.', null);
      }
    } else if (context === 'use') {
      if (detectionType === 'item') {
        if (detectionData?.sku) {
          setStatus('Detected SKU applied.', true);
        } else if (hasAny) {
          setStatus('Detected NetSuite data, but no SKU.', true);
        } else {
          setStatus('No SKU detected on this page.', false);
        }
      } else if (detectionType === 'order') {
        setStatus(hasAny ? 'NetSuite order detected on this page.' : 'No order data detected on this page.', hasAny ? true : false);
      } else if (detectionType === 'customer') {
        setStatus(hasAny ? 'NetSuite customer detected on this page.' : 'No customer data detected on this page.', hasAny ? true : false);
      } else {
        setStatus('No SKU detected on this page.', false);
      }
    }
    return payload;
  } catch (e) {
    renderNetSuite(null);
    setStatus('Could not read the current page (is it NetSuite?).', false);
    return null;
  } finally {
    await requestBadgeRefresh(tab?.id ?? null);
  }
}

// Unlock flow
$('unlockBtn').addEventListener('click', async () => {
  const pass = prompt('Enter your password to unlock credentials:');
  if (!pass) return;
  const res = await chrome.runtime.sendMessage({ type: "unlock-creds", passphrase: pass });
  setStatus(res?.ok ? 'Credentials unlocked ✅' : (res?.error || 'Error'), !!res?.ok);
  await requestBadgeRefresh();
});

document.addEventListener('DOMContentLoaded', () => {
  updateLookupTypeButtons();
  updateLookupControls();
  renderBigCommerceDetails();
  document.querySelectorAll('.lookup-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type');
      setLookupType(type, { userInitiated: true });
    });
  });
  $('bcViewPayload')?.addEventListener('click', () => { openPayloadViewer(); });
  $('bcCopyJson')?.addEventListener('click', () => { copyPayloadJson(); });
  $('bcDownloadJson')?.addEventListener('click', () => { downloadPayloadJson(); });
  applyDetectedFromPage('load');
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('useDetected').addEventListener('click', () => {
  lookupTypeLockedByUser = false;
  if (latestNetSuitePayload?.type) {
    setLookupType(latestNetSuitePayload.type, { syncWithDetection: true });
  }
  applyDetectedFromPage('use');
});

$('lookup').addEventListener('click', async () => {
  const lookupType = currentLookupType || 'item';
  if (lookupType === 'order') {
    await performOrderLookup();
  } else if (lookupType === 'customer') {
    await performCustomerLookup();
  } else {
    await performItemLookup();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "bc-lookup-result") {
    if (msg.result && !msg.result.error) {
      const summary = renderBCCard(msg.result);
      applyLookupStatusFromSummary(summary, msg.result?.recordType || null);
      const detectionType = latestNetSuitePayload?.type || 'item';
      if (detectionType === 'item' && normalizeValue($('sku')?.value ?? '') === '') {
        $('sku').value = normalizeValue(msg.sku || '');
      }
    } else {
      renderBCCard(null);
      handleLookupError(msg.result?.error);
    }
  }
});
