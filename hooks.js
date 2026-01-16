const $ = (id) => document.getElementById(id);

const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds
const BC_API_BASE = 'https://api.bigcommerce.com/stores';

let activeAccount = null;
let hooks = [];
let autoRefreshTimer = null;
let lastUpdateTime = null;

function setActionStatus(message, tone = null) {
  const el = $('actionStatus');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'status';
  if (!message) return;
  if (tone === 'ok' || tone === true) {
    el.classList.add('ok');
  } else if (tone === false || tone === 'error') {
    el.classList.add('error');
  } else if (tone === 'info') {
    el.classList.add('info');
  } else if (tone === 'warn') {
    el.classList.add('warn');
  }
}

function updateLastUpdateTime() {
  lastUpdateTime = new Date();
  const lastUpdateEl = $('lastUpdate');
  if (lastUpdateEl) {
    const timeStr = lastUpdateTime.toLocaleTimeString();
    lastUpdateEl.textContent = `Last updated: ${timeStr}`;
  }
}

function renderAccountInfo(account) {
  const accountInfo = $('accountInfo');
  if (!accountInfo) return;
  
  if (!account) {
    accountInfo.innerHTML = '<div style="color: #b91c1c;">No active account configured. Please configure an account in the extension options.</div>';
    return;
  }
  
  const name = account.name || 'Unnamed account';
  const hash = account.storeHash || 'N/A';
  accountInfo.innerHTML = `
    <div><strong>Account:</strong> ${escapeHtml(name)}</div>
    <div style="margin-top: 4px;"><strong>Store Hash:</strong> <code>${escapeHtml(hash)}</code></div>
  `;
}

function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

function renderHooksList(hooksList) {
  const hooksListEl = $('hooksList');
  if (!hooksListEl) return;
  
  if (!Array.isArray(hooksList) || hooksList.length === 0) {
    hooksListEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔗</div>
        <div>No hooks found for this account.</div>
      </div>
    `;
    return;
  }
  
  hooksListEl.innerHTML = hooksList.map(hook => {
    const isActive = hook.is_active === true;
    const hookId = hook.id || 'N/A';
    const hookName = hook.name || hook.scope || 'Unnamed Hook';
    const hookScope = hook.scope || '';
    const hookDestination = hook.destination || '';
    const statusClass = isActive ? 'active' : 'inactive';
    
    return `
      <div class="hook-item ${statusClass}" data-hook-id="${hookId}">
        <div class="hook-info">
          <div class="hook-name">${escapeHtml(hookName)}</div>
          <div class="hook-details">
            <span class="hook-id">ID: ${escapeHtml(String(hookId))}</span>
            ${hookScope ? `<span>Scope: ${escapeHtml(hookScope)}</span>` : ''}
            ${hookDestination ? `<span>Destination: ${escapeHtml(hookDestination)}</span>` : ''}
          </div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" ${isActive ? 'checked' : ''} data-hook-id="${hookId}" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
  }).join('');
  
  // Attach event listeners to toggles
  hooksListEl.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const hookId = e.target.getAttribute('data-hook-id');
      const isActive = e.target.checked;
      toggleHook(hookId, isActive);
    });
  });
}

async function getActiveAccount() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'account:get-active' });
    if (response?.ok && response.account) {
      return response.account;
    }
    return null;
  } catch (e) {
    console.error('Failed to get active account:', e);
    return null;
  }
}

function buildAuthHeaders(account) {
  const headers = {
    'X-Auth-Token': account.accessToken,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
  if (account.clientId) {
    headers['X-Auth-Client'] = account.clientId;
  }
  return headers;
}

async function fetchHooks(account) {
  if (!account || !account.storeHash || !account.accessToken) {
    throw new Error('Invalid account configuration');
  }
  
  const url = `${BC_API_BASE}/${account.storeHash}/v2/hooks`;
  const headers = buildAuthHeaders(account);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      let errorText = 'Unknown error';
      try {
        errorText = await response.text();
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.title || errorJson.message) {
            errorText = errorJson.title || errorJson.message;
          }
        } catch {
          // Keep text error if not JSON
        }
      } catch {
        // Use default error text
      }
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw e;
  }
}

async function updateHookStatus(account, hookId, isActive) {
  if (!account || !account.storeHash || !account.accessToken) {
    throw new Error('Invalid account configuration');
  }
  
  const url = `${BC_API_BASE}/${account.storeHash}/v2/hooks/${hookId}`;
  const headers = buildAuthHeaders(account);
  const payload = { is_active: isActive };
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
  
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      let errorText = 'Unknown error';
      try {
        errorText = await response.text();
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.title || errorJson.message) {
            errorText = errorJson.title || errorJson.message;
          }
        } catch {
          // Keep text error if not JSON
        }
      } catch {
        // Use default error text
      }
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    return await response.json().catch(() => ({}));
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw e;
  }
}

async function loadHooks(silent = false) {
  if (!activeAccount) {
    if (!silent) {
      setActionStatus('No active account configured.', 'error');
    }
    return;
  }
  
  if (!silent) {
    setActionStatus('Loading hooks...', 'info');
  }
  
  const hooksListEl = $('hooksList');
  if (hooksListEl && !silent) {
    hooksListEl.classList.add('loading');
  }
  
  try {
    const hooksList = await fetchHooks(activeAccount);
    hooks = hooksList;
    renderHooksList(hooks);
    updateLastUpdateTime();
    if (!silent) {
      setActionStatus(`Loaded ${hooksList.length} hook${hooksList.length !== 1 ? 's' : ''}.`, 'ok');
      setTimeout(() => setActionStatus(''), 3000);
    }
  } catch (e) {
    if (!silent) {
      if (e.message.includes('timed out')) {
        setActionStatus('Request timed out. Please check your connection.', 'error');
      } else if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
        setActionStatus('Network error. Please check your connection.', 'error');
      } else {
        setActionStatus(`Failed to load hooks: ${e.message}`, 'error');
      }
    }
    console.error('Failed to load hooks:', e);
    if (hooksListEl) {
      hooksListEl.innerHTML = `
        <div class="empty-state">
          <div style="color: #b91c1c;">Failed to load hooks: ${escapeHtml(e.message)}</div>
        </div>
      `;
    }
  } finally {
    if (hooksListEl) {
      hooksListEl.classList.remove('loading');
    }
  }
}

async function toggleHook(hookId, isActive) {
  if (!activeAccount) {
    setActionStatus('No active account configured.', 'error');
    return;
  }
  
  const hookItem = document.querySelector(`.hook-item[data-hook-id="${hookId}"]`);
  const checkbox = document.querySelector(`input[data-hook-id="${hookId}"]`);
  
  if (hookItem) {
    hookItem.classList.add('loading');
  }
  if (checkbox) {
    checkbox.disabled = true;
  }
  
  setActionStatus(`${isActive ? 'Activating' : 'Deactivating'} hook...`, 'info');
  
  try {
    await updateHookStatus(activeAccount, hookId, isActive);
    
    // Update local state
    const hook = hooks.find(h => String(h.id) === String(hookId));
    if (hook) {
      hook.is_active = isActive;
    }
    
    // Update UI
    if (hookItem) {
      hookItem.classList.remove('loading');
      hookItem.classList.remove('active', 'inactive');
      hookItem.classList.add(isActive ? 'active' : 'inactive');
    }
    
    setActionStatus(`Hook ${isActive ? 'activated' : 'deactivated'} successfully.`, 'ok');
    setTimeout(() => setActionStatus(''), 3000);
    updateLastUpdateTime();
  } catch (e) {
    // Revert checkbox state
    if (checkbox) {
      checkbox.checked = !isActive;
      checkbox.disabled = false;
    }
    if (hookItem) {
      hookItem.classList.remove('loading');
    }
    
    if (e.message.includes('timed out')) {
      setActionStatus('Request timed out. Please try again.', 'error');
    } else if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      setActionStatus('Network error. Please check your connection.', 'error');
    } else {
      setActionStatus(`Failed to ${isActive ? 'activate' : 'deactivate'} hook: ${e.message}`, 'error');
    }
    console.error('Failed to toggle hook:', e);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  const checkbox = $('autoRefresh');
  if (checkbox && checkbox.checked) {
    autoRefreshTimer = setInterval(() => {
      loadHooks(true); // Silent refresh
    }, AUTO_REFRESH_INTERVAL);
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

async function init() {
  // Load active account
  activeAccount = await getActiveAccount();
  renderAccountInfo(activeAccount);
  
  // Set up refresh button
  $('refreshBtn').addEventListener('click', () => {
    loadHooks(false);
  });
  
  // Set up auto-refresh checkbox
  const autoRefreshCheckbox = $('autoRefresh');
  if (autoRefreshCheckbox) {
    autoRefreshCheckbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }
    });
  }
  
  // Load hooks on startup
  if (activeAccount) {
    setTimeout(() => {
      loadHooks(false);
      startAutoRefresh();
    }, 500);
  } else {
    setActionStatus('Please configure an active account in the extension options.', 'warn');
  }
  
  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    stopAutoRefresh();
  });
}

document.addEventListener('DOMContentLoaded', init);
