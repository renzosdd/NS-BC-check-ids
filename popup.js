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
let lastDetectionType = null;
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

function normalizeLookupResult(rawResult) {
  if (!rawResult || typeof rawResult !== 'object') return null;

  const hasRecordType = typeof rawResult.recordType === 'string';
  const type = hasRecordType ? rawResult.recordType.toLowerCase() : null;
  const source = hasRecordType ? (rawResult.source || null) : (rawResult.source || rawResult.sourceType || null);

  if (type === 'item') {
    const data = rawResult.data && typeof rawResult.data === 'object' ? rawResult.data : rawResult;
    return {
      recordType: 'item',
      source,
      data: {
        sku: data.sku ?? data.bcSku ?? null,
        bcProductId: data.bcProductId ?? data.productId ?? data.bc_product_id ?? null,
        bcVariantId: data.bcVariantId ?? data.variantId ?? data.bc_variant_id ?? null,
        productName: data.productName ?? data.name ?? null,
      },
    };
  }

  if (type === 'order') {
    const data = rawResult.data && typeof rawResult.data === 'object' ? rawResult.data : rawResult;
    return {
      recordType: 'order',
      source,
      data: {
        bcOrderId: data.bcOrderId ?? data.id ?? data.orderId ?? null,
        orderNumber: data.orderNumber ?? data.number ?? null,
        status: data.status ?? null,
        statusId: data.statusId ?? data.status_id ?? null,
        reference: data.reference ?? null,
        email: data.email ?? data.customerEmail ?? null,
        customerId: data.customerId ?? data.customer_id ?? null,
        totalIncTax: data.totalIncTax ?? data.total_inc_tax ?? null,
        totalExTax: data.totalExTax ?? data.total_ex_tax ?? null,
        currencyCode: data.currencyCode ?? data.currency_code ?? null,
        dateCreated: data.dateCreated ?? data.date_created ?? null,
        dateModified: data.dateModified ?? data.date_modified ?? null,
      },
    };
  }

  if (type === 'customer') {
    const data = rawResult.data && typeof rawResult.data === 'object' ? rawResult.data : rawResult;
    return {
      recordType: 'customer',
      source,
      data: {
        bcCustomerId: data.bcCustomerId ?? data.id ?? null,
        email: data.email ?? null,
        firstName: data.firstName ?? data.first_name ?? null,
        lastName: data.lastName ?? data.last_name ?? null,
        company: data.company ?? null,
        phone: data.phone ?? null,
        customerGroupId: data.customerGroupId ?? data.customer_group_id ?? null,
        notes: data.notes ?? null,
        dateCreated: data.dateCreated ?? data.date_created ?? null,
        dateModified: data.dateModified ?? data.date_modified ?? null,
      },
    };
  }

  if ('sku' in rawResult || 'bc_product_id' in rawResult || 'bc_variant_id' in rawResult) {
    return {
      recordType: 'item',
      source: rawResult.source || null,
      data: {
        sku: rawResult.sku ?? null,
        bcProductId: rawResult.bc_product_id ?? null,
        bcVariantId: rawResult.bc_variant_id ?? null,
        productName: rawResult.name ?? null,
      },
    };
  }

  return null;
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

function renderBcDetailsSection(title, rows) {
  if (!rows || rows.length === 0) return '';
  return `
    <div class="bc-details">
      <div class="bc-details-title">${escapeHtml(title)}</div>
      <div class="bc-details-list">
        ${rows.join('')}
      </div>
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
  const bcResult = (lastSearchResult && lastSearchResult.recordType === 'item') ? lastSearchResult : null;
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

  const bcResult = (lastSearchResult && lastSearchResult.recordType === 'order') ? lastSearchResult : null;
  const bcData = bcResult?.data || null;
  const lookupBcOrderId = bcData?.bcOrderId ?? null;
  const lookupOrderNumber = bcData?.orderNumber ?? null;
  const lookupReference = bcData?.reference ?? null;
  const lookupStatus = bcData?.status ?? null;
  const lookupEmail = bcData?.email ?? null;
  const lookupCustomerId = bcData?.customerId ?? null;
  const lookupTotal = bcData?.totalIncTax ?? null;
  const lookupCurrency = bcData?.currencyCode ?? null;
  const lookupCreated = bcData?.dateCreated ?? null;
  const lookupModified = bcData?.dateModified ?? null;

  const orderNumberMatchState = bcResult ? determineMatchState(netsuiteTranId, lookupOrderNumber) : null;
  const bcOrderIdMatchState = bcResult ? determineMatchState(bcOrderId, lookupBcOrderId) : null;

  if (root) {
    if (hasAny) {
      const rows = [
        renderNetSuiteRow('Order Number', 'order-tranid', netsuiteTranId, lookupOrderNumber, orderNumberMatchState, { copy: true }),
        renderNetSuiteRow('Internal ID', 'order-internal', netsuiteInternalId, null, null),
        renderNetSuiteRow('BC Order ID', 'order-bc-id', bcOrderId, lookupBcOrderId, bcOrderIdMatchState, { copy: true }),
      ];
      const bcRows = [];
      if (bcData) {
        bcRows.push(renderIdRow('Order ID', 'bc-order-id-result', lookupBcOrderId, { copy: true, highlight: true }));
        bcRows.push(renderIdRow('Order Number', 'bc-order-number-result', lookupOrderNumber, { copy: true, highlight: true }));
        if (lookupReference) bcRows.push(renderIdRow('Reference', 'bc-order-reference', lookupReference, { highlight: true }));
        if (lookupStatus) bcRows.push(renderIdRow('Status', 'bc-order-status', lookupStatus, { highlight: true }));
        if (lookupEmail) bcRows.push(renderIdRow('Customer Email', 'bc-order-email', lookupEmail, { highlight: true }));
        if (lookupCustomerId) bcRows.push(renderIdRow('Customer ID', 'bc-order-customer-id', lookupCustomerId, { highlight: true }));
        if (lookupTotal !== null && lookupTotal !== undefined && normalizeValue(lookupTotal) !== '') {
          const totalDisplay = lookupCurrency ? `${normalizeValue(lookupTotal)} ${normalizeValue(lookupCurrency)}` : normalizeValue(lookupTotal);
          bcRows.push(renderIdRow('Total (inc tax)', 'bc-order-total', totalDisplay, { highlight: true }));
        }
        if (lookupCreated) bcRows.push(renderIdRow('Date Created', 'bc-order-created', lookupCreated, { highlight: true }));
        if (lookupModified) bcRows.push(renderIdRow('Date Modified', 'bc-order-modified', lookupModified, { highlight: true }));
      }
      const bcSection = bcRows.length > 0 ? renderBcDetailsSection('BigCommerce', bcRows) : '';
      root.innerHTML = rows.join('') + bcSection;
    } else {
      root.innerHTML = '<div class="placeholder muted">No detected order data.</div>';
    }
  }

  if (meta) {
    if (bcData) {
      const parts = [hasAny ? 'NetSuite order data detected.' : 'No NetSuite order data detected.', 'BigCommerce order located.'];
      if (bcResult?.source) parts.push(bcResult.source);
      meta.textContent = parts.join(' ');
    } else {
      meta.textContent = hasAny ? 'NetSuite order data detected.' : 'Waiting for detected data.';
    }
  }

  const summaryMetaText = bcData
    ? `BigCommerce order located. Details listed below.${bcResult?.source ? ` · ${bcResult.source}` : ''}`
    : hasAny
      ? 'Review detected NetSuite order identifiers.'
      : 'Waiting for detected order data.';

  summary.hasBcResult = !!bcData;
  summary.hasComparableValues = !!bcData && ([netsuiteTranId, bcOrderId].some((value) => normalizeValue(value) !== ''));
  summary.hasDifferences = !!bcData && [orderNumberMatchState, bcOrderIdMatchState].some((state) => state === 'mismatch');
  if (summary.hasBcResult) {
    summary.allMatch = summary.hasComparableValues && !summary.hasDifferences;
  }

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

  const bcResult = (lastSearchResult && lastSearchResult.recordType === 'customer') ? lastSearchResult : null;
  const bcData = bcResult?.data || null;
  const lookupCustomerId = bcData?.bcCustomerId ?? null;
  const lookupEmail = bcData?.email ?? null;
  const lookupFirstName = bcData?.firstName ?? null;
  const lookupLastName = bcData?.lastName ?? null;
  const lookupCompany = bcData?.company ?? null;
  const lookupPhone = bcData?.phone ?? null;
  const lookupGroupId = bcData?.customerGroupId ?? null;
  const lookupNotes = bcData?.notes ?? null;
  const lookupCreated = bcData?.dateCreated ?? null;
  const lookupModified = bcData?.dateModified ?? null;

  const emailMatchState = bcResult ? determineMatchState(netsuiteEmail, lookupEmail) : null;
  const idMatchState = bcResult ? determineMatchState(bcCustomerId, lookupCustomerId) : null;

  if (root) {
    if (hasAny) {
      const rows = [
        renderIdRow('Customer', 'customer-entity', netsuiteEntityId),
        renderNetSuiteRow('Email', 'customer-email', netsuiteEmail, lookupEmail, emailMatchState),
        renderIdRow('Internal ID', 'customer-internal', netsuiteInternalId),
        renderNetSuiteRow('BC Customer ID', 'customer-bc-id', bcCustomerId, lookupCustomerId, idMatchState, { copy: true }),
      ];
      const bcRows = [];
      if (bcData) {
        bcRows.push(renderIdRow('Customer ID', 'bc-customer-id-result', lookupCustomerId, { copy: true, highlight: true }));
        bcRows.push(renderIdRow('Email', 'bc-customer-email', lookupEmail, { highlight: true }));
        if (lookupFirstName || lookupLastName) {
          const fullName = [lookupFirstName, lookupLastName].map((part) => normalizeValue(part)).filter(Boolean).join(' ');
          bcRows.push(renderIdRow('Name', 'bc-customer-name', fullName || pickFirstNonEmpty(lookupFirstName, lookupLastName), { highlight: true }));
        }
        if (lookupCompany) bcRows.push(renderIdRow('Company', 'bc-customer-company', lookupCompany, { highlight: true }));
        if (lookupPhone) bcRows.push(renderIdRow('Phone', 'bc-customer-phone', lookupPhone, { highlight: true }));
        if (lookupGroupId) bcRows.push(renderIdRow('Customer Group', 'bc-customer-group', lookupGroupId, { highlight: true }));
        if (lookupNotes) bcRows.push(renderIdRow('Notes', 'bc-customer-notes', lookupNotes, { highlight: true }));
        if (lookupCreated) bcRows.push(renderIdRow('Date Created', 'bc-customer-created', lookupCreated, { highlight: true }));
        if (lookupModified) bcRows.push(renderIdRow('Date Modified', 'bc-customer-modified', lookupModified, { highlight: true }));
      }
      const bcSection = bcRows.length > 0 ? renderBcDetailsSection('BigCommerce', bcRows) : '';
      root.innerHTML = rows.join('') + bcSection;
    } else {
      root.innerHTML = '<div class="placeholder muted">No detected customer data.</div>';
    }
  }

  if (meta) {
    if (bcData) {
      const parts = [hasAny ? 'NetSuite customer data detected.' : 'No NetSuite customer data detected.', 'BigCommerce customer located.'];
      if (bcResult?.source) parts.push(bcResult.source);
      meta.textContent = parts.join(' ');
    } else {
      meta.textContent = hasAny ? 'NetSuite customer data detected.' : 'Waiting for detected data.';
    }
  }

  const summaryMetaText = bcData
    ? `BigCommerce customer located. Details listed below.${bcResult?.source ? ` · ${bcResult.source}` : ''}`
    : hasAny
      ? 'Review detected NetSuite customer identifiers.'
      : 'Waiting for detected customer data.';

  summary.hasBcResult = !!bcData;
  summary.hasComparableValues = !!bcData && ([netsuiteEmail, bcCustomerId].some((value) => normalizeValue(value) !== ''));
  summary.hasDifferences = !!bcData && [emailMatchState, idMatchState].some((state) => state === 'mismatch');
  if (summary.hasBcResult) {
    summary.allMatch = summary.hasComparableValues && !summary.hasDifferences;
  }

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
    lastSearchResult = (result && typeof result === 'object' && !result.error)
      ? normalizeLookupResult(result)
      : null;
  }
  return renderIdSummary();
}

function updateLookupControls() {
  const detectionType = latestNetSuitePayload?.type || 'item';
  const input = $('sku');
  const lookupBtn = $('lookup');
  if (input) {
    if (detectionType === 'order') {
      input.placeholder = 'BigCommerce order ID or number...';
    } else if (detectionType === 'customer') {
      input.placeholder = 'Customer email or BigCommerce ID...';
    } else {
      input.placeholder = 'SKU...';
    }
  }
  if (lookupBtn) {
    if (detectionType === 'order') {
      lookupBtn.textContent = 'Look up order';
    } else if (detectionType === 'customer') {
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
  const detectionType = payload?.type || 'item';
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
      applyLookupStatusFromSummary(summary);
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
      applyLookupStatusFromSummary(summary);
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
      applyLookupStatusFromSummary(summary);
    } else {
      renderBCCard(null);
      handleLookupError(res?.error);
    }
  } catch (e) {
    renderBCCard(null);
    handleLookupError(String(e));
  }
}

function getLookupStatusFromSummary(summary) {
  const detectionType = latestNetSuitePayload?.type || null;
  const effectiveSummary = (summary && typeof summary === 'object') ? summary : lastComparisonSummary;
  if (!effectiveSummary || typeof effectiveSummary !== 'object') {
    return { message: 'Lookup completed.', tone: null };
  }
  if (!effectiveSummary.hasBcResult) {
    if (detectionType === 'order') {
      return { message: 'No BigCommerce order found.', tone: false };
    }
    if (detectionType === 'customer') {
      return { message: 'No BigCommerce customer found.', tone: false };
    }
    return { message: 'No BigCommerce results found.', tone: false };
  }
  if (effectiveSummary.hasDifferences) {
    if (detectionType === 'order') {
      return { message: 'BigCommerce order differs from NetSuite values.', tone: 'warn' };
    }
    if (detectionType === 'customer') {
      return { message: 'BigCommerce customer differs from NetSuite values.', tone: 'warn' };
    }
    return { message: 'Discrepancies found — see inline BigCommerce values.', tone: 'warn' };
  }
  if (effectiveSummary.allMatch) {
    if (detectionType === 'order') {
      return { message: 'BigCommerce order matches NetSuite values.', tone: true };
    }
    if (detectionType === 'customer') {
      return { message: 'BigCommerce customer matches NetSuite values.', tone: true };
    }
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
  const previousType = lastDetectionType;
  const nextType = nextPayload?.type || 'item';
  latestNetSuitePayload = nextPayload;
  if (payloadChanged && lastSearchResult) {
    lastSearchResult = null;
  }
  setLookupInputFromDetection(nextPayload, { force: previousType !== nextType });
  lastDetectionType = nextType;
  updateLookupControls();
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
    setLookupInputFromDetection(payload, { force: context === 'use' });
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
  updateLookupControls();
  applyDetectedFromPage('load');
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('useDetected').addEventListener('click', () => {
  applyDetectedFromPage('use');
});

$('lookup').addEventListener('click', async () => {
  const detectionType = latestNetSuitePayload?.type || 'item';
  if (detectionType === 'order') {
    await performOrderLookup();
  } else if (detectionType === 'customer') {
    await performCustomerLookup();
  } else {
    await performItemLookup();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "bc-lookup-result") {
    if (msg.result && !msg.result.error) {
      const summary = renderBCCard(msg.result);
      applyLookupStatusFromSummary(summary);
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
