// The local cache layer. The vault itself is the folder of Markdown files on
// disk (see vaultadapter.js); this localStorage copy keeps the last known notes
// available instantly at launch and survives a hard quit that beat the file
// flush. It also seeds the first-run sample notes, which migrate into the
// user's chosen folder on connect.

const KEY = 'arf-vault-v0';

// Crockford base32 ULID (monotonic-enough for a single-user scaffold).
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid() {
  let t = Date.now();
  let time = '';
  for (let i = 9; i >= 0; i--) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  let rand = '';
  const a = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) rand += B32[a[i] % 32];
  return time + rand;
}

function nowISO() { return new Date().toISOString(); }

const SEED = [
  { title: 'Welcome to Arf', tags: ['start'],
    body: 'Arf is a second brain for scientists and coders. Write a note, link another thought with double brackets like [[Einselection]], and it appears in the backlinks and the graph.\n\nThis is the real app: your notes are Markdown, the machine that suggests connections runs on your device, and everything you build is yours to keep.\n\nTry the **Read** and **Write** toggle, open the **Graph**, and press the search shortcut.' },
  { title: 'Einselection', folder: 'Concepts/Decoherence', tags: ['decoherence', 'foundations', 'key-claim'],
    body: 'The environment does not merely disturb a quantum system; it continuously monitors it, and in doing so selects a preferred set of [[Pointer states]] that survive the interaction. Classicality is not assumed, it is emergent [@zurek2003].\n\nThe reduced density matrix loses its off-diagonals, $\\langle i | \\rho | j \\rangle \\to 0$ when $i \\neq j$.\n\n> The environment can be regarded as a witness to the state of the system.\n\nThe same redundancy that makes a state robust also makes it knowable to many observers — see [[Quantum Darwinism]].' },
  { title: 'Pointer states', folder: 'Concepts/Decoherence', tags: ['decoherence', 'foundations'],
    body: 'Pointer states are the states left undisturbed by the environmental monitoring that drives [[Einselection]]. They are the eigenstates of the interaction, and the ones that persist long enough to be measured.' },
  { title: 'Quantum Darwinism', folder: 'Concepts/Decoherence', tags: ['decoherence', 'foundations', 'emergence'],
    body: 'Information about a system’s [[Pointer states]] is copied redundantly into many fragments of the environment. Every observer intercepts only a fragment, yet all agree — objectivity is redundancy. This reframes [[Einselection]]: the environment is a communication channel, not a sink.' },
  { title: 'Arf invariant', folder: 'Concepts', tags: ['mathematics', 'foundations'],
    body: 'A nondegenerate quadratic form $q$ over the field $\\mathbb{F}_2$ is classified up to equivalence by a single bit, its Arf invariant.\n\n$$\\mathrm{Arf}(q) = \\sum_{i=1}^{n} q(a_i)\\,q(b_i)$$\n\nIt is precisely what a change of basis cannot alter: two forms are equivalent iff their invariants agree.' },
  { title: 'The measurement problem', folder: 'Concepts', tags: ['foundations', 'open-question'],
    body: 'Why does a quantum measurement yield one definite outcome, when the Schrödinger equation only ever evolves superpositions? Decoherence explains why interference between outcomes becomes practically unobservable — the environment continuously monitoring a system suppresses the off-diagonal terms of its density matrix — but not why a single result is the one experienced. The suppression of coherence and the selection of a single branch are different questions, and the second stays interpretively open.\n\nThis note deliberately links to nothing. On a real vault, the on-device model should notice it belongs beside the decoherence notes and offer the connection.' },
  { title: 'Bootstrap resampling', folder: 'Methods', tags: ['method', 'code', 'statistics'],
    body: 'Nonparametric confidence intervals by resampling with replacement.\n\n```r\nboot_mean <- function(x, B = 2000) {\n  n <- length(x)\n  replicate(B, mean(x[sample.int(n, n, replace = TRUE)]))\n}\nquantile(boot_mean(y), c(0.025, 0.975))\n```\n\nNo distributional assumption, just the empirical distribution doing the work.' },
];

let _corruptKey = null;
export function corruptBackupKey() { return _corruptKey; } // set if the last load hit corrupt storage

export function loadNotes() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) {}
  if (raw != null) {
    // real vault present — never silently reseed over it
    try { const p = JSON.parse(raw); if (!Array.isArray(p)) throw new Error('vault is not an array'); return p; }
    catch (e) {
      // corrupt but recoverable: back it up, flag it, do not overwrite
      const key = KEY + '-corrupt-' + Date.now();
      try { localStorage.setItem(key, raw); _corruptKey = key; } catch (e2) {}
      return [];
    }
  }
  const seeded = SEED.map((s) => ({ id: ulid(), folder: '', created: nowISO(), updated: nowISO(), ...s }));
  saveNotes(seeded);
  return seeded;
}

// returns true only on a real write, so the UI never claims "saved" when it wasn't
export function saveNotes(notes) {
  try { localStorage.setItem(KEY, JSON.stringify(notes)); return true; } catch (e) { return false; }
}

export function newNote(folder = '') {
  return { id: ulid(), title: 'Untitled note', folder, tags: [], created: nowISO(), updated: nowISO(), body: '' };
}

const FKEY = 'arf-folders-v0';
const SEED_FOLDERS = ['Concepts', 'Concepts/Decoherence', 'Methods'];
export function loadFolders() {
  try { const raw = localStorage.getItem(FKEY); if (raw) return JSON.parse(raw); } catch (e) {}
  saveFolders(SEED_FOLDERS); return SEED_FOLDERS.slice();
}
export function saveFolders(folders) { try { localStorage.setItem(FKEY, JSON.stringify(folders)); } catch (e) {} }

// Serialize a note to the on-disk Markdown + frontmatter form (what the real
// vault writes). Used by an export path and shown as proof of the format.
export function toMarkdown(n) {
  const fm = ['---', `id: ${n.id}`, `title: "${n.title.replace(/"/g, '\\"')}"`,
    `created: ${n.created}`, `updated: ${n.updated}`, `tags: [${n.tags.join(', ')}]`, '---', ''].join('\n');
  return fm + '\n' + n.body + '\n';
}
