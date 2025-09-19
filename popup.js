function $(id){ return document.getElementById(id); }

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
  t.textContent = msg || 'Copiado';
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
          toast('Copiado');
        } catch (e) {
          toast('No se pudo copiar');
        }
      }
    });
  });
}

function renderResult(data){
  const root = $('result');
  if (!data){
    root.innerHTML = '<div class="muted">Sin resultados aún.</div>';
    return;
  }
  const { sku, bc_product_id, bc_variant_id, source } = data;
  root.innerHTML = `
    <div class="kv">
      <label>SKU</label>
      <code id="val-sku">${sku ?? ''}</code>
      <button class="btn secondary copy" data-copy="#val-sku">Copiar</button>
    </div>
    <div class="kv" style="margin-top:6px;">
      <label>Product ID</label>
      <code id="val-pid">${bc_product_id ?? ''}</code>
      <button class="btn secondary copy" data-copy="#val-pid">Copiar</button>
    </div>
    <div class="kv" style="margin-top:6px;">
      <label>Variant ID</label>
      <code id="val-vid">${bc_variant_id ?? ''}</code>
      <button class="btn secondary copy" data-copy="#val-vid">Copiar</button>
    </div>
    <div class="muted" style="margin-top:6px;">Fuente: ${source || '-'}</div>
  `;
  attachCopyHandlers(root);
}

function formatTimestamp(ts){
  if(!ts && ts!==0) return '-';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function renderNetSuite(payload){
  const root = $('netsuite');
  if (!root) return;
  const hasAny = payload && (payload.sku || payload.internalId || payload.bcProductId || payload.bcVariantId);
  if (!hasAny) {
    root.innerHTML = '<div class="muted">Sin datos detectados.</div>';
    return;
  }
  const { sku=null, internalId=null, bcProductId=null, bcVariantId=null, detectedAt=null } = payload;
  root.innerHTML = `
    <div class="kv">
      <label>SKU</label>
      <code id="ns-sku">${sku ?? ''}</code>
      <button class="btn secondary copy" data-copy="#ns-sku">Copiar</button>
    </div>
    <div class="kv" style="margin-top:6px;">
      <label>Internal ID</label>
      <code id="ns-internal">${internalId ?? ''}</code>
      <button class="btn secondary copy" data-copy="#ns-internal">Copiar</button>
    </div>
    <div class="kv" style="margin-top:6px;">
      <label>BC Product ID</label>
      <code id="ns-bc-product">${bcProductId ?? ''}</code>
      <button class="btn secondary copy" data-copy="#ns-bc-product">Copiar</button>
    </div>
    <div class="kv" style="margin-top:6px;">
      <label>BC Variant ID</label>
      <code id="ns-bc-variant">${bcVariantId ?? ''}</code>
      <button class="btn secondary copy" data-copy="#ns-bc-variant">Copiar</button>
    </div>
    <div class="muted" style="margin-top:6px;">Actualizado: ${formatTimestamp(detectedAt)}</div>
  `;
  attachCopyHandlers(root);
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
      setStatus('No hay pestaña activa.', false);
    } else {
      setStatus('No se detectó SKU. Podés ingresarla manualmente.', null);
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
        setStatus('SKU detectada automáticamente.', true);
      } else if (hasAny) {
        setStatus('Datos de NetSuite detectados automáticamente.', true);
      } else {
        setStatus('No se detectó SKU. Podés ingresarla manualmente.', null);
      }
    } else if (context === 'use') {
      if (payload?.sku) {
        setStatus('SKU detectada y aplicada.', true);
      } else if (hasAny) {
        setStatus('Se detectaron datos de NetSuite, pero sin SKU.', true);
      } else {
        setStatus('No se detectó SKU en esta página.', false);
      }
    }
    return payload;
  } catch (e) {
    renderNetSuite(null);
    setStatus('No se pudo leer la página actual (¿es NetSuite?).', false);
    return null;
  }
}

// Unlock flow
$('unlockBtn').addEventListener('click', async () => {
  const pass = prompt('Ingresá tu contraseña para desbloquear credenciales:');
  if (!pass) return;
  const res = await chrome.runtime.sendMessage({ type: "unlock-creds", passphrase: pass });
  setStatus(res?.ok ? 'Credenciales desbloqueadas ✅' : (res?.error || 'Error'), !!res?.ok);
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
  if (!sku) { setStatus('Ingresá un SKU.', false); return; }
  setStatus('Consultando...');
  const res = await chrome.runtime.sendMessage({ type: "bc-lookup", sku });
  if (res?.ok) {
    renderResult(res.data);
    setStatus('OK', true);
  } else {
    renderResult(null);
    setStatus(res?.error || 'Error', false);
    if (/LOCKED/.test(res?.error||'')) {
      setStatus('Bloqueado 🔒 — usá "Unlock" o Options para desbloquear.', false);
    }
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "bc-lookup-result") {
    if (msg.result && !msg.result.error) {
      renderResult(msg.result);
      setStatus('OK', true);
      if (!$('sku').value) $('sku').value = msg.sku || '';
    } else {
      renderResult(null);
      setStatus(msg.result?.error || 'Error', false);
    }
  }
});
