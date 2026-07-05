// Shared reference library: seeded, persisted to localStorage, and used by both
// the Library view and the note renderer (for [@citekey] citations).
const KEY = 'arf-refs-v0';

export const SEED_REFS = [
  { id: 'r_zurek2003', type: 'article-journal', citekey: 'zurek2003', title: 'Decoherence, einselection, and the quantum origins of the classical', authors: [{ f: 'Zurek', g: 'Wojciech H.' }], year: 2003, container: 'Reviews of Modern Physics', volume: '75', pages: '715–775', doi: '10.1103/RevModPhys.75.715', abstract: 'Decoherence, einselection, and the existential interpretation are described.', sources: ['Crossref', 'OpenAlex'] },
  { id: 'r_arf1941', type: 'article-journal', citekey: 'arf1941', title: 'Untersuchungen über quadratische Formen in Körpern der Charakteristik 2', authors: [{ f: 'Arf', g: 'Cahit' }], year: 1941, container: 'Journal für die reine und angewandte Mathematik', volume: '183', pages: '148–167', doi: '10.1515/crll.1941.183.148', sources: ['Crossref'] },
  { id: 'r_efron1979', type: 'article-journal', citekey: 'efron1979', title: 'Bootstrap Methods: Another Look at the Jackknife', authors: [{ f: 'Efron', g: 'Bradley' }], year: 1979, container: 'The Annals of Statistics', volume: '7', pages: '1–26', doi: '10.1214/aos/1176344552', sources: ['Crossref', 'OpenAlex'] },
  { id: 'r_deutsch2011', type: 'book', citekey: 'deutsch2011', title: 'The Beginning of Infinity', authors: [{ f: 'Deutsch', g: 'David' }], year: 2011, publisher: 'Viking', isbn: '9780670022755', sources: ['Open Library', 'Google Books'] },
  { id: 'r_ahrens2017', type: 'book', citekey: 'ahrens2017', title: 'How to Take Smart Notes', authors: [{ f: 'Ahrens', g: 'Sönke' }], year: 2017, publisher: 'CreateSpace', isbn: '9781542866507', sources: ['Open Library'] },
  { id: 'r_sep_dec', type: 'webpage', citekey: 'sep2020decoherence', title: 'The Role of Decoherence in Quantum Mechanics', authors: [{ f: 'Bacciagaluppi', g: 'Guido' }], year: 2020, container: 'Stanford Encyclopedia of Philosophy', url: 'https://plato.stanford.edu/entries/qm-decoherence/', accessed: '2026-06-28', archived: 'https://web.archive.org/web/20260601120000/https://plato.stanford.edu/entries/qm-decoherence/', archivedDate: '2026-06-01', sources: ['Wayback Machine', 'Manual'] },
  { id: 'r_quanta', type: 'article-magazine', citekey: 'wolchover2019', title: 'Quantum Darwinism, an Idea to Explain Objective Reality, Passes First Tests', authors: [{ f: 'Wolchover', g: 'Natalie' }], year: 2019, container: 'Quanta Magazine', url: 'https://www.quantamagazine.org/', accessed: '2026-06-20', archived: 'https://web.archive.org/web/20260520090000/https://www.quantamagazine.org/', archivedDate: '2026-05-20', sources: ['Wayback Machine'] },
];

export function loadRefs() {
  try { const raw = localStorage.getItem(KEY); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p; } } catch (e) {}
  return SEED_REFS.map((r) => ({ ...r }));
}
export function saveRefs(refs) {
  try { localStorage.setItem(KEY, JSON.stringify(refs)); return true; } catch (e) { return false; }
}
