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

// A frontmatter-less vault file stores no timestamps: its loaded created/updated are stand-ins (the
// file's mtime, or the first time this content was seen) and the loader marks it `_stamped`. A local
// copy of it with identical content but other timestamps (2.0.0 cached such notes with the load time,
// newer than the mtime) is the same note, not a newer edit: it takes the disk copy's timestamps, so it
// neither wins the merge nor gets written back as Arf frontmatter. Only a real content difference
// (title, body, tags, folder) keeps the local copy as it is.
const sameContent = (a, b) => (a.title || '') === (b.title || '') && (a.body || '') === (b.body || '') &&
  (a.folder || '') === (b.folder || '') && (a.tags || []).join(',') === (b.tags || []).join(',');
export function adoptDiskStamps(local, disk) {
  const stamped = new Map();
  for (const d of disk) if (d._stamped) stamped.set(d.id, d);
  if (!stamped.size) return local;
  return local.map((n) => {
    const d = stamped.get(n.id);
    if (!d || (n.updated === d.updated && n.created === d.created) || !sameContent(n, d)) return n;
    return { ...n, created: d.created, updated: d.updated, _path: d._path, _flushed: d.updated };
  });
}

// Launch reconnect: merge the cached notes with the folder listing `ex` (pendingDelete = ids whose local
// delete never confirmed). Returns the merged notes (with _path reconciled to the disk path) and the ids
// that must be written to the folder: only in the cache, or newer there (a hard quit beat the file flush).
// F5b: a cached note missing from the folder whose current version was confirmed written there was
// deleted outside Arf, so it is dropped. Callers handle an empty listing separately.
export function reconnectMerge(local, ex, pendingDelete) {
  const live = pendingDelete && pendingDelete.size ? ex.filter((n) => !pendingDelete.has(n.id)) : ex;
  const diskPath = new Map(ex.map((n) => [n.id, n._path]));
  const diskUpdated = new Map(live.map((n) => [n.id, n.updated || '']));
  const cached = adoptDiskStamps(local.filter((n) => diskPath.has(n.id) || !(n._flushed && n._flushed === n.updated)), live);
  const notes = mergeByUpdated(live, cached), dirty = [];
  for (const n of notes) {
    if (diskPath.has(n.id)) n._path = diskPath.get(n.id);   // a stale cached _path would make a rename recreate the old file
    const d = diskUpdated.get(n.id);
    if (d === undefined || (n.updated || '') > d) dirty.push(n.id);
  }
  return { notes, dirty };
}

// When the sync loop re-reads the whole folder instead of the incremental scan. Regaining focus fires both
// `focus` and `visibilitychange`; a full request that arrives while a full read is already in flight is
// that same request, so it does not schedule a second one. During an incremental tick it still does.
// request(): ask for a full read; begin() at the start of a tick returns whether it is full;
// end(ok) after it, where a failed full tick asks again.
export function fullReadGate() {
  let want = false, inFlight = false;
  return {
    request() { if (!inFlight) want = true; },
    begin() { inFlight = want; want = false; return inFlight; },
    end(ok) { if (inFlight && !ok) want = true; inFlight = false; },
  };
}
