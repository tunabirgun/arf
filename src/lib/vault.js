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
    body: 'Arf is a second brain for scientists and coders — a place to write what you are thinking, link it to what you already know, and let a private on-device model surface the connections you missed.\n\nYour notes are plain Markdown files in a folder you choose. Nothing leaves your device. There is no account.\n\nA few starter notes live in the **Getting Started** folder. Open them in order, then delete them when you are ready.\n\nNext: [[Link your thoughts]].' },
  { title: 'Link your thoughts', folder: 'Getting Started', tags: ['start', 'links'],
    body: 'A note becomes useful the moment it stops being alone. Link one note to another by wrapping its title in double brackets — like [[Welcome to Arf]] — and the relationship is recorded in both directions. The note you point to gains a **backlink** to this one.\n\nLinks resolve to a stable id, not to a filename. Rename a note in Arf or in Finder and every link to it still holds.\n\nTry it: open any note and add `[[Welcome to Arf]]` somewhere in the body. The backlink appears here, and the **Referenced in** count above the editor goes up.\n\nNext: [[Organize with folders and tags]].' },
  { title: 'Organize with folders and tags', folder: 'Getting Started', tags: ['start', 'organization'],
    body: 'Arf gives you three ways to structure a vault, and none of them is mandatory.\n\n- **Folders** are where a note lives. Use them for coarse layout — projects, courses, years. A note belongs to one folder.\n- **Tags** are what a note is about. A note can carry many tags, and they nest: `#method/statistics` rolls up under `#method`. Click a tag to filter the sidebar to it.\n- **Links** are how a note relates to another idea. A folder answers *where*, a tag answers *what*, a link answers *how*.\n\nYou can save a note with no folder, no tag, and no link, and connect it later. Nothing is mandatory.\n\nNext: [[Write in Markdown]].' },
  { title: 'Write in Markdown', folder: 'Getting Started', tags: ['start', 'editor'],
    body: 'Arf stores every note as plain Markdown. You can type the syntax, or use the formatting toolbar above the editor — both write the same file.\n\nA few things to try:\n\n- Type `## ` at the start of a line for a heading.\n- Select text and press **Ctrl/Cmd+B** for bold, **Ctrl/Cmd+I** for italic.\n- Start a line with `- ` for a bullet list, `1. ` for a numbered list, `- [ ] ` for a task.\n- Press `Enter` inside a list to continue it; press `Enter` on an empty item to exit.\n- Inline code goes between backticks: `like this`.' },
  { title: 'Find anything fast', folder: 'Getting Started', tags: ['start', 'search'],
    body: 'Press **Ctrl/Cmd+K** anywhere to open the command palette. Type a word from a title, a tag, or the body of a note and the lexical matches appear instantly, ranked by where the word appears.\n\nBelow the lexical matches, when the on-device machine is enabled, asecond tier surfaces notes that *mean* something similar — even if they share no words.\n\nSee [[The on-device machine]] to turn it on.' },
  { title: 'The on-device machine', folder: 'Getting Started', tags: ['start', 'machine'],
    body: 'Arf can run a small language model on your own machine to suggest connections you never drew yourself. It is opt-in: open **Settings → Connection suggestions → Enable** and Arf fetches a ~23 MB model once and runs it locally thereafter. Your text never leaves the device.\n\nThe machine shows up at four moments:\n\n- **Resonance** — the rail beside each note lists the most similar notes you have not linked to it.\n- **A faint mark** — while you are writing, if a paragraph resembles an older note, a small dot appears in the margin. Click it to insert the link.\n- **Synthesis** — the **Synthesis** button in the top bar opens a weekly digest of note pairs that belong together but were never linked.\n- **Orphan nudge** — a note with no links after a while gets a quiet mark.\n\nA lighter word-overlap method works instantly before the model is ready, so Resonance is never empty.' },
  { title: 'Arf invariant', folder: 'Examples', tags: ['math', 'example'],
    body: 'Arf is named after Cahit Arf (1910–1997), the Turkish mathematician. His best-known idea, the Arf invariant, reduces a complicated object — a nondegenerate quadratic form over the field $\\mathbb{F}_2$ — to a single bit: connected, or not.\n\n$$\\mathrm{Arf}(q) = \\sum_{i=1}^{n} q(a_i)\\,q(b_i)$$\n\nTwo forms are equivalent if and only if their invariants agree. The whole structure is captured by one bit.\n\nThat spirit runs through the tool. Every note in Arf wears a small mark — a filled dot once it has been linked, a hollow one while it stands alone — so the question *has this thought found its place?* is always visible at a glance.' },
  { title: 'Your first note', tags: ['start'],
    body: 'This note links to nothing on purpose. On a real vault, the on-device model should notice it belongs beside the getting-started notes and offer the connection through Resonance or the Synthesis digest.\n\nWhen you are ready, delete the starter notes in the **Getting Started** folder and the **Arf invariant** example. Right-click a note in the sidebar to see the menu, or use **Ctrl/Cmd+R** to refresh your view of the vault after deleting files outside Arf.\n\nThen write something of your own.' },
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
