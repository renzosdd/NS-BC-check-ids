const $ = (id) => document.getElementById(id);

let lastLookupResult = null;
let activeTabId = null;
const tabPayloads = new Map();

function toast(message) {
  const el = $('viewerToast');
  if (!el) return;
  el.textContent = message || 'Done';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1100);
}

function escapeHtml(value) {
  if (value == null) return '';
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
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function setStatus(message) {
  const status = $('viewerStatus');
  if (!status) return;
  status.textContent = message || '';
  status.classList.remove('hidden');
  $('viewerContent')?.classList.add('hidden');
}

function showContent() {
  const status = $('viewerStatus');
  if (status) {
    status.classList.add('hidden');
  }
  $('viewerContent')?.classList.remove('hidden');
}

function getPayloadObject(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.raw && typeof result.raw === 'object') return result.raw;
  if (result.data && typeof result.data === 'object') return result.data;
  return null;
}

function renderKeyValue(label, value) {
  const normalized = normalizeValue(value);
  const display = normalized ? escapeHtml(normalized) : '&mdash;';
  return `
    <div class="kv">
      <div class="kv-label">${escapeHtml(label)}</div>
      <div class="kv-value">${display}</div>
    </div>
  `;
}

function renderOverview(result) {
  const type = (result?.recordType || 'item').toLowerCase();
  const data = result?.data || {};
  const extras = result?.extras || {};
  let rows = [];
  if (type === 'order') {
    rows = [
      renderKeyValue('Order ID', data.id),
      renderKeyValue('Order number', data.orderNumber),
      renderKeyValue('Reference', data.reference),
      renderKeyValue('Customer ID', data.customerId),
      renderKeyValue('Email', data.email),
      renderKeyValue('Status', data.status || data.statusId),
      renderKeyValue('Total (inc tax)', data.totalIncTax),
      renderKeyValue('Total (ex tax)', data.totalExTax),
    ];
  } else if (type === 'customer') {
    rows = [
      renderKeyValue('Customer ID', data.id),
      renderKeyValue('Email', data.email),
      renderKeyValue('First name', data.firstName),
      renderKeyValue('Last name', data.lastName),
      renderKeyValue('Company', data.company),
      renderKeyValue('Phone', data.phone),
      renderKeyValue('Group ID', data.customerGroupId),
    ];
  } else {
    rows = [
      renderKeyValue('SKU', data.sku),
      renderKeyValue('Product ID', data.bcProductId),
      renderKeyValue('Variant ID', data.bcVariantId),
      renderKeyValue('Product name', data.productName),
    ];
    const parentId = normalizeValue(extras?.parentProductId);
    const parentName = normalizeValue(extras?.parentProductName);
    const isVariant = normalizeValue(data.bcVariantId) !== '';
    if (isVariant && parentId) {
      rows.push(renderKeyValue('Parent product ID', parentId));
    }
    if (isVariant && parentName) {
      rows.push(renderKeyValue('Parent product name', parentName));
    }
    let variantDetails = null;
    if (result?.raw && typeof result.raw === 'object') {
      variantDetails = result.raw.variant || null;
    }
    if (!variantDetails && Array.isArray(extras?.variants)) {
      const variantId = normalizeValue(data.bcVariantId);
      if (variantId) {
        variantDetails = extras.variants.find((entry) => normalizeValue(entry?.id) === variantId) || null;
      }
    }
    if (variantDetails) {
      rows.push(renderKeyValue('Variant price', variantDetails.price ?? variantDetails.price_inc_tax ?? variantDetails.calculated_price));
      rows.push(renderKeyValue('Variant inventory', variantDetails.inventory_level ?? variantDetails.inventory_level_value ?? variantDetails.inventory_tracking));
    }
    const optionTags = Array.isArray(variantDetails?.option_values) && variantDetails.option_values.length > 0
      ? variantDetails.option_values.map((opt) => {
          const label = opt.option_display_name || opt.display_name || opt.label || 'Option';
          const value = opt.label || opt.value || opt.option_value || '';
          return `<span class="pill">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
        }).join(' ')
      : '';
    if (optionTags) {
      rows.push(`<div class="kv kv-full"><div class="kv-label">Variant options</div><div class="kv-value"><div class="pill-row">${optionTags}</div></div></div>`);
    }
  }
  const requestInfo = result?.request && typeof result.request === 'object'
    ? Object.entries(result.request)
        .map(([key, value]) => `<span class="pill">${escapeHtml(key)}: ${escapeHtml(normalizeValue(Array.isArray(value) ? value.join(', ') : value))}</span>`)
        .join(' ')
    : '';
  const requestBlock = requestInfo ? `<div class="card"><div class="card-title">Lookup request</div><div class="meta">${requestInfo}</div></div>` : '';
  return `
    <div class="card">
      <div class="card-title">Summary</div>
      <div class="kv-grid">
        ${rows.join('')}
      </div>
    </div>
    ${requestBlock}
  `;
}

function renderJsonPanel(jsonText) {
  if (!jsonText) {
    return '<div class="card"><div class="card-title">Payload</div><div class="empty">No payload data returned for this lookup.</div></div>';
  }
  return `
    <div class="card">
      <div class="card-title">Payload</div>
      <pre class="json" aria-label="BigCommerce payload">${escapeHtml(jsonText)}</pre>
    </div>
  `;
}

function registerTabPayload(tabId, payload, fileSuffix) {
  if (!tabId) return '';
  if (payload == null) {
    tabPayloads.delete(tabId);
    return '';
  }
  let jsonText = '';
  if (typeof payload === 'string') {
    jsonText = payload;
  } else {
    try {
      jsonText = JSON.stringify(payload, null, 2);
    } catch (e) {
      jsonText = '';
    }
  }
  if (!jsonText) {
    tabPayloads.delete(tabId);
    return '';
  }
  tabPayloads.set(tabId, { jsonText, fileSuffix: fileSuffix || tabId || 'payload' });
  return jsonText;
}

async function copyTabJson(tabId) {
  const entry = tabPayloads.get(tabId);
  if (!entry?.jsonText) {
    toast('No payload to copy');
    return;
  }
  try {
    await navigator.clipboard.writeText(entry.jsonText);
    toast('JSON copied');
  } catch (e) {
    toast('Could not copy JSON');
  }
}

function downloadTabJson(tabId) {
  const entry = tabPayloads.get(tabId);
  if (!entry?.jsonText || !lastLookupResult) {
    toast('No payload to download');
    return;
  }
  try {
    const filename = buildSuggestedFilename(lastLookupResult, entry.fileSuffix);
    const blob = new Blob([entry.jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('Download started');
  } catch (e) {
    toast('Could not download JSON');
  }
}

function renderShippingAddresses(extras) {
  const error = extras?.shippingAddressesError ? `<div class="error">${escapeHtml(extras.shippingAddressesError)}</div>` : '';
  const entries = Array.isArray(extras?.shippingAddresses) ? extras.shippingAddresses : [];
  if (entries.length === 0) {
    return `
      <div class="card">
        <div class="card-title">Shipping addresses</div>
        ${error || '<div class="empty">No shipping addresses returned.</div>'}
      </div>
    `;
  }
  const listItems = entries.map((entry, index) => {
    const name = [entry.first_name, entry.last_name].map(normalizeValue).filter(Boolean).join(' ') || `Address ${index + 1}`;
    const addressLines = [entry.street_1, entry.street_2, entry.city, entry.state, entry.zip, entry.country].map(normalizeValue).filter(Boolean).join(', ');
    const kvs = [
      renderKeyValue('Company', entry.company),
      renderKeyValue('Email', entry.email),
      renderKeyValue('Phone', entry.phone),
      renderKeyValue('Shipping method', entry.shipping_method),
      renderKeyValue('Items total', entry.items_total),
      renderKeyValue('Items shipped', entry.items_shipped),
    ];
    return `
      <div class="list-item">
        <h3>${escapeHtml(name)}</h3>
        <div class="meta">${escapeHtml(addressLines || 'No address on file')}</div>
        <div class="kv-grid">${kvs.join('')}</div>
      </div>
    `;
  }).join('');
  return `
    <div class="card">
      <div class="card-title">Shipping addresses</div>
      ${error}
      <div class="list">${listItems}</div>
    </div>
  `;
}

function renderCoupons(extras) {
  const error = extras?.couponsError ? `<div class="error">${escapeHtml(extras.couponsError)}</div>` : '';
  const entries = Array.isArray(extras?.coupons) ? extras.coupons : [];
  if (entries.length === 0) {
    return `
      <div class="card">
        <div class="card-title">Coupons</div>
        ${error || '<div class="empty">No coupons returned for this order.</div>'}
      </div>
    `;
  }
  const listItems = entries.map((coupon, index) => {
    const heading = coupon.code ? `Coupon ${escapeHtml(coupon.code)}` : `Coupon ${index + 1}`;
    const kvs = [
      renderKeyValue('Code', coupon.code),
      renderKeyValue('Amount discounted', coupon.amount_discounted),
      renderKeyValue('Discount type', coupon.discount_type),
      renderKeyValue('Applies to', coupon.applies_to ? JSON.stringify(coupon.applies_to) : ''),
    ];
    return `
      <div class="list-item">
        <h3>${heading}</h3>
        <div class="kv-grid">${kvs.join('')}</div>
      </div>
    `;
  }).join('');
  return `
    <div class="card">
      <div class="card-title">Coupons</div>
      ${error}
      <div class="list">${listItems}</div>
    </div>
  `;
}

function renderOrderProducts(extras) {
  const error = extras?.productsError ? `<div class="error">${escapeHtml(extras.productsError)}</div>` : '';
  const entries = Array.isArray(extras?.products) ? extras.products : [];
  if (entries.length === 0) {
    if (!error) return '';
    return `
      <div class="card">
        <div class="card-title">Products</div>
        ${error}
      </div>
    `;
  }
  const listItems = entries.map((product, index) => {
    const heading = product.name ? escapeHtml(product.name) : `Product ${index + 1}`;
    const kvs = [
      renderKeyValue('Product ID', product.product_id),
      renderKeyValue('Variant ID', product.variant_id),
      renderKeyValue('SKU', product.sku),
      renderKeyValue('Quantity', product.quantity),
      renderKeyValue('Price (inc tax)', product.price_inc_tax ?? product.base_price),
      renderKeyValue('Total (inc tax)', product.total_inc_tax ?? product.total_ex_tax),
    ];
    const optionTags = Array.isArray(product.product_options) && product.product_options.length > 0
      ? product.product_options.map((option) => {
        const label = option.display_name || option.option_display_name || option.name || 'Option';
        const value = option.display_value || option.value || '';
        return `<span class="pill">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
      }).join(' ')
      : '';
    const optionsBlock = optionTags ? `<div class="pill-row">${optionTags}</div>` : '';
    return `
      <div class="list-item">
        <h3>${heading}</h3>
        ${optionsBlock}
        <div class="kv-grid">${kvs.join('')}</div>
      </div>
    `;
  }).join('');
  return `
    <div class="card">
      <div class="card-title">Products</div>
      ${error}
      <div class="list">${listItems}</div>
    </div>
  `;
}

function renderMetafields(extras) {
  const error = extras?.metafieldsError ? `<div class="error">${escapeHtml(extras.metafieldsError)}</div>` : '';
  const entries = Array.isArray(extras?.metafields) ? extras.metafields : [];
  if (entries.length === 0) {
    return `
      <div class="card">
        <div class="card-title">Metafields</div>
        ${error || '<div class="empty">No metafields returned for this product.</div>'}
      </div>
    `;
  }
  const listItems = entries.map((metafield) => {
    const kvs = [
      renderKeyValue('Namespace', metafield.namespace),
      renderKeyValue('Key', metafield.key),
      renderKeyValue('Value', metafield.value),
      renderKeyValue('Type', metafield.value_type || metafield.type),
      renderKeyValue('Permission set', metafield.permission_set),
      renderKeyValue('Resource type', metafield.resource_type),
    ];
    const title = metafield.key ? `${metafield.namespace ? `${escapeHtml(metafield.namespace)} · ` : ''}${escapeHtml(metafield.key)}` : 'Metafield';
    return `
      <div class="list-item">
        <h3>${title}</h3>
        <div class="kv-grid">${kvs.join('')}</div>
      </div>
    `;
  }).join('');
  return `
    <div class="card">
      <div class="card-title">Metafields</div>
      ${error}
      <div class="list">${listItems}</div>
    </div>
  `;
}

function renderVariantsTab(result) {
  const extras = result?.extras || {};
  const error = extras?.variantsError ? `<div class="error">${escapeHtml(extras.variantsError)}</div>` : '';
  const parentId = extras?.parentProductId ?? result?.data?.bcProductId ?? null;
  const parentName = extras?.parentProductName ?? null;
  const selectedVariantId = normalizeValue(result?.data?.bcVariantId);
  let variants = Array.isArray(extras?.variants) ? extras.variants.slice() : [];
  const rawVariant = result?.raw && typeof result.raw === 'object' ? (result.raw.variant || null) : null;
  if (variants.length === 0 && rawVariant) {
    variants = [rawVariant];
  }
  if (variants.length === 0 && !error) {
    return '';
  }
  const isVariant = selectedVariantId !== '';
  const parentItems = [];
  if (isVariant && parentId) parentItems.push(renderKeyValue('Parent product ID', parentId));
  if (isVariant && parentName) parentItems.push(renderKeyValue('Parent product name', parentName));
  const parentBlock = parentItems.length ? `<div class="kv-grid parent-summary">${parentItems.join('')}</div>` : '';
  const listItems = variants.map((variant, index) => {
    const variantId = normalizeValue(variant?.id);
    const isCurrent = selectedVariantId !== '' && variantId === selectedVariantId;
    const titleParts = [];
    if (variant?.sku) titleParts.push(escapeHtml(variant.sku));
    if (variantId) titleParts.push(`<code>${escapeHtml(variantId)}</code>`);
    const heading = titleParts.length ? titleParts.join(' · ') : `Variant ${index + 1}`;
    const kvs = [
      renderKeyValue('Variant ID', variant?.id),
      renderKeyValue('SKU', variant?.sku),
      renderKeyValue('Price', variant?.price ?? variant?.price_inc_tax ?? variant?.calculated_price),
      renderKeyValue('Inventory', variant?.inventory_level ?? variant?.inventory_level_value),
    ];
    const optionTags = Array.isArray(variant?.option_values) && variant.option_values.length > 0
      ? variant.option_values.map((opt) => {
        const label = opt.option_display_name || opt.display_name || opt.label || 'Option';
        const value = opt.label || opt.value || opt.option_value || '';
        return `<span class="pill">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
      }).join(' ')
      : '';
    const optionsBlock = optionTags ? `<div class="pill-row">${optionTags}</div>` : '';
    return `
      <div class="list-item${isCurrent ? ' active-variant' : ''}">
        <h3>${heading}</h3>
        ${optionsBlock}
        <div class="kv-grid">${kvs.join('')}</div>
      </div>
    `;
  }).join('');
  return `
    <div class="card">
      <div class="card-title">Variants</div>
      ${parentBlock}
      ${error}
      ${listItems ? `<div class="list">${listItems}</div>` : ''}
    </div>
  `;
}

function selectTab(id) {
  const buttons = document.querySelectorAll('.tab-button');
  const panels = document.querySelectorAll('.tab-panel');
  buttons.forEach((btn) => {
    const isActive = btn.dataset.tab === id;
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.classList.toggle('active', isActive);
  });
  panels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.tab === id);
  });
  activeTabId = id;
}

function handleTabActionClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.getAttribute('data-action');
  const tabId = target.getAttribute('data-tab');
  if (!action || !tabId) return;
  if (action === 'copy') {
    copyTabJson(tabId);
  } else if (action === 'download') {
    downloadTabJson(tabId);
  }
}

function buildTabs(result) {
  const tabList = $('tabList');
  const tabPanels = $('tabPanels');
  if (!tabList || !tabPanels) return;
  const tabs = [];
  tabPayloads.clear();
  tabs.push({ id: 'overview', label: 'Overview', content: renderOverview(result) });

  const payloadData = getPayloadObject(result);
  const payloadJson = registerTabPayload('payload', payloadData, 'payload');
  tabs.push({ id: 'payload', label: 'Payload', content: renderJsonPanel(payloadJson) });

  const extras = result?.extras || {};
  const recordType = (result?.recordType || '').toLowerCase();
  if (recordType === 'order') {
    const shippingEntries = Array.isArray(extras?.shippingAddresses) ? extras.shippingAddresses : [];
    if (shippingEntries.length > 0 || extras?.shippingAddressesError) {
      registerTabPayload('shipping', { entries: shippingEntries, error: extras.shippingAddressesError || null }, 'shipping');
      tabs.push({ id: 'shipping', label: 'Shipping addresses', content: renderShippingAddresses(extras) });
    }
    const productsEntries = Array.isArray(extras?.products) ? extras.products : [];
    if (productsEntries.length > 0 || extras?.productsError) {
      registerTabPayload('products', { entries: productsEntries, error: extras.productsError || null }, 'products');
      const productsContent = renderOrderProducts(extras);
      if (productsContent) {
        tabs.push({ id: 'products', label: 'Products', content: productsContent });
      }
    }
    const couponsEntries = Array.isArray(extras?.coupons) ? extras.coupons : [];
    if (couponsEntries.length > 0 || extras?.couponsError) {
      registerTabPayload('coupons', { entries: couponsEntries, error: extras.couponsError || null }, 'coupons');
      tabs.push({ id: 'coupons', label: 'Coupons', content: renderCoupons(extras) });
    }
  }
  if (recordType === 'item') {
    const hasVariants = (Array.isArray(extras?.variants) && extras.variants.length > 0)
      || !!extras?.variantsError
      || !!(result?.raw && typeof result.raw === 'object' && (result.raw.variant || result.raw.id));
    if (hasVariants) {
      registerTabPayload('variants', {
        parentProductId: extras?.parentProductId ?? null,
        parentProductName: extras?.parentProductName ?? null,
        variants: Array.isArray(extras?.variants) ? extras.variants : [],
        variantsError: extras?.variantsError ?? null,
        selectedVariantId: normalizeValue(result?.data?.bcVariantId),
      }, 'variants');
      tabs.push({ id: 'variants', label: 'Variants', content: renderVariantsTab(result) });
    }
    registerTabPayload('metafields', {
      entries: Array.isArray(extras?.metafields) ? extras.metafields : [],
      error: extras?.metafieldsError || null,
    }, 'metafields');
    tabs.push({ id: 'metafields', label: 'Metafields', content: renderMetafields(extras) });
  }

  tabList.innerHTML = tabs.map((tab, index) => `
    <button class="tab-button" role="tab" data-tab="${escapeHtml(tab.id)}" aria-selected="${index === 0 ? 'true' : 'false'}">${escapeHtml(tab.label)}</button>
  `).join('');
  tabPanels.innerHTML = tabs.map((tab, index) => {
    const hasPayload = tabPayloads.has(tab.id);
    const actions = hasPayload
      ? `<div class="tab-actions"><button class="secondary" data-action="copy" data-tab="${escapeHtml(tab.id)}">Copy JSON</button><button class="secondary" data-action="download" data-tab="${escapeHtml(tab.id)}">Download JSON</button></div>`
      : '';
    return `
      <div class="tab-panel${index === 0 ? ' active' : ''}" role="tabpanel" data-tab="${escapeHtml(tab.id)}">${actions}${tab.content}</div>
    `;
  }).join('');
  tabList.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });
  activeTabId = tabs[0]?.id || null;
}

function buildSuggestedFilename(result, suffix = '') {
  const type = (result?.recordType || 'item').toLowerCase();
  let hint = '';
  if (type === 'order') {
    hint = normalizeValue(result?.data?.orderNumber || result?.data?.id || '');
  } else if (type === 'customer') {
    hint = normalizeValue(result?.data?.email || result?.data?.id || '');
  } else {
    hint = normalizeValue(result?.data?.sku || result?.data?.bcProductId || '');
  }
  if (hint) {
    hint = hint.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  } else {
    hint = String(Date.now());
  }
  const parts = ['bigcommerce', type || 'item', hint || 'payload'];
  const normalizedSuffix = suffix ? suffix.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : '';
  if (normalizedSuffix && normalizedSuffix !== hint) {
    parts.push(normalizedSuffix);
  }
  return `${parts.join('-')}.json`;
}

async function loadLastLookup() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-last-lookup-result' });
    if (!response?.ok) {
      setStatus(response?.error || 'Could not retrieve the last lookup result.');
      return;
    }
    if (!response.result) {
      setStatus('No BigCommerce lookup has been performed yet.');
      return;
    }
    lastLookupResult = response.result;
    const type = (lastLookupResult.recordType || 'item').toLowerCase();
    const metaParts = [`BigCommerce ${type}`];
    if (lastLookupResult.source) metaParts.push(lastLookupResult.source);
    $('viewerMeta').textContent = metaParts.join(' · ');
    buildTabs(lastLookupResult);
    showContent();
  } catch (e) {
    setStatus(`Could not load the last lookup result: ${e}`);
  }
}

function init() {
  $('tabPanels')?.addEventListener('click', handleTabActionClick);
  loadLastLookup();
}

document.addEventListener('DOMContentLoaded', init);
