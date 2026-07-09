// Shared reference library: persisted to localStorage, and used by both the
// Library view and the note renderer (for [@citekey] citations). A fresh install
// starts with an empty library — the user builds it from real DOIs/ISBNs.
const KEY = 'arf-refs-v0';

// tolerate a hand-edited or imported ref that lost its authors array / isn't an object, so a
// click-through to its detail pane — or a note that cites it, which formats authors inside a
// $derived — can't crash. Drop non-object author entries and default their name parts, so every
// downstream a.f / a.g access is safe.
function normRef(r) {
  const authors = (Array.isArray(r.authors) ? r.authors : [])
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({ ...a, f: a.f || '', g: a.g || '' }));
  return { ...r, authors };
}
export function loadRefs() {
  try { const raw = localStorage.getItem(KEY); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p.filter((r) => r && typeof r === 'object').map(normRef); } } catch (e) {}
  return [];
}
export function saveRefs(refs) {
  try { localStorage.setItem(KEY, JSON.stringify(refs)); return true; } catch (e) { return false; }
}

// Library folder tree, stored as path strings just like note folders. Persisted so an
// empty folder (one holding no reference yet) survives — folders otherwise implied by a
// ref's `folder` field. Travels with the vault via library.json (see App.svelte).
const LF_KEY = 'arf-libfolders-v0';
export function loadLibFolders() {
  try { const raw = localStorage.getItem(LF_KEY); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p.filter((x) => typeof x === 'string' && x); } } catch (e) {}
  return [];
}
export function saveLibFolders(folders) {
  try { localStorage.setItem(LF_KEY, JSON.stringify(folders)); return true; } catch (e) { return false; }
}
