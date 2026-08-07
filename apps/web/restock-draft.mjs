export const RESTOCK_DRAFT_VERSION = 1;

export function restockDraftStorageKey(userId, outletId) {
  if (!userId || !outletId) return null;
  return `pos_restock_receipt_draft:v${RESTOCK_DRAFT_VERSION}:${userId}:${outletId}`;
}

export function meaningfulRestockDraft(draft) {
  return Boolean(
    draft
    && (
      draft.documentNo?.trim()
      || draft.activePurchaseOrder?.id
      || draft.lines?.length
      || draft.draftProducts?.length
    )
  );
}

export function readRestockDraft(storage, key) {
  if (!key) return null;
  try {
    const draft = JSON.parse(storage.getItem(key) ?? 'null');
    if (!draft || draft.version !== RESTOCK_DRAFT_VERSION || !meaningfulRestockDraft(draft)) return null;
    return draft;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeRestockDraft(storage, key, draft) {
  if (!key) return false;
  try {
    if (!meaningfulRestockDraft(draft)) {
      storage.removeItem(key);
      return false;
    }
    storage.setItem(key, JSON.stringify({ ...draft, version: RESTOCK_DRAFT_VERSION }));
    return true;
  } catch {
    return false;
  }
}

export function removeRestockDraft(storage, key) {
  try { if (key) storage.removeItem(key); } catch {}
}
