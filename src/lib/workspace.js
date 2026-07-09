// The portable .arf workspace bundle: one JSON file holding every note, folder,
// and reference. Extracted from App.svelte so the build/read/normalize/merge steps
// can be unit tested. Import is deliberately forgiving — a hand-edited or partial
// bundle should merge what it can without losing anything already in the vault.

// Build the bundle object written to disk. `exported` is passed in so callers control
// the timestamp (and tests stay deterministic).
export function buildBundle(notes, folders, refs, version, exported, libFolders = []) {
  return { arf: 1, app: 'Arf', version, exported, notes, folders, refs, libFolders };
}

// Parse + validate a bundle's text. Throws a user-facing message if it isn't one.
export function readBundle(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.notes)) throw new Error('Not an Arf workspace (.arf) file');
  return data;
}

// Normalize imported notes before merging. Critically, drop each imported note's _path:
// it points at a file in the *source* vault, and flushing it here would overwrite/delete
// the unrelated file that occupies that path in THIS vault. Keep only a same-id note's own
// local path. `newId` backfills a missing id (else id-less notes collapse into one on merge).
export function normalizeNotes(rawNotes, localPathById, newId) {
  return rawNotes.filter((n) => n && typeof n === 'object').map((n) => ({
    ...n,
    id: (typeof n.id === 'string' && n.id.trim()) ? n.id : newId(),
    title: typeof n.title === 'string' ? n.title : 'Untitled',
    tags: Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === 'string') : [],
    body: typeof n.body === 'string' ? n.body : '',
    folder: typeof n.folder === 'string' ? n.folder : '',
    _path: localPathById.get(n.id),
  }));
}

// Union of existing + imported folder paths (deduped, non-empty strings only).
export function mergeFolders(existing, incoming) {
  return [...new Set([...existing, ...(incoming || []).filter((f) => typeof f === 'string' && f)])];
}

// Merge imported references into the existing library by id, incoming wins on a clash;
// a ref that lost its authors array is repaired so a later detail view can't crash.
export function mergeRefs(existing, incoming) {
  const m = new Map(existing.map((r) => [r.id, r]));
  for (const r of (incoming || [])) {
    if (!r || typeof r !== 'object' || r.id == null) continue;
    if (!Array.isArray(r.authors)) r.authors = [];
    m.set(r.id, r);
  }
  return [...m.values()];
}
