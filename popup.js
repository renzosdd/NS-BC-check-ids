function $(id){ return document.getElementById(id); }

let latestNetSuitePayload = null;
let lastSearchResult = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
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

function renderIdRow(label, id, value) {
  const normalized = normalizeValue(value);
  const display = normalized !== '' ? escapeHtml(normalized) : '&mdash;';
  return `
    <div class="id-row">
      <div class="id-label">${escapeHtml(label)}</div>
      <code class="id-value" id="${id}">${display}</code>
      <button class="btn ghost copy" data-copy="#${id}">Copy</button>
    </div>
  `;
}

function updateBanner(issues = []){
  const banner = $('comparisonBanner');
  if (!banner) return;
  banner.classList.remove('is-error', 'is-warning');
  if (!issues.length) {
    banner.textContent = '';
    banner.classList.add('hidden');
    return;
  }
  const hasMismatch = issues.some(issue => issue.type === 'mismatch');
  banner.textContent = issues.map(issue => issue.message).join(' • ');
  banner.classList.remove('hidden');
  banner.classList.add(hasMismatch ? 'is-error' : 'is-warning');
}

function updateComparisonSection(){
  const section = $('comparisonSection');
  const resultsEl = $('comparisonResults');
  if (!section || !resultsEl) return;

  if (!lastSearchResult) {
    resultsEl.innerHTML = '';
    updateBanner([]);
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  const netsuite = latestNetSuitePayload || {};
  const bc = lastSearchResult || {};
  const detectionLabel = netsuite?.detectedAt ? formatTimestamp(netsuite.detectedAt) : 'no record';
  const sourceLabel = bc?.source ? bc.source : 'Unknown';
  const fetchedLabel = bc?.fetchedAt ? formatTimestamp(bc.fetchedAt) : null;
  const bcInfo = fetchedLabel ? `${sourceLabel} · ${fetchedLabel}` : sourceLabel;

  const comparisons = [
    { label: 'Product ID', nsValue: netsuite?.bcProductId, bcValue: bc?.bc_product_id },
    { label: 'Variant ID', nsValue: netsuite?.bcVariantId, bcValue: bc?.bc_variant_id },
  ];

  const issues = [];
  const rows = comparisons.map(({ label, nsValue, bcValue }) => {
    const nsNormalized = normalizeValue(nsValue);
    const bcNormalized = normalizeValue(bcValue);
    const nsHas = nsNormalized !== '';
    const bcHas = bcNormalized !== '';
    let state = 'match';
    if (!nsHas || !bcHas) {
      state = 'missing';
      const missingSides = [];
      if (!nsHas) missingSides.push('NetSuite');
      if (!bcHas) missingSides.push('BigCommerce');
      issues.push({ type: 'missing', message: `${label}: missing data in ${missingSides.join(' and ')}` });
    } else if (nsNormalized !== bcNormalized) {
      state = 'mismatch';
      issues.push({ type: 'mismatch', message: `${label}: IDs do not match` });
    }
    const stateLabel = state === 'match' ? 'Match' : state === 'missing' ? 'Missing data' : 'Mismatch';
    const tooltip = `NetSuite (${detectionLabel}): ${nsHas ? nsNormalized : 'no data'}\nBigCommerce (${bcInfo}): ${bcHas ? bcNormalized : 'no data'}`;
    return `
      <div class="compare-row state-${state}" title="${escapeHtml(tooltip)}">
        <div class="compare-top">
          <span class="compare-label">${escapeHtml(label)}</span>
          <span class="state-chip">${escapeHtml(stateLabel)}</span>
        </div>
        <div class="compare-values">
          <div class="source-value">
            <span class="source-label">NetSuite</span>
            <code>${nsHas ? escapeHtml(nsNormalized) : '&mdash;'}</code>
          </div>
          <div class="source-value">
            <span class="source-label">BigCommerce</span>
            <code>${bcHas ? escapeHtml(bcNormalized) : '&mdash;'}</code>
          </div>
        </div>
      </div>
    `;
  }).join('');

  resultsEl.innerHTML = rows;
  updateBanner(issues);
}

function renderBCCard(data){
  const card = $('bigcommerceCard');
  const details = $('bcDetails');
  const meta = $('bcMeta');
  const header = $('bcHeader');
  if (!card || !details) return;

  if (!data) {
    lastSearchResult = null;
    if (meta) meta.textContent = 'Look up an SKU to view IDs.';
    if (header) header.removeAttribute('title');
    details.innerHTML = '';
    card.classList.add('hidden');
    updateComparisonSection();
    return;
  }

  const normalized = { ...data, fetchedAt: Date.now() };
  lastSearchResult = normalized;

  card.classList.remove('hidden');

  const sourceText = normalized.source ? `Source: ${normalized.source}` : 'Unknown source';
  if (meta) meta.textContent = sourceText;
  if (header) {
    const headerSource = normalized.source ? `Source: ${normalized.source}` : 'Unknown source';
    header.title = `${headerSource} · Retrieved ${formatTimestamp(normalized.fetchedAt)}`;
  }

  details.innerHTML = [
    renderIdRow('SKU', 'bc-sku', normalized.sku ?? ''),
    renderIdRow('Product ID', 'bc-product', normalized.bc_product_id ?? ''),
    renderIdRow('Variant ID', 'bc-variant', normalized.bc_variant_id ?? '')
  ].join('');

  attachCopyHandlers(card);
  updateComparisonSection();
}

function formatTimestamp(ts){
  if(!ts && ts!==0) return '-';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function renderNetSuite(payload){
  latestNetSuitePayload = payload || null;
  const root = $('netsuiteBody');
  const meta = $('netsuiteMeta');
  const header = $('netsuiteHeader');
  if (!root) return;

  const hasAny = payload && (payload.sku || payload.internalId || payload.bcProductId || payload.bcVariantId);

  if (!hasAny) {
    root.innerHTML = '<div class="placeholder muted">No detected data.</div>';
  } else {
    const { sku=null, internalId=null, bcProductId=null, bcVariantId=null } = payload;
    root.innerHTML = [
      renderIdRow('SKU', 'ns-sku', sku),
      renderIdRow('Internal ID', 'ns-internal', internalId),
      renderIdRow('BC Product ID', 'ns-bc-product', bcProductId),
      renderIdRow('BC Variant ID', 'ns-bc-variant', bcVariantId)
    ].join('');
    attachCopyHandlers(root);
  }

  if (meta) {
    if (payload?.detectedAt) {
      meta.textContent = `Detected: ${formatTimestamp(payload.detectedAt)}`;
    } else if (hasAny) {
      meta.textContent = 'Detected recently.';
    } else {
      meta.textContent = 'Waiting for detected data.';
    }
  }

  if (header) {
    header.title = payload?.detectedAt
      ? `Detected in NetSuite on ${formatTimestamp(payload.detectedAt)}`
      : 'No detection record.';
  }

  updateComparisonSection();
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
          const { sku=null, internalId=null, bcProductId=null, bcVariantId=null, detectedAt=null } = res;
          if (sku || internalId || bcProductId || bcVariantId || detectedAt) {
            payload = { sku, internalId, bcProductId, bcVariantId, detectedAt };
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
    return null;
  }
  try {
    const payload = await fetchDetectedPayloadForTab(tab.id);
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
  }
}

// Unlock flow
$('unlockBtn').addEventListener('click', async () => {
  const pass = prompt('Enter your password to unlock credentials:');
  if (!pass) return;
  const res = await chrome.runtime.sendMessage({ type: "unlock-creds", passphrase: pass });
  setStatus(res?.ok ? 'Credentials unlocked ✅' : (res?.error || 'Error'), !!res?.ok);
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
    renderBCCard(res.data);
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
