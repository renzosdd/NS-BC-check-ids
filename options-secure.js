const $ = (id) => document.getElementById(id);

let editingAccountId = null;
let accountSummaries = [];
let activeAccountId = null;

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

function normalize(value) {
  if (value == null) return '';
  return String(value).trim();
}

function setFormStatus(message, tone = null) {
  const el = $('formStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'status';
  if (!message) return;
  if (tone === 'ok' || tone === true) {
    el.classList.add('ok');
  } else if (tone === false || tone === 'error') {
    el.classList.add('error');
  }
}

function updateFormTitle() {
  const title = $('formTitle');
  const button = $('saveAccount');
  if (!title || !button) return;
  if (editingAccountId) {
    title.textContent = 'Edit account';
    button.textContent = 'Update account';
  } else {
    title.textContent = 'Add account';
    button.textContent = 'Save account';
  }
}

function resetForm({ preserveActivation = false } = {}) {
  editingAccountId = null;
  $('accountName').value = '';
  $('storeHash').value = '';
  $('accessToken').value = '';
  $('clientId').value = '';
  if (!preserveActivation) {
    $('accountActive').checked = true;
  }
  setFormStatus('');
  updateFormTitle();
}

function renderAccountList() {
  const container = $('accountList');
  if (!container) return;
  if (!Array.isArray(accountSummaries) || accountSummaries.length === 0) {
    container.innerHTML = '<div class="empty">No accounts saved yet. Add one using the form above.</div>';
    return;
  }
  const cards = accountSummaries.map((account) => {
    const isActive = account.id === activeAccountId;
    const name = escapeHtml(account.name || 'BigCommerce account');
    const hash = escapeHtml(account.storeHash || '');
    const badge = isActive ? '<span class="badge">Active</span>' : '';
    const activateButton = isActive ? '' : `<button type="button" class="secondary" data-action="activate" data-id="${escapeHtml(account.id)}">Set active</button>`;
    return `
      <div class="account-card${isActive ? ' active' : ''}">
        <div class="account-header">
          <div>
            <div class="account-title">${name}</div>
            <div class="muted">Store hash: <code>${hash || '&mdash;'}</code></div>
          </div>
          ${badge}
        </div>
        <div class="account-actions">
          <button type="button" class="secondary" data-action="edit" data-id="${escapeHtml(account.id)}">Edit</button>
          ${activateButton}
          <button type="button" class="danger" data-action="delete" data-id="${escapeHtml(account.id)}">Delete</button>
        </div>
      </div>
    `;
  });
  container.innerHTML = cards.join('');
}

async function loadAccounts() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'account:get-list' });
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not load accounts');
    }
    accountSummaries = Array.isArray(response.accounts) ? response.accounts : [];
    activeAccountId = response.activeAccountId || null;
    renderAccountList();
  } catch (error) {
    setFormStatus(String(error), 'error');
    accountSummaries = [];
    activeAccountId = null;
    renderAccountList();
  }
}

async function saveAccount(event) {
  event.preventDefault();
  const name = normalize($('accountName').value);
  const storeHash = normalize($('storeHash').value);
  const accessToken = normalize($('accessToken').value);
  const clientId = normalize($('clientId').value);
  const activate = $('accountActive').checked;

  if (!storeHash || !accessToken) {
    setFormStatus('Store hash and access token are required.', 'error');
    return;
  }

  try {
    const payload = {
      id: editingAccountId || undefined,
      name,
      storeHash,
      accessToken,
      clientId,
    };
    const response = await chrome.runtime.sendMessage({ type: 'account:save', account: payload, activate });
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not save account');
    }
    activeAccountId = response.activeAccountId || response.account?.id || activeAccountId;
    setFormStatus('Account saved successfully.', 'ok');
    if (!editingAccountId || activate) {
      resetForm({ preserveActivation: true });
    } else {
      updateFormTitle();
    }
    await loadAccounts();
  } catch (error) {
    setFormStatus(String(error), 'error');
  }
}

async function startEditingAccount(accountId) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'account:get', id: accountId });
    if (!response?.ok || !response.account) {
      throw new Error(response?.error || 'Could not load the selected account.');
    }
    const account = response.account;
    editingAccountId = account.id || null;
    $('accountName').value = account.name || '';
    $('storeHash').value = account.storeHash || '';
    $('accessToken').value = account.accessToken || '';
    $('clientId').value = account.clientId || '';
    $('accountActive').checked = account.id === activeAccountId;
    setFormStatus('Editing account — update the fields and save.', null);
    updateFormTitle();
  } catch (error) {
    setFormStatus(String(error), 'error');
  }
}

async function deleteAccount(accountId) {
  if (!accountId) return;
  if (!confirm('Delete this account? This cannot be undone.')) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'account:delete', id: accountId });
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not delete account.');
    }
    activeAccountId = response.activeAccountId || null;
    setFormStatus('Account removed.', 'ok');
    await loadAccounts();
    resetForm({ preserveActivation: true });
  } catch (error) {
    setFormStatus(String(error), 'error');
  }
}

async function activateAccount(accountId) {
  if (!accountId) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'account:set-active', id: accountId });
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not activate account.');
    }
    activeAccountId = accountId;
    setFormStatus('Account marked as active.', 'ok');
    $('accountActive').checked = editingAccountId ? editingAccountId === activeAccountId : true;
    await loadAccounts();
  } catch (error) {
    setFormStatus(String(error), 'error');
  }
}

function handleAccountListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.getAttribute('data-action');
  const accountId = target.getAttribute('data-id');
  if (!action || !accountId) return;
  if (action === 'edit') {
    startEditingAccount(accountId);
  } else if (action === 'delete') {
    deleteAccount(accountId);
  } else if (action === 'activate') {
    activateAccount(accountId);
  }
}

function init() {
  $('accountForm').addEventListener('submit', saveAccount);
  $('resetForm').addEventListener('click', () => {
    resetForm();
  });
  $('accountList').addEventListener('click', handleAccountListClick);
  updateFormTitle();
  loadAccounts();
}

document.addEventListener('DOMContentLoaded', init);
