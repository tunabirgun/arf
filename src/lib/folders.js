// Folder / subfolder tree over the vault. Folders are stored as path strings
// ("Concepts", "Concepts/Decoherence"); a note's `folder` places it. Ancestors
// are implied. buildFolderRows flattens the tree into rows (with depth) for the
// sidebar, respecting collapsed state — recursion-free rendering.

// canonical folder path: split on BOTH separators so a backslash folder ("a\\b") matches the
// tree, drop empty / "." / ".." segments, join with "/". Used everywhere a folder is keyed.
export const canonFolder = (p) => (p || '').split(/[\\/]/).filter((seg) => seg && seg !== '.' && seg !== '..').join('/');

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

export function buildFolderRows(folders, notes, collapsed) {
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
  Object.keys(notesOf).forEach((k) => notesOf[k].sort((a, b) => (a.title || '').localeCompare(b.title || '')));

  const rows = [];
  function walk(parent, depth) {
    (childrenOf[parent] || []).sort((a, b) => a.localeCompare(b)).forEach((path) => {
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
