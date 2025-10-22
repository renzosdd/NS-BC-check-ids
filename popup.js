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

let latestNetSuitePayload = null;
let lastSearchResult = null;
let lastComparisonSummary = createEmptyComparisonSummary();

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

function toggleSummarySection(id, show) {
  const el = $(id);
  if (!el) return;
  if (show) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
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
  const { copy = false, highlight = false } = options;
  let note = '';
  if (matchState === 'mismatch') {
    const bcNormalized = normalizeValue(bcValue);
    const bcDisplay = bcNormalized !== '' ? escapeHtml(bcNormalized) : '&mdash;';
    note = `<div class="comparison-note">BigCommerce: <code>${bcDisplay}</code></div>`;
  }
  return renderIdRow(label, id, nsValue, { copy, highlight, matchState, note });
}

function renderItemSummary(itemData) {
  const nsRoot = $('itemSummary');
  const nsMeta = $('itemMeta');
  const header = $('summaryHeader');
  const summaryMeta = $('summaryMeta');

  const comparisonSummary = createEmptyComparisonSummary();
  const bcResult = lastSearchResult || null;

  const netsuiteSku = itemData?.sku ?? null;
  const netsuiteInternalId = itemData?.internalId ?? null;
  const netsuiteBcProductId = itemData?.bcProductId ?? null;
  const netsuiteBcVariantId = itemData?.bcVariantId ?? null;

  const bcSku = bcResult?.sku ?? null;
  const bcProductId = bcResult?.bc_product_id ?? null;
  const bcVariantId = bcResult?.bc_variant_id ?? null;

  const productMatchState = bcResult ? determineMatchState(netsuiteBcProductId, bcProductId) : null;
  const variantMatchState = bcResult ? determineMatchState(netsuiteBcVariantId, bcVariantId) : null;
  const skuMatchState = bcResult ? determineMatchState(netsuiteSku, bcSku) : null;

  const nsValues = itemData ? [netsuiteSku, netsuiteInternalId, netsuiteBcProductId, netsuiteBcVariantId] : [];
  const nsHasAny = nsValues.some((value) => normalizeValue(value) !== '');
  comparisonSummary.hasNetSuite = nsHasAny;

  if (nsRoot) {
    if (nsHasAny || bcResult) {
      const rows = [
        renderNetSuiteRow('SKU', 'ns-sku', netsuiteSku, bcSku, skuMatchState),
        renderNetSuiteRow('Internal ID', 'ns-internal', netsuiteInternalId, null, null),
        renderNetSuiteRow('BC Product ID', 'ns-bc-product', netsuiteBcProductId, bcProductId, productMatchState),
        renderNetSuiteRow('BC Variant ID', 'ns-bc-variant', netsuiteBcVariantId, bcVariantId, variantMatchState),
      ];
      nsRoot.innerHTML = rows.join('');
    } else {
      nsRoot.innerHTML = '<div class="placeholder muted">No detected data.</div>';
    }
  }

  if (nsMeta) {
    nsMeta.textContent = nsHasAny ? 'NetSuite IDs detected.' : 'Waiting for detected data.';
  }

  if (header) {
    header.removeAttribute('title');
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

  let summaryMetaText = 'Review detected NetSuite identifiers. BigCommerce differences will appear inline after a lookup.';
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
  const root = $('orderSummary');
  const meta = $('orderMeta');
  const summary = createEmptyComparisonSummary();

  const netsuiteTranId = orderData?.tranId ?? null;
  const netsuiteInternalId = orderData?.internalId ?? null;
  const bcOrderId = orderData?.bcOrderId ?? null;
  const values = [netsuiteTranId, netsuiteInternalId, bcOrderId];
  const hasAny = values.some((value) => normalizeValue(value) !== '');
  summary.hasNetSuite = hasAny;

  if (root) {
    if (hasAny) {
      const rows = [
        renderIdRow('Order Number', 'order-tranid', netsuiteTranId, { copy: true }),
        renderIdRow('Internal ID', 'order-internal', netsuiteInternalId),
        renderIdRow('BC Order ID', 'order-bc-id', bcOrderId, { copy: true }),
      ];
      root.innerHTML = rows.join('');
    } else {
      root.innerHTML = '<div class="placeholder muted">No detected order data.</div>';
    }
  }

  if (meta) {
    meta.textContent = hasAny ? 'NetSuite order data detected.' : 'Waiting for detected data.';
  }

  const summaryMetaText = hasAny
    ? 'Review detected NetSuite order identifiers.'
    : 'Waiting for detected order data.';

  return { comparisonSummary: summary, summaryMetaText };
}

function renderCustomerSummary(customerData) {
  const root = $('customerSummary');
  const meta = $('customerMeta');
  const summary = createEmptyComparisonSummary();

  const netsuiteEntityId = customerData?.entityId ?? null;
  const netsuiteEmail = customerData?.email ?? null;
  const netsuiteInternalId = customerData?.internalId ?? null;
  const bcCustomerId = customerData?.bcCustomerId ?? null;
  const values = [netsuiteEntityId, netsuiteEmail, netsuiteInternalId, bcCustomerId];
  const hasAny = values.some((value) => normalizeValue(value) !== '');
  summary.hasNetSuite = hasAny;

  if (root) {
    if (hasAny) {
      const rows = [
        renderIdRow('Customer', 'customer-entity', netsuiteEntityId),
        renderIdRow('Email', 'customer-email', netsuiteEmail),
        renderIdRow('Internal ID', 'customer-internal', netsuiteInternalId),
        renderIdRow('BC Customer ID', 'customer-bc-id', bcCustomerId, { copy: true }),
      ];
      root.innerHTML = rows.join('');
    } else {
      root.innerHTML = '<div class="placeholder muted">No detected customer data.</div>';
    }
  }

  if (meta) {
    meta.textContent = hasAny ? 'NetSuite customer data detected.' : 'Waiting for detected data.';
  }

  const summaryMetaText = hasAny
    ? 'Review detected NetSuite customer identifiers.'
    : 'Waiting for detected customer data.';

  return { comparisonSummary: summary, summaryMetaText };
}

function renderIdSummary(){
  const card = $('idSummaryCard');
  const summaryMeta = $('summaryMeta');

  let metaText = 'Review detected NetSuite identifiers. BigCommerce differences will appear inline after a lookup.';
  let comparisonSummary = createEmptyComparisonSummary();

  if (!card) {
    lastComparisonSummary = comparisonSummary;
    return comparisonSummary;
  }

  const detection = latestNetSuitePayload || null;
  const detectionType = detection?.type || 'item';
  const detectionData = detection?.data || null;

  toggleSummarySection('itemSummarySection', detectionType === 'item');
  toggleSummarySection('orderSummarySection', detectionType === 'order');
  toggleSummarySection('customerSummarySection', detectionType === 'customer');

  if (detectionType === 'order') {
    const { comparisonSummary: summary, summaryMetaText } = renderOrderSummary(detectionData);
    comparisonSummary = summary;
    metaText = summaryMetaText;
  } else if (detectionType === 'customer') {
    const { comparisonSummary: summary, summaryMetaText } = renderCustomerSummary(detectionData);
    comparisonSummary = summary;
    metaText = summaryMetaText;
  } else {
    const { comparisonSummary: summary, summaryMetaText } = renderItemSummary(detectionData);
    comparisonSummary = summary;
    metaText = summaryMetaText;
  }

  if (summaryMeta) {
    summaryMeta.textContent = metaText;
  }

  attachCopyHandlers(card);
  lastComparisonSummary = comparisonSummary;
  return comparisonSummary;
}

function renderBCCard(result){
  if (arguments.length > 0) {
    lastSearchResult = (result && typeof result === 'object' && !result.error) ? result : null;
  }
  return renderIdSummary();
}

function getLookupStatusFromSummary(summary) {
  const detectionType = latestNetSuitePayload?.type || null;
  if (detectionType && detectionType !== 'item') {
    return { message: 'Lookup completed.', tone: null };
  }
  const effectiveSummary = (summary && typeof summary === 'object') ? summary : lastComparisonSummary;
  if (!effectiveSummary || typeof effectiveSummary !== 'object') {
    return { message: 'Lookup completed.', tone: null };
  }
  if (!effectiveSummary.hasBcResult) {
    return { message: 'No BigCommerce results found.', tone: false };
  }
  if (effectiveSummary.hasDifferences) {
    return { message: 'Discrepancies found — see inline BigCommerce values.', tone: 'warn' };
  }
  if (effectiveSummary.allMatch) {
    return { message: 'All comparable BigCommerce values match NetSuite.', tone: true };
  }
  if (!effectiveSummary.hasComparableValues) {
    return { message: 'Lookup completed, but there were no IDs to compare.', tone: null };
  }
  return { message: 'Lookup completed. BigCommerce results are shown inline.', tone: null };
}

function applyLookupStatusFromSummary(summary) {
  const { message, tone } = getLookupStatusFromSummary(summary);
  setStatus(message, tone);
}


function renderNetSuite(payload){
  const nextPayload = normalizeDetectedPayload(payload) || null;
  const payloadChanged = !payloadsAreEqual(latestNetSuitePayload, nextPayload);
  latestNetSuitePayload = nextPayload;
  if (payloadChanged && lastSearchResult) {
    lastSearchResult = null;
  }
  renderIdSummary();
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
  applyDetectedFromPage('load');
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('useDetected').addEventListener('click', () => {
  applyDetectedFromPage('use');
});

$('lookup').addEventListener('click', async () => {
  const sku = $('sku').value.trim();
  if (!sku) { setStatus('Enter an SKU.', false); return; }
  setStatus('Looking up...');
  const res = await chrome.runtime.sendMessage({ type: "bc-lookup", sku });
  if (res?.ok) {
    const summary = renderBCCard(res?.data ?? null);
    applyLookupStatusFromSummary(summary);
  } else {
    renderBCCard(null);
    setStatus(res?.error || 'Error', false);
    if (/LOCKED/.test(res?.error||'')) {
      setStatus('Locked 🔒 — use "Unlock" or Options to unlock.', false);
    }
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "bc-lookup-result") {
    if (msg.result && !msg.result.error) {
      const summary = renderBCCard(msg.result);
      applyLookupStatusFromSummary(summary);
      if (!$('sku').value) $('sku').value = msg.sku || '';
    } else {
      renderBCCard(null);
      setStatus(msg.result?.error || 'Error', false);
    }
  }
});
