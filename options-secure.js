import { encryptJSON } from "./crypto.js";

function $(id){ return document.getElementById(id); }

async function saveEncrypted(){
  const pass = $('passphrase').value;
  const obj = {
    storeHash: $('storeHash').value.trim(),
    accessToken: $('accessToken').value.trim(),
    clientId: $('clientId').value.trim(),
  };
  if (!pass) { alert('Definí una contraseña'); return; }
  if (!obj.storeHash || !obj.accessToken) { alert('Store Hash y Access Token son obligatorios'); return; }
  const bundle = await encryptJSON(obj, pass);
  await new Promise(res => chrome.storage.local.set({ bc_encrypted: bundle }, res));
  alert('Guardado cifrado.');
}

$('save').addEventListener('click', saveEncrypted);

$('unlock').addEventListener('click', async () => {
  const pass = $('passphrase').value;
  if (!pass) { alert('Ingresá tu contraseña'); return; }
  const res = await chrome.runtime.sendMessage({ type: "unlock-creds", passphrase: pass });
  $('out').textContent = res?.ok ? 'Desbloqueado ✅' : (res?.error || 'Error');
});

$('lock').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: "lock-creds" });
  $('out').textContent = res?.ok ? 'Bloqueado 🔒' : (res?.error || 'Error');
});

$('testBtn').addEventListener('click', async () => {
  const sku = $('testSku').value.trim();
  if (!sku) return;
  const res = await chrome.runtime.sendMessage({ type: "bc-lookup", sku });
  $('out').textContent = res?.ok ? JSON.stringify(res.data, null, 2) : (res?.error || 'Error');
});
