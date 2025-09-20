import { encryptJSON } from "./crypto.js";

function $(id){ return document.getElementById(id); }

async function requestBadgeRefresh(){
  try{
    await chrome.runtime.sendMessage({ type: "refresh-badge" });
  }catch(e){
    // ignore background errors
  }
}

async function saveEncrypted(){
  const pass = $('passphrase').value;
  const obj = {
    storeHash: $('storeHash').value.trim(),
    accessToken: $('accessToken').value.trim(),
    clientId: $('clientId').value.trim(),
  };
  if (!pass) { alert('Set a password'); return; }
  if (!obj.storeHash || !obj.accessToken) { alert('Store Hash and Access Token are required'); return; }
  const bundle = await encryptJSON(obj, pass);
  await new Promise(res => chrome.storage.local.set({ bc_encrypted: bundle }, res));
  alert('Encrypted data saved.');
}

$('save').addEventListener('click', saveEncrypted);

$('unlock').addEventListener('click', async () => {
  const pass = $('passphrase').value;
  if (!pass) { alert('Enter your password'); return; }
  const res = await chrome.runtime.sendMessage({ type: "unlock-creds", passphrase: pass });
  $('out').textContent = res?.ok ? 'Unlocked ✅' : (res?.error || 'Error');
  await requestBadgeRefresh();
});

$('lock').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: "lock-creds" });
  $('out').textContent = res?.ok ? 'Locked 🔒' : (res?.error || 'Error');
  await requestBadgeRefresh();
});

$('testBtn').addEventListener('click', async () => {
  const sku = $('testSku').value.trim();
  if (!sku) return;
  const res = await chrome.runtime.sendMessage({ type: "bc-lookup", sku });
  $('out').textContent = res?.ok ? JSON.stringify(res.data, null, 2) : (res?.error || 'Error');
});
