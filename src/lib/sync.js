// Two-way folder-sync merge helpers, extracted from App.svelte so they can be unit
// tested in isolation. These decide how a local note set and the vault's on-disk
// state are reconciled every sync tick. The comparisons here are load-bearing:
// `updated` must be STRICTLY newer to win, which is what keeps a self-flush from
// being mistaken for a remote edit (the phantom "conflict copy" bug fixed in 1.3.1).

// union by id, keeping the newer copy of each note — never blindly replace the array.
// On an equal timestamp with a different body, prefer the incoming copy: local edits always
// bump `updated`, so a same-timestamp difference means an external hand-edit we must not miss.
export function mergeByUpdated(base, incoming) {
  const m = new Map(); for (const n of base) m.set(n.id, n);
  for (const n of incoming) {
    const ex = m.get(n.id);
    const newer = !ex || (n.updated || '') > (ex.updated || '');
    // an external hand-edit (body, folder move, title, or tags) that didn't bump `updated` must still win
    const sameTimeDiffMeta = ex && (n.updated || '') === (ex.updated || '') &&
      ((n.body || '') !== (ex.body || '') || (n.folder || '') !== (ex.folder || '') ||
       (n.title || '') !== (ex.title || '') || (n.tags || []).join(',') !== (ex.tags || []).join(','));
    if (newer || sameTimeDiffMeta) m.set(n.id, n);
  }
  return [...m.values()];
}

// Cheap structural signature comparison: did the note set actually change this tick?
// Includes a body checksum so an external body edit that kept the same `updated` still repaints.
export function syncChanged(a, b) {
  if (a.length !== b.length) return true;
  const bsum = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  const sig = (arr) => arr.map((n) => n.id + ':' + (n.updated || '') + ':' + (n.folder || '') + ':' + (n.title || '') + ':' + (n.tags || []).join(',') + ':' + bsum(n.body || '')).sort().join('|');
  return sig(a) !== sig(b);
}

// Should the note open for editing spawn a conflict copy? True only when the remote
// version differs in body AND is STRICTLY newer AND hasn't already been stashed.
// `seen` is the set of remote-version keys already copied, so we copy each once.
export function conflictDecision(localCur, remote, seen) {
  if (!remote || !localCur) return { conflict: false, key: null };
  const key = localCur.id + '@' + (remote.updated || '');
  const differs = (remote.body || '') !== (localCur.body || '');
  const strictlyNewer = (remote.updated || '') > (localCur.updated || '');
  const conflict = differs && strictlyNewer && !seen.has(key);
  return { conflict, key };
}
