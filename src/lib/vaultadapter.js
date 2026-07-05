// The real plain-file vault: each note is a Markdown file with YAML frontmatter
// on disk, in a folder the user picks. One code path over two backends:
//   - browser: the File System Access API (Chromium), handle persisted in IndexedDB
//   - Tauri desktop: @tauri-apps/plugin-fs + plugin-dialog against a chosen folder
// The note's stable id lives in frontmatter, so a rename/move never breaks a link.

// ---------- note <-> markdown file ----------

export function slug(title) {
  return (title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}

function yamlStr(s) { return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

export function serialize(note) {
  const fm = [
    '---',
    'id: ' + note.id,
    'title: ' + yamlStr(note.title || 'Untitled'),
    'tags: [' + (note.tags || []).join(', ') + ']',
    'created: ' + (note.created || new Date().toISOString()),
    'updated: ' + (note.updated || new Date().toISOString()),
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
function relPath(note, suffix) { const dir = (note.folder || '').replace(/^\/+|\/+$/g, ''); return (dir ? dir + '/' : '') + slug(note.title) + (suffix ? '-' + suffix : '') + '.md'; }
// dedupe loaded notes by id (a stale duplicate file must not shadow the real note)
function dedupeById(notes) {
  const m = new Map();
  for (const n of notes) { const ex = m.get(n.id); if (!ex || (n.updated || '') > (ex.updated || '')) m.set(n.id, n); }
  return [...m.values()];
}

// ---------- environment ----------

export const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
export function fsaSupported() { return typeof window !== 'undefined' && 'showDirectoryPicker' in window; }
export function folderVaultSupported() { return isTauri || fsaSupported(); }

// ---------- File System Access backend (browser) ----------

const IDB = 'arf-vault-handle';
function idbGet(key) {
  return new Promise((res) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => { try { const q = r.result.transaction('h', 'readonly').objectStore('h').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } };
    r.onerror = () => res(null);
  });
}
function idbSet(key, val) {
  return new Promise((res) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => { try { r.result.transaction('h', 'readwrite').objectStore('h').put(val, key); res(true); } catch (e) { res(false); } };
    r.onerror = () => res(false);
  });
}

export class FsaBackend {
  constructor(dir) { this.dir = dir; }
  get name() { return (this.dir && this.dir.name) || 'your folder'; }
  static async pick() { const dir = await window.showDirectoryPicker({ mode: 'readwrite' }); await idbSet('dir', dir); return new FsaBackend(dir); }
  static async reconnect() {
    const dir = await idbGet('dir'); if (!dir) return null;
    const perm = await dir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { const req = await dir.requestPermission({ mode: 'readwrite' }); if (req !== 'granted') return null; }
    return new FsaBackend(dir);
  }
  async dirFor(parts, create) {
    let h = this.dir;
    for (const p of parts) h = await h.getDirectoryHandle(p, { create });
    return h;
  }
  async *walk(handle, prefix) {
    for await (const [name, entry] of handle.entries()) {
      if (name.startsWith('.')) continue;
      const rel = prefix ? prefix + '/' + name : name;
      if (entry.kind === 'directory') yield* this.walk(entry, rel);
      else if (name.endsWith('.md')) yield { rel, entry };
    }
  }
  async loadAll() {
    const notes = [];
    for await (const f of this.walk(this.dir, '')) {
      const file = await f.entry.getFile(); const text = await file.text();
      const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
      const note = parse(text, { folder: dir, fallbackId: f.rel, fallbackTitle: f.rel.split('/').pop().replace(/\.md$/, '') });
      note._path = f.rel; notes.push(note);
    }
    return dedupeById(notes);
  }
  async pathExists(path) {
    try { const parts = path.split('/'); const fname = parts.pop(); const dir = await this.dirFor(parts, false); await dir.getFileHandle(fname, { create: false }); return true; } catch (e) { return false; }
  }
  async saveNote(note) {
    let path = relPath(note);
    // never overwrite a different note that already occupies this filename
    if (note._path !== path && (await this.pathExists(path))) path = relPath(note, note.id.slice(-5).toLowerCase());
    if (note._path && note._path !== path) await this.removeByPath(note._path);
    const parts = path.split('/'); const fname = parts.pop();
    const dir = await this.dirFor(parts, true);
    const fh = await dir.getFileHandle(fname, { create: true });
    const w = await fh.createWritable(); await w.write(serialize(note)); await w.close();
    note._path = path;
  }
  async removeByPath(path) {
    try { const parts = path.split('/'); const fname = parts.pop(); const dir = await this.dirFor(parts, false); await dir.removeEntry(fname); } catch (e) {}
  }
  async removeNote(note) { if (note._path) await this.removeByPath(note._path); }
}

// ---------- Tauri filesystem backend (desktop) ----------

export class TauriBackend {
  constructor(root, fs) { this.root = root; this.fs = fs; }
  get name() { return (this.root && this.root.split(/[\\/]/).filter(Boolean).pop()) || 'your folder'; }
  static async pick() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const root = await open({ directory: true, multiple: false, title: 'Choose an Arf vault folder' });
    if (!root) return null;
    const fs = await import('@tauri-apps/plugin-fs');
    try { localStorage.setItem('arf-vault-path', root); } catch (e) {}
    return new TauriBackend(root, fs);
  }
  static async reconnect() {
    let root = null; try { root = localStorage.getItem('arf-vault-path'); } catch (e) {}
    if (!root) return null;
    const fs = await import('@tauri-apps/plugin-fs');
    try { if (!(await fs.exists(root))) return null; } catch (e) { return null; }
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
          const text = await this.fs.readTextFile(this.join(dir, e.name));
          const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
          const note = parse(text, { folder, fallbackId: rel, fallbackTitle: e.name.replace(/\.md$/, '') });
          note._path = rel; notes.push(note);
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
    if (note._path && note._path !== path) await this.removeByPath(note._path);
    const abs = this.join(this.root, path);
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    try { await this.fs.mkdir(dir, { recursive: true }); } catch (e) {}
    await this.fs.writeTextFile(abs, serialize(note));
    note._path = path;
  }
  async removeByPath(path) { try { await this.fs.remove(this.join(this.root, path)); } catch (e) {} }
  async removeNote(note) { if (note._path) await this.removeByPath(note._path); }
}

// ---------- unified entry ----------

export async function connectVault() { return isTauri ? TauriBackend.pick() : FsaBackend.pick(); }
export async function reconnectVault() {
  try { return isTauri ? await TauriBackend.reconnect() : await FsaBackend.reconnect(); } catch (e) { return null; }
}
