// Folder / subfolder tree over the vault. Folders are stored as path strings
// ("Concepts", "Concepts/Decoherence"); a note's `folder` places it. Ancestors
// are implied. buildFolderRows flattens the tree into rows (with depth) for the
// sidebar, respecting collapsed state — recursion-free rendering.

// Win32 strips a trailing dot/space from a directory name and forbids reserved device
// names — normalize each segment so the keyed path equals what the filesystem stores.
const sanSeg = (s) => { s = s.replace(/[. ]+$/, ''); return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s) ? s + '-' : s; };
// canonical folder path: split on BOTH separators so a backslash folder ("a\\b") matches the
// tree, drop empty / "." / ".." segments, join with "/". Used everywhere a folder is keyed.
export const canonFolder = (p) => (p || '').split(/[\\/]/).filter((seg) => seg && seg !== '.' && seg !== '..').map(sanSeg).filter(Boolean).join('/');

export function allFolderPaths(folders, notes) {
  const set = new Set();
  const add = (p) => {
    if (!p) return;
    let cur = '';
    // skip empty segments — a leading/double slash must never insert '' and make a folder
    // its own ancestor (which would make buildFolderRows recurse forever)
    p.split(/[\\/]/).forEach((seg) => { if (!seg || seg === '.' || seg === '..') return; cur = cur ? cur + '/' + seg : seg; set.add(cur); });
  };
  (folders || []).forEach(add);
  (notes || []).forEach((n) => add(n.folder || ''));
  return [...set];
}

export function folderList(folders, notes) {
  return allFolderPaths(folders, notes).sort((a, b) => a.localeCompare(b));
}

// `orders` (optional) is { notes: {id: rank}, folders: {path: rank} } for manual drag-to-reorder.
// An item with a rank sorts by it; items without a rank keep the previous alphabetical order,
// so an un-reordered vault (and every caller that omits `orders`) is unchanged.
export function buildFolderRows(folders, notes, collapsed, orders = null) {
  const noteOrder = (orders && orders.notes) || null;
  const folderOrder = (orders && orders.folders) || null;
  const nrank = (id) => (noteOrder && noteOrder[id] != null ? noteOrder[id] : Infinity);
  const frank = (p) => (folderOrder && folderOrder[p] != null ? folderOrder[p] : Infinity);
  const byFolder = (a, b) => { const ra = frank(a), rb = frank(b); return ra !== rb ? ra - rb : a.localeCompare(b); };
  const byNote = (a, b) => { const ra = nrank(a.id), rb = nrank(b.id); return ra !== rb ? ra - rb : (a.title || '').localeCompare(b.title || ''); };
  const paths = folderList(folders, notes);
  const childrenOf = {};
  paths.forEach((p) => {
    const i = p.lastIndexOf('/'); const parent = i < 0 ? '' : p.slice(0, i);
    (childrenOf[parent] = childrenOf[parent] || []).push(p);
  });
  const notesOf = {};
  // key by the SAME canonical path the tree is built from, or a note with a non-canonical
  // folder string (trailing slash, backslash, "./") would never render under its folder
  notes.forEach((n) => { const f = canonFolder(n.folder); (notesOf[f] = notesOf[f] || []).push(n); });
  Object.keys(notesOf).forEach((k) => notesOf[k].sort(byNote));

  const rows = [];
  function walk(parent, depth) {
    (childrenOf[parent] || []).sort(byFolder).forEach((path) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const kids = (childrenOf[path] || []).length + (notesOf[path] || []).length;
      const isCollapsed = !!collapsed[path];
      rows.push({ type: 'folder', path, name, depth, count: (notesOf[path] || []).length, hasChildren: kids > 0, collapsed: isCollapsed });
      if (!isCollapsed) {
        walk(path, depth + 1);
        (notesOf[path] || []).forEach((n) => rows.push({ type: 'note', note: n, depth: depth + 1 }));
      }
    });
  }
  walk('', 0);
  (notesOf[''] || []).forEach((n) => rows.push({ type: 'note', note: n, depth: 0 }));
  return rows;
}

// Plan a folder move/nest under destParent ('' = vault root) without touching component
// state, so the decision (and its refusals) can be unit tested. Returns {ok:false, reason}
// for an invalid/circular/no-op/collision move, or {ok:true, ...} with the reparented
// folder list, the per-note moves to apply, and the reparent fn (for activeFolder rewrite).
export function planFolderMove(src, destParent, folders, notes) {
  src = canonFolder(src); destParent = canonFolder(destParent);
  if (!src) return { ok: false, reason: 'invalid' };
  if (destParent === src || destParent.startsWith(src + '/')) return { ok: false, reason: 'circular' }; // into itself or a descendant
  const leaf = src.slice(src.lastIndexOf('/') + 1);
  const newPath = destParent ? destParent + '/' + leaf : leaf;
  if (newPath === src) return { ok: false, reason: 'noop' };
  // refuse to merge into an unrelated folder that already owns this leaf name — a silent
  // Set-dedup merge would fuse two subtrees and reassign every note under them, unrecoverably
  if (folders.some((p) => (p === newPath || p.startsWith(newPath + '/')) && !(p === src || p.startsWith(src + '/'))) ||
      notes.some((n) => { const f = canonFolder(n.folder); return (f === newPath || f.startsWith(newPath + '/')) && !(f === src || f.startsWith(src + '/')); })) {
    return { ok: false, reason: 'collision', leaf };
  }
  const reparent = (p) => p === src ? newPath : (p.startsWith(src + '/') ? newPath + p.slice(src.length) : p);
  const newFolders = [...new Set(folders.map(reparent))];
  const noteMoves = [];
  for (const n of notes) { const f = canonFolder(n.folder); if (f === src || f.startsWith(src + '/')) noteMoves.push({ id: n.id, to: reparent(f) }); }
  return { ok: true, src, newPath, leaf, reparent, newFolders, noteMoves };
}
