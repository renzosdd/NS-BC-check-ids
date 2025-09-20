function $(id){ return document.getElementById(id); }

let latestNetSuitePayload = null;
let lastSearchResult = null;

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
  el.textContent = msg || '';
  el.className = 'status ' + (ok===true ? 'ok' : ok===false ? 'bad' : 'muted');
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

function renderIdRow(label, id, value, options = {}) {
  const { copy = false, highlight = false, matchState = null } = options;
  const normalized = normalizeValue(value);
  const display = normalized !== '' ? escapeHtml(normalized) : '&mdash;';
  const classes = ['id-row'];
  if (copy) classes.push('has-action');
  if (highlight) classes.push('highlight');
  if (matchState === 'match') classes.push('match');
  else if (matchState === 'mismatch') classes.push('mismatch');
  const copyButton = copy ? `<button class="btn ghost copy" data-copy="#${id}">Copy</button>` : '';
  return `
    <div class="${classes.join(' ')}">
      <div class="id-label">${escapeHtml(label)}</div>
      <code class="id-value" id="${id}">${display}</code>
      ${copyButton}
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

function renderIdSummary(){
  const card = $('idSummaryCard');
  const nsRoot = $('netsuiteSummary');
  const nsMeta = $('netsuiteMeta');
  const bcRoot = $('bigcommerceSummary');
  const bcMeta = $('bigcommerceMeta');
  const header = $('summaryHeader');
  const summaryMeta = $('summaryMeta');
  const summaryGrid = $('summaryGrid');

  if (!card || !nsRoot) return;

  const netsuite = latestNetSuitePayload || null;
  const bcResult = lastSearchResult || null;

  const netsuiteSku = netsuite?.sku ?? null;
  const netsuiteInternalId = netsuite?.internalId ?? null;
  const netsuiteBcProductId = netsuite?.bcProductId ?? null;
  const netsuiteBcVariantId = netsuite?.bcVariantId ?? null;

  const bcSku = bcResult?.sku ?? null;
  const bcProductId = bcResult?.bc_product_id ?? null;
  const bcVariantId = bcResult?.bc_variant_id ?? null;

  const productMatchState = bcResult ? determineMatchState(netsuiteBcProductId, bcProductId) : null;
  const variantMatchState = bcResult ? determineMatchState(netsuiteBcVariantId, bcVariantId) : null;
  const skuMatchState = bcResult ? determineMatchState(netsuiteSku, bcSku) : null;

  const nsValues = netsuite ? [netsuiteSku, netsuiteInternalId, netsuiteBcProductId, netsuiteBcVariantId] : [];
  const nsHasAny = nsValues.some(value => normalizeValue(value) !== '');

  if (nsHasAny) {
    nsRoot.innerHTML = [
      renderIdRow('SKU', 'ns-sku', netsuiteSku, { matchState: skuMatchState }),
      renderIdRow('Internal ID', 'ns-internal', netsuiteInternalId),
      renderIdRow('BC Product ID', 'ns-bc-product', netsuiteBcProductId, { matchState: productMatchState }),
      renderIdRow('BC Variant ID', 'ns-bc-variant', netsuiteBcVariantId, { matchState: variantMatchState })
    ].join('');
  } else {
    nsRoot.innerHTML = '<div class="placeholder muted">No detected data.</div>';
  }

  if (nsMeta) {
    nsMeta.textContent = nsHasAny ? 'NetSuite IDs detected.' : 'Waiting for detected data.';
  }

  if (header) {
    header.removeAttribute('title');
  }

  if (summaryMeta) {
    summaryMeta.textContent = 'Review detected NetSuite identifiers.';
  }

  let bcMetaText = 'Run a lookup to compare.';
  if (summaryGrid) summaryGrid.classList.remove('has-bc');

  if (bcResult && bcRoot) {
    const comparisons = [
      { id: 'product', label: 'BigCommerce value', nsValue: netsuiteBcProductId, bcValue: bcProductId, matchState: productMatchState },
      { id: 'variant', label: 'BigCommerce variant value', nsValue: netsuiteBcVariantId, bcValue: bcVariantId, matchState: variantMatchState },
      { id: 'sku', label: 'BigCommerce SKU', nsValue: netsuiteSku, bcValue: bcSku, matchState: skuMatchState }
    ];

    const rows = [];
    comparisons.forEach(({ id, label, nsValue, bcValue, matchState }) => {
      const nsEmpty = normalizeValue(nsValue) === '';
      const bcEmpty = normalizeValue(bcValue) === '';
      const shouldShow = matchState === 'mismatch' || (nsEmpty && !bcEmpty);
      if (shouldShow) {
        rows.push(renderIdRow(label, `bc-${id}`, bcValue, { copy: true, matchState: 'mismatch' }));
      }
    });

    if (rows.length > 0) {
      bcRoot.innerHTML = rows.join('');
      if (summaryGrid) summaryGrid.classList.add('has-bc');
      bcMetaText = bcResult?.source
        ? `Differences found · ${bcResult.source}`
        : 'Differences found in BigCommerce.';
    } else {
      bcRoot.innerHTML = '<div class="placeholder muted">All values match NetSuite.</div>';
      bcMetaText = bcResult?.source
        ? `All values match · ${bcResult.source}`
        : 'All values match NetSuite.';
    }
  } else if (bcRoot) {
    bcRoot.innerHTML = '<div class="placeholder muted">Run a lookup to compare.</div>';
  }

  if (bcMeta) bcMeta.textContent = bcMetaText;

  attachCopyHandlers(card);
}

function renderBCCard(result){
  if (arguments.length > 0) {
    lastSearchResult = (result && typeof result === 'object' && !result.error) ? result : null;
  }
  renderIdSummary();
}


function renderNetSuite(payload){
  latestNetSuitePayload = payload || null;
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
          const { sku=null, internalId=null, bcProductId=null, bcVariantId=null } = res;
          if (sku || internalId || bcProductId || bcVariantId) {
            payload = { sku, internalId, bcProductId, bcVariantId };
          }
        }
      }
    }
  } catch (e) {
    if (!hadResponse) throw e;
  }
  if (!hadResponse) {
    throw new Error('NO_RESPONSE');
  }
  return payload || null;
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
    if (payload?.sku) {
      $('sku').value = payload.sku;
    }
    const hasAny = payload && (payload.sku || payload.internalId || payload.bcProductId || payload.bcVariantId);
    if (context === 'load') {
      if (payload?.sku) {
        setStatus('SKU detected automatically.', true);
      } else if (hasAny) {
        setStatus('NetSuite data detected automatically.', true);
      } else {
        setStatus('No SKU detected. You can enter it manually.', null);
      }
    } else if (context === 'use') {
      if (payload?.sku) {
        setStatus('Detected SKU applied.', true);
      } else if (hasAny) {
        setStatus('Detected NetSuite data, but no SKU.', true);
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
    renderBCCard(res?.data ?? null);
    setStatus('OK', true);
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
      renderBCCard(msg.result);
      setStatus('OK', true);
      if (!$('sku').value) $('sku').value = msg.sku || '';
    } else {
      renderBCCard(null);
      setStatus(msg.result?.error || 'Error', false);
    }
  }
});
