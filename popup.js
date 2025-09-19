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
  root.querySelectorAll('.copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sel = btn.getAttribute('data-copy');
      const el = root.querySelector(sel);
      const text = el?.textContent?.trim() || '';
      if (text) {
        try { await navigator.clipboard.writeText(text); toast('Copiado'); }
        catch (e) { toast('No se pudo copiar'); }
      }
    });
  });
}

// Unlock flow
$('unlockBtn').addEventListener('click', async () => {
  const pass = prompt('Ingresá tu contraseña para desbloquear credenciales:');
  if (!pass) return;
  const res = await chrome.runtime.sendMessage({ type: "unlock-creds", passphrase: pass });
  setStatus(res?.ok ? 'Credenciales desbloqueadas ✅' : (res?.error || 'Error'), !!res?.ok);
});

document.addEventListener('DOMContentLoaded', async () => {
  // Auto-llenar SKU detectada al abrir el popup
  try {
    const tab = await getActiveTab();
    const res = await chrome.tabs.sendMessage(tab.id, { type: "get-sku" });
    if (res?.sku) {
      $('sku').value = res.sku;
      setStatus('SKU detectada automáticamente.', true);
    } else {
      setStatus('No se detectó SKU. Podés ingresarla manualmente.', null);
    }
  } catch(e){
    setStatus('No se pudo leer la página actual (¿es NetSuite?).', false);
  }
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('useDetected').addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "get-sku" });
    if (res?.sku) {
      $('sku').value = res.sku;
      setStatus('SKU detectada y aplicada.', true);
    } else {
      setStatus('No se detectó SKU en esta página.', false);
    }
  } catch (e) {
    setStatus('No se pudo comunicar con la página.', false);
  }
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
