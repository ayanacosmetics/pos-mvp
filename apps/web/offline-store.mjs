const DATABASE = 'kasir-nusa-offline';
const STORE = 'commands';
const FALLBACK_KEY = 'pos_queue_fallback';

export function deviceIdentity() {
  let id = localStorage.getItem('pos_device_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('pos_device_id', id); }
  return { id, name: localStorage.getItem('pos_device_name') ?? `POS-${id.slice(0, 6).toUpperCase()}`, platform: navigator.userAgent };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('occurredAt', 'occurredAt');
      store.createIndex('status', 'status');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databaseAction(mode, action) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

function fallbackList() { return JSON.parse(localStorage.getItem(FALLBACK_KEY) ?? '[]'); }
function fallbackSave(rows) { localStorage.setItem(FALLBACK_KEY, JSON.stringify(rows)); }

export async function enqueueCommand(command) {
  const row = { ...command, status: command.status ?? 'PENDING', attempts: command.attempts ?? 0, updatedAt: new Date().toISOString() };
  try { await databaseAction('readwrite', (store) => store.put(row)); }
  catch { const rows = fallbackList().filter((item) => item.key !== row.key); rows.push(row); fallbackSave(rows); }
  return row;
}

export async function listCommands() {
  try {
    const rows = await databaseAction('readonly', (store) => store.getAll());
    return rows.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  } catch { return fallbackList().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)); }
}

export async function removeCommand(key) {
  try { await databaseAction('readwrite', (store) => store.delete(key)); }
  catch { fallbackSave(fallbackList().filter((item) => item.key !== key)); }
}

export async function updateCommand(key, patch) {
  const current = (await listCommands()).find((item) => item.key === key);
  if (current) await enqueueCommand({ ...current, ...patch, key, updatedAt: new Date().toISOString() });
}

export async function migrateLegacyQueue(actorId = null) {
  const legacy = JSON.parse(localStorage.getItem('pos_queue') ?? '[]');
  for (const command of legacy) await enqueueCommand({ ...command, actorId: command.actorId ?? actorId, occurredAt: command.occurredAt ?? new Date().toISOString(), expectedTotal: command.expectedTotal ?? 0 });
  if (legacy.length) localStorage.removeItem('pos_queue');
}
