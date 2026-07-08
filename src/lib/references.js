// Shared reference library: persisted to localStorage, and used by both the
// Library view and the note renderer (for [@citekey] citations). A fresh install
// starts with an empty library — the user builds it from real DOIs/ISBNs.
const KEY = 'arf-refs-v0';

// tolerate a hand-edited or imported ref that lost its authors array / isn't an object,
// so a click-through to its detail pane can't crash the Library
function normRef(r) { return { ...r, authors: Array.isArray(r.authors) ? r.authors : [] }; }
export function loadRefs() {
  try { const raw = localStorage.getItem(KEY); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p.filter((r) => r && typeof r === 'object').map(normRef); } } catch (e) {}
  return [];
}
export function saveRefs(refs) {
  try { localStorage.setItem(KEY, JSON.stringify(refs)); return true; } catch (e) { return false; }
}
