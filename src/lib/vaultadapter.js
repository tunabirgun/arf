// The plain-file vault: each note is a Markdown file with YAML frontmatter on
// disk, in a folder the user picks via the native dialog. Reads and writes go
// through @tauri-apps/plugin-fs; the chosen path persists so the vault reopens
// on every launch. The note's stable id lives in frontmatter, so a rename/move
// never breaks a link.

// ---------- note <-> markdown file ----------

export function slug(title) {
  // keep Unicode letters/numbers so non-Latin titles (e.g. Turkish) don't collapse to "untitled"
  let s = (title || 'untitled').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
  // Windows reserved device names (CON, NUL, COM1…) can't be real files, with any extension
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s += '-note';
  return s;
}

function yamlStr(s) { return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

// strip CR/LF from any scalar so a crafted title/id/tag can't inject extra
// frontmatter lines (a newline in the value would parse as a new YAML key)
const clean = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
export function serialize(note) {
  const fm = [
    '---',
    'id: ' + clean(note.id),
    'title: ' + yamlStr(clean(note.title || 'Untitled')),
    'tags: [' + (note.tags || []).map((t) => clean(t).replace(/[,\]]/g, ' ').trim()).filter(Boolean).join(', ') + ']',
    'created: ' + clean(note.created || new Date().toISOString()),
    'updated: ' + clean(note.updated || new Date().toISOString()),
    '---',
    '',
  ].join('\n');
  return fm + '\n' + (note.body || '').replace(/\s+$/, '') + '\n';
}

export function parse(text, opts = {}) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  let body = text, meta = {};
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([a-zA-Z0-9_]+)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2];
    }
  }
  let title = (meta.title || '').trim();
  if (/^".*"$/.test(title)) title = title.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  let tags = [];
  if (meta.tags) { const t = meta.tags.trim().replace(/^\[|\]$/g, ''); tags = t.split(',').map((x) => x.trim()).filter(Boolean); }
  const now = new Date().toISOString();
  return {
    id: (meta.id || '').trim() || opts.fallbackId || 'n' + Math.abs(hash(text)),
    title: title || opts.fallbackTitle || 'Untitled',
    folder: opts.folder || '',
    tags,
    created: (meta.created || '').trim() || now,
    updated: (meta.updated || '').trim() || now,
    body: body.replace(/^\r?\n+/, ''),
  };
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
// Win32 silently strips a trailing dot/space from a directory name, and reserved
// device names can't be folders — mirror that here so the in-memory folder path
// always equals what the filesystem actually stores (else the note hops folders
// on every sync tick). Kept in sync with canonFolder() in folders.js.
function sanSeg(s) {
  s = s.replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s += '-';
  return s;
}
function relPath(note, suffix) {
  // drop empty / "." / ".." segments so a folder name can never escape the vault root
  const dir = (note.folder || '').split(/[\\/]/).filter((seg) => seg && seg !== '.' && seg !== '..').map(sanSeg).filter(Boolean).join('/');
  return (dir ? dir + '/' : '') + slug(note.title) + (suffix ? '-' + suffix : '') + '.md';
}
// dedupe loaded notes by id (a stale duplicate file must not shadow the real note)
function dedupeById(notes) {
  const m = new Map();
  for (const n of notes) { const ex = m.get(n.id); if (!ex || (n.updated || '') > (ex.updated || '')) m.set(n.id, n); }
  return [...m.values()];
}

// ---------- environment ----------

export const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

// The vault path lives in a real config file ($APPCONFIG/config.json) because webview
// localStorage can be wiped independently of the app; localStorage is kept as a
// fast fallback and for pre-0.5 installs.
const PATH_KEY = 'arf-vault-path';
function storedVaultPath() { try { return localStorage.getItem(PATH_KEY); } catch (e) { return null; } }
export async function lastKnownVaultPath() {
  const cfg = await readVaultConfig();
  return (cfg && cfg.vaultPath) || storedVaultPath();
}
async function readVaultConfig() {
  try {
    const { readTextFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    return JSON.parse(await readTextFile('config.json', { baseDir: BaseDirectory.AppConfig }));
  } catch (e) { return null; }
}
async function writeVaultConfig(cfg) {
  try {
    const fs = await import('@tauri-apps/plugin-fs');
    const { appConfigDir } = await import('@tauri-apps/api/path');
    const dir = await appConfigDir();
    if (!(await fs.exists(dir))) await fs.mkdir(dir, { recursive: true });
    await fs.writeTextFile('config.json', JSON.stringify(cfg), { baseDir: fs.BaseDirectory.AppConfig });
  } catch (e) {}
}

// ---------- Tauri filesystem backend ----------

export class TauriBackend {
  constructor(root, fs) { this.root = root; this.fs = fs; }
  get name() { return (this.root && this.root.split(/[\\/]/).filter(Boolean).pop()) || 'your folder'; }
  static async pick() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    // recursive so the runtime scope grant covers the vault's subfolders too
    const root = await open({ directory: true, multiple: false, recursive: true, title: 'Choose an Arf vault folder' });
    if (!root) return null;
    const fs = await import('@tauri-apps/plugin-fs');
    await writeVaultConfig({ vaultPath: root });
    try { localStorage.setItem(PATH_KEY, root); } catch (e) {}
    return new TauriBackend(root, fs);
  }
  static async reconnect() {
    const cfg = await readVaultConfig();
    let root = (cfg && cfg.vaultPath) || null;
    if (!root) {
      root = storedVaultPath(); // pre-0.5 installs kept the path in localStorage only
      if (root) await writeVaultConfig({ vaultPath: root });
    }
    if (!root) return null;
    const fs = await import('@tauri-apps/plugin-fs');
    try { if (!(await fs.exists(root))) return null; } catch (e) { return null; }
    try { localStorage.setItem(PATH_KEY, root); } catch (e) {}
    return new TauriBackend(root, fs);
  }
  join(...p) { return p.filter(Boolean).join('/'); }
  async loadAll() {
    const notes = [];
    const walk = async (dir, prefix) => {
      let entries = []; try { entries = await this.fs.readDir(dir); } catch (e) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const rel = prefix ? prefix + '/' + e.name : e.name;
        if (e.isDirectory) await walk(this.join(dir, e.name), rel);
        else if (e.name.endsWith('.md')) {
          try {
            const text = await this.fs.readTextFile(this.join(dir, e.name));
            const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
            const note = parse(text, { folder, fallbackId: rel, fallbackTitle: e.name.replace(/\.md$/, '') });
            note._path = rel; notes.push(note);
          } catch (err) { /* skip one locked/unreadable file instead of aborting the whole vault load */ }
        }
      }
    };
    await walk(this.root, '');
    return dedupeById(notes);
  }
  async pathExists(path) { try { return await this.fs.exists(this.join(this.root, path)); } catch (e) { return false; } }
  async saveNote(note) {
    let path = relPath(note);
    if (note._path !== path && (await this.pathExists(path))) path = relPath(note, note.id.slice(-5).toLowerCase());
    const abs = this.join(this.root, path);
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    try { await this.fs.mkdir(dir, { recursive: true }); } catch (e) {}
    // write the new file FIRST; only remove the old path once the write succeeds, so a failed
    // write (sync-client lock, reserved name, MAX_PATH) can never leave the note on neither path
    await this.fs.writeTextFile(abs, serialize(note));
    if (note._path && note._path !== path) await this.removeByPath(note._path);
    note._path = path;
  }
  // return whether the file is actually gone, so a failed delete (locked by a sync client) can be retried
  async removeByPath(path) { try { await this.fs.remove(this.join(this.root, path)); return true; } catch (e) { return !(await this.pathExists(path)); } }
  async removeNote(note) { return note._path ? await this.removeByPath(note._path) : true; }
  // non-note files at the vault root (references.json)
  async readAux(name) {
    try { const p = this.join(this.root, name); if (!(await this.fs.exists(p))) return null; return await this.fs.readTextFile(p); } catch (e) { return null; }
  }
  async writeAux(name, text) {
    try { await this.fs.writeTextFile(this.join(this.root, name), text); return true; } catch (e) { return false; }
  }
}

// ---------- entry ----------

export async function connectVault() { return isTauri ? TauriBackend.pick() : null; }
export async function reconnectVault() {
  try { return isTauri ? await TauriBackend.reconnect() : null; } catch (e) { return null; }
}
