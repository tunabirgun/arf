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
    body: 'Arf is a second brain for scientists and coders — a place to write what you are thinking, link it to what you already know, and let a private on-device model surface the connections you missed.\n\nYour notes are plain Markdown files in a folder you choose. Nothing leaves your device. There is no account.\n\nPress **Ctrl/Cmd+K** anywhere to search every note. To turn on connection suggestions, open **Settings → Connection suggestions → Enable** — Arf fetches a small model once and runs it locally thereafter.\n\nThese three notes are here to get you started. Delete them whenever you like, then write something of your own.\n\nNext: [[Link your thoughts]].' },
  { title: 'Link your thoughts', tags: ['start', 'links'],
    body: 'A note becomes useful the moment it stops being alone. Link one note to another by wrapping its title in double brackets — like [[Welcome to Arf]] — and the relationship is recorded in both directions. The note you point to gains a **backlink** to this one.\n\nLinks resolve to a stable id, not to a filename. Rename a note in Arf or in your file manager and every link to it still holds.\n\nTry it: open any note and add `[[Welcome to Arf]]` somewhere in the body. The backlink appears there, and the **Referenced in** count above the editor goes up.\n\nNext: [[Write in Markdown]].' },
  { title: 'Write in Markdown', tags: ['start', 'editor'],
    body: 'Arf stores every note as plain Markdown. You can type the syntax, or use the formatting toolbar above the editor — both write the same file.\n\nA few things to try:\n\n- Type `## ` at the start of a line for a heading.\n- Select text and press **Ctrl/Cmd+B** for bold, **Ctrl/Cmd+I** for italic.\n- Start a line with `- ` for a bullet list, `1. ` for a numbered list, `- [ ] ` for a task.\n- Press `Enter` inside a list to continue it; press `Enter` on an empty item to exit.\n- Inline code goes between backticks: `like this`.' },
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
  // localStorage absent: return empty. Seeding is decided by the caller on a genuine first run,
  // so a wiped cache over an existing vault repopulates from disk rather than adding phantom notes.
  return [];
}

// The getting-started sample notes — seeded once, only on a true first run (no vault ever chosen).
export function seedNotes() {
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
// A fresh vault has no folders — the user creates them. (Folders are also implied
// by any note's `folder`, so nothing is lost by starting empty.)
export function loadFolders() {
  try { const raw = localStorage.getItem(FKEY); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p.filter((x) => typeof x === 'string' && x); } } catch (e) {}
  return [];
}
export function saveFolders(folders) { try { localStorage.setItem(FKEY, JSON.stringify(folders)); } catch (e) {} }

// Serialize a note to Markdown + frontmatter for the "Export as Markdown" / copy path. Close to
// the on-disk form the vault writes (vaultadapter serialize()) but not byte-identical — it does
// not escape backslashes in the title. Tags are sanitized the same way, so a tag containing a
// comma or ']' survives a round-trip through the exported file instead of splitting into several.
export function toMarkdown(n) {
  const clean = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
  const tags = (n.tags || []).map((t) => clean(t).replace(/[,\]]/g, ' ').trim()).filter(Boolean);
  const fm = ['---', `id: ${clean(n.id)}`, `title: "${clean(n.title || 'Untitled').replace(/"/g, '\\"')}"`,
    `created: ${clean(n.created)}`, `updated: ${clean(n.updated)}`, `tags: [${tags.join(', ')}]`, '---', ''].join('\n');
  return fm + '\n' + (n.body || '') + '\n';
}
