const COOKIE_URL = 'https://bc-sku-lookup.local/';
const COOKIE_NAME = 'bc_accounts_v1';
const ACTIVE_ACCOUNT_KEY = 'bc_active_account_id';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years

function normalizeString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `acc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readAccountsCookie() {
  try {
    const cookie = await chrome.cookies.get({ url: COOKIE_URL, name: COOKIE_NAME });
    if (!cookie || !cookie.value) {
      return [];
    }
    const decoded = decodeURIComponent(cookie.value);
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const sanitized = [];
    let needsRewrite = false;

    parsed.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        needsRewrite = true;
        return;
      }
      try {
        const normalized = sanitizeAccountForStorage(entry);
        sanitized.push(normalized);
        if (
          normalized.id !== entry.id
          || normalized.name !== entry.name
          || normalized.storeHash !== entry.storeHash
          || normalized.accessToken !== entry.accessToken
          || normalized.clientId !== entry.clientId
        ) {
          needsRewrite = true;
        }
      } catch (error) {
        console.warn('Skipping invalid account entry', error);
        needsRewrite = true;
      }
    });

    if (needsRewrite) {
      try {
        await writeAccountsCookie(sanitized);
      } catch (error) {
        console.warn('Failed to rewrite accounts cookie', error);
      }
    }

    return sanitized;
  } catch (error) {
    console.warn('Failed to read accounts cookie', error);
    return [];
  }
}

async function writeAccountsCookie(accounts) {
  const sanitized = Array.isArray(accounts) ? accounts.filter((entry) => entry && typeof entry === 'object') : [];
  const encoded = encodeURIComponent(JSON.stringify(sanitized));
  const expirationDate = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SECONDS;
  await chrome.cookies.set({
    url: COOKIE_URL,
    name: COOKIE_NAME,
    value: encoded,
    expirationDate,
    secure: true,
    sameSite: 'strict',
  });
  return sanitized;
}

function sanitizeAccountForStorage(account) {
  const base = account && typeof account === 'object' ? { ...account } : {};
  const result = {
    id: base.id ? String(base.id) : generateId(),
    name: normalizeString(base.name) || 'BigCommerce account',
    storeHash: normalizeString(base.storeHash),
    accessToken: normalizeString(base.accessToken),
    clientId: normalizeString(base.clientId),
  };
  if (!result.storeHash || !result.accessToken) {
    throw new Error('Store hash and access token are required.');
  }
  return result;
}

export async function listAccounts() {
  const accounts = await readAccountsCookie();
  return accounts.map((account) => ({
    id: normalizeString(account.id) || String(account.id || ''),
    name: normalizeString(account.name) || 'BigCommerce account',
    storeHash: normalizeString(account.storeHash),
    accessToken: normalizeString(account.accessToken),
    clientId: normalizeString(account.clientId),
  }));
}

export async function listAccountSummaries() {
  const accounts = await listAccounts();
  return accounts.map(({ id, name, storeHash }) => ({ id, name, storeHash }));
}

export async function upsertAccount(account) {
  const sanitized = sanitizeAccountForStorage(account);
  const accounts = await listAccounts();
  const existingIndex = accounts.findIndex((entry) => entry.id === sanitized.id);
  if (existingIndex >= 0) {
    accounts[existingIndex] = sanitized;
  } else {
    accounts.push(sanitized);
  }
  await writeAccountsCookie(accounts);
  return sanitized;
}

export async function removeAccount(accountId) {
  const id = normalizeString(accountId);
  const accounts = await listAccounts();
  const filtered = accounts.filter((entry) => entry.id !== id);
  if (filtered.length === accounts.length) {
    return false;
  }
  await writeAccountsCookie(filtered);
  const activeId = await getActiveAccountId();
  if (activeId && activeId === id) {
    await setActiveAccountId(filtered[0]?.id ?? null);
  }
  return true;
}

export async function getAccountById(accountId) {
  const id = normalizeString(accountId);
  if (!id) return null;
  const accounts = await listAccounts();
  return accounts.find((entry) => entry.id === id) || null;
}

export async function getActiveAccountId() {
  const defaults = { [ACTIVE_ACCOUNT_KEY]: null };
  const stored = await chrome.storage.local.get(defaults);
  const id = stored[ACTIVE_ACCOUNT_KEY];
  return id ? String(id) : null;
}

export async function setActiveAccountId(accountId) {
  const value = accountId ? String(accountId) : null;
  await chrome.storage.local.set({ [ACTIVE_ACCOUNT_KEY]: value });
}

export async function getActiveAccount() {
  const activeId = await getActiveAccountId();
  if (!activeId) return null;
  const account = await getAccountById(activeId);
  if (account && account.storeHash && account.accessToken) {
    return account;
  }
  return null;
}

export async function ensureActiveAccount() {
  const account = await getActiveAccount();
  if (!account) {
    throw new Error('Configure a BigCommerce account in Options.');
  }
  return account;
}

export function formatAccountLabel(account) {
  if (!account) return '';
  const name = normalizeString(account.name);
  const hash = normalizeString(account.storeHash);
  if (name && hash) {
    return `${name} (${hash})`;
  }
  return name || hash || '';
}

export async function clearAccounts() {
  await chrome.cookies.remove({ url: COOKIE_URL, name: COOKIE_NAME });
  await setActiveAccountId(null);
}
