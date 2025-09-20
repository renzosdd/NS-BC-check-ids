function $(id){ return document.getElementById(id); }

let latestNetSuitePayload = null;

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
  const { copy = false, highlight = false } = options;
  const normalized = normalizeValue(value);
  const display = normalized !== '' ? escapeHtml(normalized) : '&mdash;';
  const classes = ['id-row'];
  if (copy) classes.push('has-action');
  if (highlight) classes.push('highlight');
  const copyButton = copy ? `<button class="btn ghost copy" data-copy="#${id}">Copy</button>` : '';
  return `
    <div class="${classes.join(' ')}">
      <div class="id-label">${escapeHtml(label)}</div>
      <code class="id-value" id="${id}">${display}</code>
      ${copyButton}
    </div>
  `;
}

function renderIdSummary(){
  const card = $('idSummaryCard');
  const nsRoot = $('netsuiteSummary');
  const nsMeta = $('netsuiteMeta');
  const header = $('summaryHeader');
  const summaryMeta = $('summaryMeta');

  if (!card || !nsRoot) return;

  const netsuite = latestNetSuitePayload || null;

  const nsHasAny = netsuite && (netsuite.sku || netsuite.internalId || netsuite.bcProductId || netsuite.bcVariantId);

  if (nsHasAny) {
    const { sku=null, internalId=null, bcProductId=null, bcVariantId=null } = netsuite;
    nsRoot.innerHTML = [
      renderIdRow('SKU', 'ns-sku', sku),
      renderIdRow('Internal ID', 'ns-internal', internalId),
      renderIdRow('BC Product ID', 'ns-bc-product', bcProductId),
      renderIdRow('BC Variant ID', 'ns-bc-variant', bcVariantId)
    ].join('');
  } else {
    nsRoot.innerHTML = '<div class="placeholder muted">No detected data.</div>';
  }

  if (nsMeta) {
    if (netsuite?.detectedAt) {
      nsMeta.textContent = `Detected: ${formatTimestamp(netsuite.detectedAt)}`;
    } else if (nsHasAny) {
      nsMeta.textContent = 'Detected recently.';
    } else {
      nsMeta.textContent = 'Waiting for detected data.';
    }
  }

  if (header) {
    header.title = netsuite?.detectedAt
      ? `NetSuite detected on ${formatTimestamp(netsuite.detectedAt)}`
      : 'No NetSuite detection record.';
  }

  if (summaryMeta) {
    if (netsuite?.detectedAt) {
      summaryMeta.textContent = `NetSuite detection: ${formatTimestamp(netsuite.detectedAt)}`;
    } else if (nsHasAny) {
      summaryMeta.textContent = 'NetSuite detection available.';
    } else {
      summaryMeta.textContent = 'Waiting for detected NetSuite data.';
    }
  }

  attachCopyHandlers(card);
}

function renderBCCard(){
  renderIdSummary();
}

function formatTimestamp(ts){
  if(!ts && ts!==0) return '-';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
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
    renderBCCard();
    setStatus('OK', true);
  } else {
    renderBCCard();
    setStatus(res?.error || 'Error', false);
    if (/LOCKED/.test(res?.error||'')) {
      setStatus('Locked 🔒 — use "Unlock" or Options to unlock.', false);
    }
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "bc-lookup-result") {
    if (msg.result && !msg.result.error) {
      renderBCCard();
      setStatus('OK', true);
      if (!$('sku').value) $('sku').value = msg.sku || '';
    } else {
      renderBCCard();
      setStatus(msg.result?.error || 'Error', false);
    }
  }
});
