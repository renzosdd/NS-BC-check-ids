async function getSettings() {
  const defaults = { storeHash: "", accessToken: "", clientId: "" };
  return new Promise(resolve => chrome.storage.sync.get(defaults, resolve));
}
async function saveSettings(cfg) { return new Promise(resolve => chrome.storage.sync.set(cfg, resolve)); }

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await getSettings();
  document.getElementById('storeHash').value = cfg.storeHash || "";
  document.getElementById('accessToken').value = cfg.accessToken || "";
  document.getElementById('clientId').value = cfg.clientId || "";
});
document.getElementById('save').addEventListener('click', async () => {
  const cfg = {
    storeHash: document.getElementById('storeHash').value.trim(),
    accessToken: document.getElementById('accessToken').value.trim(),
    clientId: document.getElementById('clientId').value.trim(),
  };
  await saveSettings(cfg);
  alert("Guardado.");
});
document.getElementById('testBtn').addEventListener('click', async () => {
  const sku = document.getElementById('testSku').value.trim();
  if (!sku) return;
  const res = await chrome.runtime.sendMessage({ type: "bc-lookup", sku });
  const out = document.getElementById('out');
  if (res?.ok) out.textContent = JSON.stringify(res.data, null, 2);
  else out.textContent = res?.error || "Error";
});
