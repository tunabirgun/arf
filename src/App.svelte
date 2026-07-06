<script>
  import { loadNotes, saveNotes, newNote, toMarkdown, loadFolders, saveFolders, corruptBackupKey } from './lib/vault.js';
  import { buildFolderRows, folderList } from './lib/folders.js';
  import { buildIndex, buildVectorizer, related, hasLinks, digestPairs, cosine, sharedTerms } from './lib/graphindex.js';
  import { renderMarkdown, setLinkResolver, setCiteResolver } from './lib/markdown.js';
  import { loadRefs, saveRefs } from './lib/references.js';
  import { initEmbedder, embedNotes, cosine as mlCosine, resetEmbedder } from './lib/ml.js';
  const ML_MODELS = { en: 'Xenova/all-MiniLM-L6-v2', multi: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' };
  import { connectVault, reconnectVault, lastKnownVaultPath, isTauri } from './lib/vaultadapter.js';
  import Editor from './lib/Editor.svelte';
  import GraphView from './lib/GraphView.svelte';
  import Library from './lib/Library.svelte';

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
  const MOD = IS_MAC ? '⌘' : 'Ctrl';
  const APP_VERSION = '0.5.0';

  let notes = $state(loadNotes());
  let refs = $state(loadRefs());        // shared reference library (also used by [@citekey] citations)
  let refJump = $state(null);           // { key } → Library selects that reference
  let currentId = $state(notes[0]?.id ?? null);
  let mode = $state('read');            // 'read' | 'write'
  let theme = $state(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  let view = $state('notes');           // 'notes' | 'library'
  let tagFilter = $state(null);
  let vectorizer = buildVectorizer(notes);  // { vecs, vectorize } — TF-IDF, refreshed on the debounce
  let vecs = $state(vectorizer.vecs);       // seeded so Resonance is never blank on load
  let mlEnabled = $state((() => { try { return localStorage.getItem('arf-ml') === '1'; } catch (e) { return false; } })());
  let mlModel = $state((() => { try { return localStorage.getItem('arf-mlmodel') === 'multi' ? 'multi' : 'en'; } catch (e) { return 'en'; } })());
  let mlStatus = $state('off');   // off | loading | ready | error
  let mlPct = $state(0);
  let mlVecs = $state({});         // MiniLM embeddings (id -> 384-dim), when ready
  let vaultBackend = $state(null); // the folder of Markdown files backing this vault
  let vaultBusy = $state(false);
  let vaultErr = $state(false);
  let needVault = $state(false);   // Tauri: no vault chosen yet (first run) — show the welcome gate
  let vaultMissing = $state(null); // Tauri: a stored vault path that couldn't be found on launch
  let lastSync = $state(0);         // timestamp of the last successful folder sync
  let syncing = false;              // guard so polls don't overlap
  let dirty = new Set();           // note ids changed since the last file flush
  let reconnected = false;
  let leftW = $state(loadNum('arf-leftw', 220));   // resizable sidebar widths
  let rightW = $state(loadNum('arf-rightw', 268));
  let dragging = null;             // 'l' | 'r' while resizing
  let settingsOpen = $state(false);
  let zoom = $state(loadNum('arf-zoom', 108)); // UI scale (%), a touch above 100 by default
  let saved = $state(false);
  let paletteOpen = $state(false);
  let digestOpen = $state(false);
  let graphFull = $state(false);
  let focus = $state(false);
  let query = $state('');
  let folders = $state(loadFolders());
  let collapsed = $state({});
  let activeFolder = $state('');
  let newFolderName = $state(null);
  let docExport = $state(false);
  let deFmt = $state('PDF');
  let dePage = $state('A4');
  let deMargin = $state('Normal');
  let deOpts = $state({ title: true, numberHeadings: false, keepHeadings: true, fitImages: true });
  const PAGE_SIZES = ['A4', 'Letter', 'Legal', 'Tabloid', 'A3', 'A5', 'A6', 'B5', 'Executive'];
  const PAGE_CSS = { A4: 'A4', A3: 'A3', A5: 'A5', A6: 'A6', B5: 'B5', Letter: 'letter', Legal: 'legal', Tabloid: 'ledger', Executive: '7.25in 10.5in' };

  const idx = $derived(buildIndex(notes));
  const current = $derived(notes.find((n) => n.id === currentId) ?? null);
  const backlinks = $derived((idx.back[currentId] || []).map((id) => idx.byId[id]).filter(Boolean));
  const readHTML = $derived.by(() => {
    const byTitle = idx.byTitle;                 // depend on the title index
    setLinkResolver((t) => byTitle[t] || null);  // resolve wikilinks before parsing
    const rmap = refs;                           // depend on refs so citations re-render
    setCiteResolver((k) => rmap.find((r) => r.citekey === k) || null);
    return current ? renderMarkdown(current.body) : '';
  });
  const allTags = $derived(Object.keys(idx.tagIndex).sort());
  const listNotes = $derived(tagFilter ? notes.filter((n) => (idx.noteTags[n.id] || []).includes(tagFilter)) : notes);
  const folderRows = $derived(buildFolderRows(folders, notes, collapsed));
  // the reference library lives at the vault root as references.json and travels with the folder;
  // localStorage stays as the cache. Reads happen at connect, writes on every change (debounced).
  let refsTimer;
  $effect(() => { saveRefs(refs); clearTimeout(refsTimer); refsTimer = setTimeout(refsToVault, 500); return () => clearTimeout(refsTimer); });
  async function refsToVault() { if (vaultBackend) try { await vaultBackend.writeAux('references.json', JSON.stringify(refs, null, 2)); } catch (e) {} }
  async function refsFromVault(b) {
    try {
      const raw = await b.readAux('references.json');
      if (raw) {
        const disk = JSON.parse(raw);
        if (Array.isArray(disk)) { const m = new Map(refs.map((r) => [r.id, r])); for (const r of disk) m.set(r.id, r); refs = [...m.values()]; }
      }
    } catch (e) {}
  }
  const allFolders = $derived(folderList(folders, notes));

  const resonance = $derived.by(() => {
    if (!current) return [];
    const excl = new Set([...(idx.fwd[currentId] || []), ...(idx.back[currentId] || [])]);
    if (mlStatus === 'ready' && mlVecs[currentId]) {
      const v = mlVecs[currentId];
      return notes.filter((n) => n.id !== currentId && !excl.has(n.id) && mlVecs[n.id])
        .map((n) => ({ note: n, s: mlCosine(v, mlVecs[n.id]) }))
        .filter((x) => x.s >= 0.28).sort((a, b) => b.s - a.s).slice(0, 5);
    }
    return related(currentId, vecs, notes, { exclude: excl, max: 5 })
      .map((r) => ({ note: idx.byId[r.id], s: r.s })).filter((x) => x.note);
  });

  // debounce vector recompute so typing never triggers a full-vault rescan per keystroke
  const sig = $derived(notes.map((n) => n.id + n.updated).join('|'));
  let vecTimer;
  $effect(() => {
    sig;
    clearTimeout(vecTimer);
    vecTimer = setTimeout(() => { vectorizer = buildVectorizer(notes); vecs = vectorizer.vecs; }, 350);
    return () => clearTimeout(vecTimer);
  });

  // on-device MiniLM embeddings (opt-in; TF-IDF above serves instantly meanwhile)
  function mlText(n) { return (n.title || '') + '\n' + (n.body || '').replace(/```[\s\S]*?```/g, ' '); }
  async function recomputeML() { if (mlStatus !== 'ready') return; try { mlVecs = await embedNotes(notes, mlText); } catch (e) {} }
  function startML() {
    if (mlStatus !== 'off') return;
    mlStatus = 'loading';
    initEmbedder((s) => {
      if (s.status === 'loading') mlPct = s.pct || mlPct;
      else if (s.status === 'ready') { mlStatus = 'ready'; recomputeML(); }
      else if (s.status === 'error') mlStatus = 'error';
    }, ML_MODELS[mlModel]);
  }
  function enableML() { mlEnabled = true; try { localStorage.setItem('arf-ml', '1'); } catch (e) {} startML(); }
  // switch embedding model (English vs multilingual): reload the worker and re-embed under the new key
  function setModel(m) {
    if (m === mlModel) return;
    mlModel = m; try { localStorage.setItem('arf-mlmodel', m); } catch (e) {}
    if (mlEnabled) { resetEmbedder(); mlStatus = 'off'; mlPct = 0; mlVecs = {}; startML(); }
  }
  $effect(() => { if (mlEnabled && mlStatus === 'off') startML(); });
  let mlTimer;
  $effect(() => {
    sig;
    if (mlStatus !== 'ready') return;
    clearTimeout(mlTimer);
    mlTimer = setTimeout(recomputeML, 500);
    return () => clearTimeout(mlTimer);
  });

  let saveError = $state(false);
  let vaultCorrupt = $state(!!corruptBackupKey()); // saved notes couldn't be parsed on load
  let flashTimer, saveTimer;
  function writeNow() {
    const ok = saveNotes(notes);       // localStorage stays as an always-on local cache
    saveError = !ok;
    if (ok) { saved = true; clearTimeout(flashTimer); flashTimer = setTimeout(() => (saved = false), 800); }
    flushVault();                       // and mirror changed notes to real files, if connected
  }
  function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 400); }
  function flushSave() { clearTimeout(saveTimer); writeNow(); }
  function markDirty(id) { if (vaultBackend && id) dirty.add(id); }
  let flushChain = Promise.resolve();
  function flushVault() { flushChain = flushChain.then(doFlush).catch(() => {}); return flushChain; } // serialize: never two overlapping flushes
  async function doFlush() {
    if (!vaultBackend || !dirty.size) return;
    const ids = [...dirty];
    let failed = false;
    for (const id of ids) {
      const n = notes.find((x) => x.id === id);
      if (!n) { dirty.delete(id); continue; }
      // only drop from the retry queue on a confirmed write; a failed write stays dirty for the next tick
      try { await vaultBackend.saveNote(n); dirty.delete(id); } catch (e) { failed = true; }
    }
    vaultErr = failed;
  }
  // choose a vault folder — the first run's connect and the later "switch vault…" are the
  // same flow: current notes merge into the picked folder, so nothing is ever left behind
  async function connectFolder() {
    if (vaultBusy) return; vaultBusy = true;
    try {
      if (vaultBackend) await flushVault(); // switching: finish pending writes to the old folder first
      const b = await connectVault();
      if (b) {
        flushSave();
        const existing = await b.loadAll();
        // union so neither the folder's notes nor the current ones are lost
        const merged = existing.length ? mergeByUpdated(existing, notes) : notes.slice();
        // a note's _path is only meaningful if THIS folder has that file for that id;
        // anything else (old vault, stale cache) must be cleared or saves could misfire
        const diskPathById = new Map(existing.map((n) => [n.id, n._path]));
        for (const n of merged) {
          if (n._path && diskPathById.get(n.id) !== n._path) n._path = undefined;
          try { await b.saveNote(n); } catch (e) { vaultErr = true; dirty.add(n.id); } // a failed write stays dirty and retries on the next sync tick
        }
        adopt(merged);
        folders = [...new Set([...folders, ...merged.map((n) => n.folder).filter(Boolean)])]; saveFolders(folders);
        vaultBackend = b;
        needVault = false; vaultMissing = null;
        setWinTitle(b.name);
        refsFromVault(b);
      }
    } catch (e) {} finally { vaultBusy = false; }
  }
  async function setWinTitle(name) {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setTitle(name ? 'Arf — ' + name : 'Arf');
    } catch (e) {}
  }
  // union by id, keeping the newer copy of each note — never blindly replace the array.
  // On an equal timestamp with a different body, prefer the incoming copy: local edits always
  // bump `updated`, so a same-timestamp difference means an external hand-edit we must not miss.
  function mergeByUpdated(base, incoming) {
    const m = new Map(); for (const n of base) m.set(n.id, n);
    for (const n of incoming) {
      const ex = m.get(n.id);
      const newer = !ex || (n.updated || '') > (ex.updated || '');
      const sameTimeDiffBody = ex && (n.updated || '') === (ex.updated || '') && (n.body || '') !== (ex.body || '');
      if (newer || sameTimeDiffBody) m.set(n.id, n);
    }
    return [...m.values()];
  }
  function adopt(list) { notes = list; if (!list.some((n) => n.id === currentId)) currentId = list[0]?.id ?? null; }

  // continuous two-way sync: push local edits out, pull external ones in, honour deletions.
  // Runs on a short interval and whenever the app regains focus, so a folder kept in
  // Dropbox / iCloud / Syncthing / Git stays in step across devices with no user action.
  let _conflicts = new Set(); // remote versions already stashed, so we don't re-copy every tick
  async function syncFromFolder() {
    if (!vaultBackend || syncing || vaultBusy) return;
    syncing = true;
    try {
      await flushVault();                                   // 1) push local edits to the folder
      const disk = await vaultBackend.loadAll();            // 2) read the folder's current state
      const diskIds = new Set(disk.map((n) => n.id));
      const protectedId = mode === 'write' && current ? currentId : null;
      // 3) honour deletions from another device: a note that had a file, is gone from a non-empty
      //    folder, has no unsaved edit, and isn't the note open for editing → drop it.
      const kept = disk.length ? notes.filter((n) => !n._path || diskIds.has(n.id) || dirty.has(n.id) || n.id === protectedId) : notes;
      // 4) if the note being edited also changed on another device, keep that remote version as a
      //    conflict copy instead of silently losing it under the local edit (once per remote version).
      const extra = [];
      if (protectedId) {
        const remote = disk.find((n) => n.id === protectedId);
        const localCur = notes.find((n) => n.id === protectedId);
        const key = remote && protectedId + '@' + (remote.updated || '');
        if (remote && localCur && (remote.body || '') !== (localCur.body || '') && (remote.updated || '') >= (localCur.updated || '') && !_conflicts.has(key)) {
          _conflicts.add(key);
          const cid = 'conflict_' + Date.now().toString(36);
          extra.push({ ...remote, id: cid, title: (remote.title || 'Note') + ' (conflict copy)', _path: undefined });
          dirty.add(cid);
        }
      }
      const merged = mergeByUpdated(kept, protectedId ? disk.filter((n) => n.id !== protectedId) : disk).concat(extra);
      if (syncChanged(notes, merged)) {
        const prevId = currentId;
        adopt(merged);
        if (currentId !== prevId && mode === 'write') mode = 'read';   // never leave the cursor on a note that was swapped out
        folders = [...new Set([...folders, ...merged.map((n) => n.folder).filter(Boolean)])];
      }
      lastSync = Date.now();
    } catch (e) { /* transient (permission prompt, mid-sync file swap) — next tick retries */ } finally { syncing = false; }
  }
  function syncChanged(a, b) {
    if (a.length !== b.length) return true;
    const sig = (arr) => arr.map((n) => n.id + ':' + (n.updated || '')).sort().join('|');
    return sig(a) !== sig(b);
  }
  $effect(() => {
    if (!vaultBackend) return;
    const iv = setInterval(syncFromFolder, 4000);
    const pull = () => { if (!document.hidden) syncFromFolder(); };
    window.addEventListener('focus', pull);
    document.addEventListener('visibilitychange', pull);
    return () => { clearInterval(iv); window.removeEventListener('focus', pull); document.removeEventListener('visibilitychange', pull); };
  });

  // --- whole-workspace backup: one portable .arf file (notes + folders + references) ---
  let fileInput = $state();
  let importMsg = $state('');
  async function exportWorkspace() {
    const data = { arf: 1, app: 'Arf', version: APP_VERSION, exported: new Date().toISOString(), notes, folders, refs };
    await saveText('arf-workspace-' + new Date().toISOString().slice(0, 10) + '.arf', 'application/json', JSON.stringify(data, null, 2));
  }
  async function importWorkspace(e) {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.notes)) throw new Error('Not an Arf workspace (.arf) file');
      adopt(mergeByUpdated(notes, data.notes)); // merge so nothing already here is lost
      if (Array.isArray(data.folders)) { folders = [...new Set([...folders, ...data.folders])]; saveFolders(folders); }
      if (Array.isArray(data.refs)) { const m = new Map(refs.map((r) => [r.id, r])); for (const r of data.refs) m.set(r.id, r); refs = [...m.values()]; }
      flushSave();
      importMsg = '✓ Imported ' + data.notes.length + ' notes.';
    } catch (err) { importMsg = '⚠ ' + (err.message || 'Could not read that file'); }
  }
  // launch: reopen the vault folder this app is bound to. First run (no stored path) or a
  // path that can't be found → the welcome gate. The localStorage cache keeps the last
  // known notes visible instantly either way, and everything merges once a folder is open.
  $effect(() => {
    if (reconnected) return; reconnected = true;
    (async () => {
      try {
        const b = await reconnectVault();
        if (!b) {
          if (isTauri) { vaultMissing = await lastKnownVaultPath(); needVault = true; }
          return;
        }
        const ex = await b.loadAll();
        vaultBackend = b;
        setWinTitle(b.name);
        if (ex.length) {
          const diskUpdated = new Map(ex.map((n) => [n.id, n.updated || '']));
          adopt(mergeByUpdated(ex, notes));
          // notes only in the cache, or newer there (e.g. a hard quit beat the file flush), must reach the folder
          for (const n of notes) { const d = diskUpdated.get(n.id); if (d === undefined || (n.updated || '') > d) dirty.add(n.id); }
          folders = [...new Set(notes.map((n) => n.folder).filter(Boolean))];
          flushVault();
        } else { for (const n of notes) { try { await b.saveNote(n); } catch (e) {} } } // reconnected to an emptied folder → re-seed it
        refsFromVault(b);
      } catch (e) {}
    })();
  });
  $effect(() => {
    window.addEventListener('beforeunload', flushSave);
    return () => window.removeEventListener('beforeunload', flushSave);
  });
  function editBody(v) { const n = notes.find((x) => x.id === currentId); if (!n) return; n.body = v; n.updated = new Date().toISOString(); markDirty(currentId); persist(); }
  function editTitle(v) { const n = notes.find((x) => x.id === currentId); if (!n) return; n.title = v; n.updated = new Date().toISOString(); markDirty(currentId); persist(); }
  function create() { const n = newNote(activeFolder); notes.unshift(n); currentId = n.id; mode = 'write'; view = 'notes'; markDirty(n.id); persist(); }
  function addFolder() {
    const raw = (newFolderName || '').trim(); newFolderName = null;
    if (!raw) return;
    const name = raw.replace(/\//g, '-');
    const path = activeFolder ? activeFolder + '/' + name : name;
    if (!folders.includes(path)) folders.push(path);
    saveFolders(folders); collapsed[activeFolder] = false;
  }
  function toggleFolder(path) { collapsed[path] = !collapsed[path]; }
  function moveNote(id, folder) { const n = notes.find((x) => x.id === id); if (n) { n.folder = folder; n.updated = new Date().toISOString(); markDirty(id); persist(); } }

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function exportHTML(n) {
    const o = deOpts, m = { Narrow: '1.5cm', Normal: '2.4cm', Wide: '3.4cm' }[deMargin] || '2.4cm', size = PAGE_CSS[dePage] || 'A4';
    const css = '@page{size:' + size + ';margin:' + m + ';}'
      + "body{font-family:'EB Garamond',Georgia,serif;font-size:12pt;line-height:1.6;color:#111;max-width:40em;margin:0 auto;}"
      + 'h1{font-size:22pt}h2{font-size:16pt}h1,h2,h3{font-weight:600;' + (o.keepHeadings ? 'break-after:avoid;page-break-after:avoid;' : '') + '}'
      + (o.fitImages ? 'img{max-width:100%;height:auto}pre,table{max-width:100%;overflow-x:auto;break-inside:avoid}' : '')
      + 'pre{font-family:ui-monospace,Consolas,monospace;font-size:10.5pt;background:#f4f4f2;padding:.6em .8em;border-radius:4px}'
      + 'blockquote{border-left:2px solid #ccc;padding-left:1em;color:#555;font-style:italic}'
      + '.katex{font-size:1em}'
      + (o.numberHeadings ? 'body{counter-reset:h2}h2{counter-increment:h2}h2::before{content:counter(h2)". "}' : '');
    const katexHref = [...document.styleSheets].map((s) => s.href).find((h) => h && /katex/i.test(h)) || '';
    const katexLink = katexHref ? '<link rel="stylesheet" href="' + katexHref + '">' : '';
    const title = o.title ? '<h1>' + esc(n.title) + '</h1>' : '';
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(n.title) + '</title>' + katexLink + '<style>' + css + '</style></head><body>' + title + renderMarkdown(n.body) + '</body></html>';
  }
  async function saveText(name, mime, text) {
    if (isTauri) { // desktop: browser download APIs don't work in the webview — use the native save dialog
      try {
        const [{ save }, { writeTextFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
        const path = await save({ defaultPath: name });
        if (path) await writeTextFile(path, text);
      } catch (e) { saveError = true; }
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: mime })); // web: Blob is robust for any size
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function printHTML(html) { // PDF via the print dialog (Save as PDF) — an iframe works in both browser and the Tauri webview
    const ifr = document.createElement('iframe');
    ifr.style.cssText = 'position:fixed;left:-9999px;top:0;width:820px;height:1100px;border:0;';
    document.body.appendChild(ifr);
    const d = ifr.contentWindow.document; d.open(); d.write(html); d.close();
    setTimeout(() => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) {} setTimeout(() => ifr.remove(), 3000); }, 500);
  }
  async function doExport() {
    const n = current; if (!n) return;
    const slug = (n.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'note';
    if (deFmt === 'Markdown') await saveText(slug + '.md', 'text/markdown', toMarkdown(n));
    else if (deFmt === 'HTML') await saveText(slug + '.html', 'text/html', exportHTML(n));
    else printHTML(exportHTML(n));
    docExport = false;
  }
  function open(id) { if (!idx.byId[id]) return; flushSave(); currentId = id; mode = 'read'; view = 'notes'; paletteOpen = false; graphFull = false; }
  function firstLine(b) { const l = (b || '').split('\n').find((x) => x.trim()); return l ? l.replace(/[#>*`\[\]]/g, '').slice(0, 52) : 'Empty note'; }
  function invDot(id) { return hasLinks(id, idx) ? '●' : '○'; }
  function dotTitle(id) { return hasLinks(id, idx) ? 'Linked to other notes' : 'Orphan — not linked to any note yet'; }

  function toggleTheme() { theme = theme === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', theme); try { localStorage.setItem('arf-theme', theme); } catch (e) {} }

  function loadNum(k, d) { try { const v = +localStorage.getItem(k); return v && v > 0 ? v : d; } catch (e) { return d; } }
  function startResize(which, e) { dragging = which; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); }
  function onResizeMove(e) {
    if (!dragging) return;
    const zf = (zoom || 100) / 100; // getBoundingClientRect/clientX are in zoomed px; store widths in layout px
    const ws = e.currentTarget.parentElement.getBoundingClientRect();
    if (dragging === 'l') leftW = Math.max(170, Math.min(460, Math.round((e.clientX - ws.left) / zf)));
    else rightW = Math.max(200, Math.min(480, Math.round((ws.right - e.clientX) / zf)));
  }
  function endResize() { if (!dragging) return; dragging = null; try { localStorage.setItem('arf-leftw', leftW); localStorage.setItem('arf-rightw', rightW); } catch (e) {} }
  function nudgeResize(which, e) {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0; if (!step) return; e.preventDefault();
    if (which === 'l') leftW = Math.max(170, Math.min(460, leftW + step)); else rightW = Math.max(200, Math.min(480, rightW - step));
    try { localStorage.setItem('arf-leftw', leftW); localStorage.setItem('arf-rightw', rightW); } catch (e2) {}
  }
  function setZoom(z) { zoom = Math.max(70, Math.min(160, z)); }
  function setTheme(tv) { theme = tv; document.documentElement.setAttribute('data-theme', tv); try { localStorage.setItem('arf-theme', tv); } catch (e) {} }
  $effect(() => { try { document.documentElement.style.zoom = String(zoom / 100); localStorage.setItem('arf-zoom', zoom); } catch (e) {} });
  function linkPair(aId, bId) {
    const a = idx.byId[aId], b = idx.byId[bId]; if (!a || !b) return;
    const s = window.prompt('Write the sentence that connects “' + a.title + '” and “' + b.title + '”:', '');
    if (s === null) return; // cancelled — do not fake the connection
    const line = s.trim() ? s.trim().replace(/\.?$/, '') + ' — see [[' + b.title + ']].' : 'Related to [[' + b.title + ']].';
    a.body = (a.body || '').trimEnd() + '\n\n' + line; a.updated = new Date().toISOString(); markDirty(aId); flushSave();
  }

  // read-view delegation
  function readClick(e) {
    const nav = e.target.closest('[data-nav]'); if (nav) { e.preventDefault(); open(nav.getAttribute('data-nav')); return; }
    const tg = e.target.closest('[data-tag]'); if (tg) { e.preventDefault(); tagFilter = tg.getAttribute('data-tag'); return; }
    const ck = e.target.closest('[data-cite]'); if (ck) { e.preventDefault(); openReference(ck.getAttribute('data-cite')); return; }
  }
  // a [@citekey] citation opens the Library on that reference's detail
  function openReference(key) {
    refJump = { key };
    view = 'library';
  }
  // faint-mark: while writing, does this paragraph resemble another, not-yet-linked note?
  // Judge against the OTHER notes only — including the note being written would let its own
  // text inflate its terms' document-frequency and collapse the similarity. Cache the
  // per-other-notes vectorizer so this stays cheap while typing (the others don't change).
  let _resVz = null, _resVzKey = '';
  function resembleParagraph(text) {
    if (!text || text.replace(/\s+/g, ' ').trim().length < 40) return null;
    const linked = new Set([...(idx.fwd[currentId] || []), ...(idx.back[currentId] || [])]);
    const others = notes.filter((n) => n.id !== currentId);
    if (!others.length) return null;
    const key = currentId + '#' + others.map((n) => n.id + n.updated).join(',');
    if (_resVzKey !== key) { _resVz = buildVectorizer(others); _resVzKey = key; }
    const pv = _resVz.vectorize(text);
    let best = null;
    for (const n of others) {
      if (linked.has(n.id) || !_resVz.vecs[n.id] || !n.title || n.title.includes(']')) continue; // must be linkable
      const s = cosine(pv, _resVz.vecs[n.id]);
      if (s >= 0.13 && (!best || s > best.s)) best = { id: n.id, title: n.title, s };
    }
    return best;
  }

  // command palette
  const palItems = $derived.by(() => {
    const q = query.trim().toLowerCase();
    let lex = notes.map((n) => {
      let score = 0, why = '';
      if (!q) { score = 1; why = ''; }
      else if ((n.title || '').toLowerCase().includes(q)) { score = 3; why = 'Title'; }
      else if ((idx.noteTags[n.id] || []).some((t) => t.includes(q))) { score = 2; why = 'Tag'; }
      else if ((n.body || '').toLowerCase().includes(q)) { score = 1; why = 'Text'; }
      return { id: n.id, score, why };
    }).filter((x) => x.score).sort((a, b) => b.score - a.score).slice(0, 8);
    let sem = [];
    if (q && lex.length) {
      const anchor = lex[0].id, shown = new Set(lex.map((l) => l.id));
      sem = related(anchor, vecs, notes, { exclude: shown, max: 3 });
    }
    return { lex, sem };
  });
  const digest = $derived.by(() => {
    let pairs;
    if (mlStatus === 'ready' && Object.keys(mlVecs).length) {
      pairs = [];
      for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) {
        const a = notes[i], b = notes[j];
        if (!mlVecs[a.id] || !mlVecs[b.id]) continue;
        if ((idx.fwd[a.id] || []).includes(b.id) || (idx.fwd[b.id] || []).includes(a.id)) continue;
        const s = mlCosine(mlVecs[a.id], mlVecs[b.id]);
        if (s >= 0.45) pairs.push({ a: a.id, b: b.id, s });
      }
      pairs = pairs.sort((x, y) => y.s - x.s).slice(0, 6);
    } else pairs = digestPairs(notes, vecs, idx, { max: 6 });
    // attach the words each pair shares, so the digest shows *why* they connect
    return pairs.map((p) => ({ ...p, terms: sharedTerms(idx.byId[p.a], idx.byId[p.b], 5) }));
  });

  function onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen = true; query = ''; }
    else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); if (view === 'notes') mode = mode === 'read' ? 'write' : 'read'; }
    else if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); graphFull = !graphFull; }
    else if (e.key === 'Escape') { paletteOpen = false; digestOpen = false; graphFull = false; docExport = false; settingsOpen = false; focus = false; }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if needVault}
  <div class="welcome">
    <div class="wcard">
      <div class="wwm">Arf<span class="dot">.</span></div>
      {#if vaultMissing}
        <p class="wp">Your vault couldn’t be found at <span class="wpath">{vaultMissing}</span>. The folder may have been moved, renamed, or be on a drive that isn’t connected right now.</p>
        <button class="wbtn" onclick={connectFolder}>{vaultBusy ? 'Opening…' : 'Locate the vault folder…'}</button>
        <p class="wsub">Or reconnect the drive and restart Arf. Your latest notes are kept in a local cache and will merge into whichever folder you choose.</p>
      {:else}
        <p class="wp">Your notes live in a folder of plain Markdown files on your disk — yours to read, move, back up, and keep. Choose an empty folder to start a new vault, or point Arf at an existing one.</p>
        <button class="wbtn" onclick={connectFolder}>{vaultBusy ? 'Opening…' : 'Choose your vault folder…'}</button>
        <p class="wsub">A new vault starts with a few sample notes that show links, math, and the graph. Everything stays on this machine.</p>
      {/if}
    </div>
  </div>
{:else}
<div class="shell" class:focus={focus}>
  <header class="top">
    <button class="wm" onclick={() => (view = 'notes')}>Arf<span class="dot">.</span></button>
    <div class="viewtoggle">
      <button class:on={view === 'notes'} onclick={() => (view = 'notes')}>Notes</button>
      <button class:on={view === 'library'} onclick={() => (view = 'library')}>Library</button>
    </div>
    <span class="sp"></span>
    <button class="searchpill" onclick={() => { paletteOpen = true; query = ''; }}>
      <span class="mag">⌕</span><span class="lbl">Search</span><kbd>{MOD} K</kbd>
    </button>
    <div class="topacts">
      <button class="tbtn" onclick={() => (digestOpen = true)}>Synthesis</button>
      <button class="tbtn" onclick={() => (graphFull = true)}>Graph</button>
      <button class="tbtn" class:on={focus} onclick={() => (focus = !focus)}>Focus</button>
      <button class="tbtn" onclick={toggleTheme}>Theme</button>
      <button class="tbtn" onclick={() => (settingsOpen = true)}>Settings</button>
    </div>
    <button class="newbtn" onclick={create}>＋&nbsp;New</button>
  </header>

  {#if saveError}
    <div class="savebanner">⚠ Couldn’t save — local storage may be full or blocked. Export this note now to avoid losing it.</div>
  {/if}
  {#if vaultErr}
    <div class="savebanner">⚠ A file write to your vault folder failed. Arf keeps retrying; check that the folder exists and is writable.</div>
  {/if}
  {#if vaultCorrupt}
    <div class="savebanner">⚠ Your saved notes couldn’t be read and were backed up (<span class="mono">{corruptBackupKey()}</span>). Starting with an empty vault. <button class="bnrbtn" onclick={() => (vaultCorrupt = false)}>Dismiss</button></div>
  {/if}

  {#if view === 'library'}
    <Library {notes} {idx} onopen={open} bind:refs jumpTo={refJump} />
  {:else}
    <div class="ws" style="--leftw:{leftW}px; --rightw:{rightW}px">
      <button type="button" class="resizer rz-l" aria-label="Resize left sidebar"
        style="left:{leftW - 5}px" onpointerdown={(e) => startResize('l', e)} onpointermove={onResizeMove} onpointerup={endResize} onpointercancel={endResize} onkeydown={(e) => nudgeResize('l', e)}></button>
      <button type="button" class="resizer rz-r" aria-label="Resize right sidebar"
        style="right:{rightW - 5}px" onpointerdown={(e) => startResize('r', e)} onpointermove={onResizeMove} onpointerup={endResize} onpointercancel={endResize} onkeydown={(e) => nudgeResize('r', e)}></button>
      <aside class="list">
        <div class="vaultbar">
          {#if vaultBackend}
            <span class="vlabel on" title="Writing Markdown files in “{vaultBackend.name}”. Keep this folder in Dropbox, iCloud, OneDrive, Syncthing, or a Git repo to sync it across machines."><span class="syncdot"></span>{vaultBackend.name}</span>
          {:else if isTauri}
            <span class="vlabel">◆ Opening vault…</span>
          {:else}
            <span class="vlabel" title="Running outside the Tauri shell — notes stay in local storage. Use `npm run tauri dev` for the real app.">◆ Dev preview</span>
          {/if}
          {#if vaultErr}<span class="verr" title="A file write failed">⚠</span>{/if}
        </div>
        <div class="lhrow"><span class="lh">Vault · {notes.length}</span>
          <button class="mini" title="New folder" onclick={() => (newFolderName = '')}>+ Folder</button></div>
        {#if newFolderName !== null}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="nfinput" autofocus placeholder={activeFolder ? 'Subfolder of' + ' ' + activeFolder : 'Folder name'} bind:value={newFolderName}
            onkeydown={(e) => { if (e.key === 'Enter') addFolder(); else if (e.key === 'Escape') newFolderName = null; }} onblur={addFolder} />
        {/if}

        {#if tagFilter}
          <button class="clearfilter" onclick={() => (tagFilter = null)}>← clear #{tagFilter}</button>
          {#each listNotes as n (n.id)}
            <button class="item" class:on={n.id === currentId} onclick={() => open(n.id)}>
              <span class="dot2" class:orphan={invDot(n.id) === '○'}>{invDot(n.id)}</span>
              <span class="txt"><span class="t">{n.title || 'Untitled'}</span></span>
            </button>
          {/each}
        {:else}
          {#each folderRows as r}
            {#if r.type === 'folder'}
              <button class="frow" class:active={activeFolder === r.path} style="padding-left:{6 + r.depth * 12}px" onclick={() => { toggleFolder(r.path); activeFolder = r.path; }}>
                <span class="caret">{r.hasChildren ? (r.collapsed ? '▸' : '▾') : '·'}</span><span class="fn">{r.name}</span>{#if r.count}<span class="fcount">{r.count}</span>{/if}
              </button>
            {:else}
              <button class="item" class:on={r.note.id === currentId} style="padding-left:{6 + r.depth * 12}px" onclick={() => open(r.note.id)}>
                <span class="dot2" class:orphan={invDot(r.note.id) === '○'} title={dotTitle(r.note.id)}>{invDot(r.note.id)}</span>
                <span class="txt"><span class="t">{r.note.title || 'Untitled'}</span></span>
              </button>
            {/if}
          {/each}
        {/if}

        {#if allTags.length}
          <div class="lh" style="margin-top:1rem">Tags</div>
          <div class="tags">
            {#each allTags as tg}
              <button class="tag" class:on={tagFilter === tg} onclick={() => (tagFilter = tagFilter === tg ? null : tg)}>#{tg}</button>
            {/each}
          </div>
        {/if}
      </aside>

      <main class="center">
        {#if current}
          <div class="crumbs">
            <select class="fmove" value={current.folder || ''} onchange={(e) => moveNote(current.id, e.currentTarget.value)} title="Move to folder">
              <option value="">No folder</option>
              {#each allFolders as f}<option value={f}>{f}</option>{/each}
            </select>
            {#if (current.tags || []).length}<span class="ctags"> · #{current.tags.join('  #')}</span>{/if}
            <span class="saved">{saved ? 'saved' : ''}</span>
          </div>
          <div class="titlebar">
            {#if mode === 'write'}
              <input class="title" value={current.title} oninput={(e) => editTitle(e.currentTarget.value)} aria-label="title" />
            {:else}
              <h1 class="title ro">{current.title}<span class="inv" class:orphan={invDot(current.id) === '○'} title={dotTitle(current.id)}>{invDot(current.id)}</span></h1>
            {/if}
            <div class="titlectl">
              <div class="seg">
                <button class:on={mode === 'read'} onclick={() => (mode = 'read')}>Read</button>
                <button class:on={mode === 'write'} onclick={() => (mode = 'write')}>Write</button>
              </div>
              <button class="expbtn" title="Export this note" aria-label="Export" onclick={() => (docExport = true)}>⇩</button>
            </div>
          </div>
          {#if mode === 'write'}
            {#key currentId}<div class="editor"><Editor value={current.body} onchange={editBody} resemble={resembleParagraph} /></div>{/key}
          {:else}
            <div class="read" onclick={readClick}>{@html readHTML}</div>
          {/if}
        {:else}
          <p class="empty">No note selected. Create one with “＋ New”.</p>
        {/if}
      </main>

      <aside class="rail">
        <div class="rh">Referenced in <span>{backlinks.length}</span></div>
        {#if backlinks.length}
          {#each backlinks as b}<button class="ref" onclick={() => open(b.id)}>{b.title}</button>{/each}
        {:else}<div class="rempty">No backlinks yet.</div>{/if}

        <div class="rh" style="margin-top:1.3rem">Resonance · {mlStatus === 'ready' ? 'MiniLM' : 'on-device'}
          {#if mlStatus === 'off'}<button class="mltoggle" title="Downloads a ~23MB model once; runs entirely on your device" onclick={enableML}>enable AI model</button>
          {:else if mlStatus === 'loading'}<span class="mlstat">↓ model {mlPct}%</span>
          {:else if mlStatus === 'ready'}<span class="mlstat ok">✓ on device</span>
          {:else}<span class="mlstat">TF-IDF</span>{/if}
        </div>
        {#if resonance.length}
          {#each resonance as r}
            <button class="ref ml" onclick={() => open(r.note.id)}><span class="sim" title="Similarity 0–1 (on-device)">{r.s.toFixed(2)}</span><span class="nm">{r.note.title}</span></button>
          {/each}
        {:else}<div class="rempty">Nothing close enough yet.</div>{/if}

        <div class="rh" style="margin-top:1.3rem">Local graph <button class="expand" onclick={() => (graphFull = true)}>⤢ full</button></div>
        <GraphView {notes} {idx} centerId={currentId} mode="ego" onopen={open} />
      </aside>
    </div>
  {/if}
</div>
{/if}

{#if graphFull}
  <div class="overlay">
    <div class="ovhead"><h3>Knowledge graph</h3>
      <div class="ghint">
        <span class="gh"><kbd>scroll</kbd> zoom</span>
        <span class="gh"><kbd>drag bg</kbd> pan</span>
        <span class="gh"><kbd>drag node</kbd> move</span>
        <span class="gh"><kbd>click</kbd> open</span>
        <span class="gh"><kbd>{MOD}-click</kbd> select</span>
      </div>
      <span class="sp"></span><button class="ovclose" onclick={() => (graphFull = false)}>✕ Close</button></div>
    <GraphView {notes} {idx} centerId={currentId} mode="full" onopen={open} />
  </div>
{/if}

{#if paletteOpen}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) paletteOpen = false; }}>
    <div class="palette">
      <!-- svelte-ignore a11y_autofocus -->
      <input autofocus placeholder="Search notes, tags, or ideas…" bind:value={query} onkeydown={(e) => { if (e.key === 'Enter' && (palItems.lex[0] || palItems.sem[0])) open((palItems.lex[0] || palItems.sem[0]).id); }} />
      <div class="presults">
        <div class="pg">Notes</div>
        {#each palItems.lex as l}<button class="prow" onclick={() => open(l.id)}><span class="pt">{idx.byId[l.id].title}</span><span class="pm">{l.why}</span></button>{:else}<div class="prow none">No matches</div>{/each}
        {#if palItems.sem.length}
          <div class="pg sem">Related · on-device</div>
          {#each palItems.sem as s}<button class="prow" onclick={() => open(s.id)}><span class="pt i">{idx.byId[s.id].title}</span><span class="psim">{s.s.toFixed(2)}</span></button>{/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if docExport}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) docExport = false; }}>
    <div class="modal">
      <button class="mclose" onclick={() => (docExport = false)}>✕</button>
      <h3>Export writing</h3>
      <p class="msub">Your note as a clean document — headings kept with their text, images fit to the page.</p>
      <div class="fmtpick">
        {#each ['Markdown', 'HTML', 'PDF'] as f}<button class:on={deFmt === f} onclick={() => (deFmt = f)}>{f}</button>{/each}
      </div>
      <div class="optrow"><label for="de-page">Page size</label><select id="de-page" class="expsel" bind:value={dePage}>{#each PAGE_SIZES as p}<option>{p}</option>{/each}</select></div>
      <div class="optrow"><label for="de-margin">Margins</label><select id="de-margin" class="expsel" bind:value={deMargin}><option value="Narrow">Narrow</option><option value="Normal">Normal</option><option value="Wide">Wide</option></select></div>
      <div class="optrow"><label for="de-t">Include title heading</label><input id="de-t" type="checkbox" bind:checked={deOpts.title} /></div>
      <div class="optrow"><label for="de-n">Number section headings</label><input id="de-n" type="checkbox" bind:checked={deOpts.numberHeadings} /></div>
      <div class="optrow"><label for="de-k">Keep headings with their text (no orphans)</label><input id="de-k" type="checkbox" bind:checked={deOpts.keepHeadings} /></div>
      <div class="optrow"><label for="de-i">Fit images & code to the page (no out-scaling)</label><input id="de-i" type="checkbox" bind:checked={deOpts.fitImages} /></div>
      <button class="libbtn pri" onclick={doExport}>{'Export as ' + deFmt}</button>
    </div>
  </div>
{/if}

{#if digestOpen}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) digestOpen = false; }}>
    <div class="modal">
      <button class="mclose" onclick={() => (digestOpen = false)}>✕</button>
      <h3>This week's synthesis</h3>
      <p class="msub">Notes the machine finds alike but you've never linked — with the concepts they share, so you can see the connection at a glance and link what belongs.</p>
      <div class="dgbody">
        {#each digest as p}
          <div class="pair">
            <span class="txt">
              <span class="pairtitles"><button class="a" onclick={() => open(p.a)}>{idx.byId[p.a].title}</button> <span class="mid">↔</span> <button class="a" onclick={() => open(p.b)}>{idx.byId[p.b].title}</button></span>
              {#if p.terms.length}<span class="shared">shared: {#each p.terms as tm}<span class="shtag">{tm}</span>{/each}</span>{/if}
            </span>
            <span class="psim">{p.s.toFixed(2)}</span><button class="link" onclick={() => linkPair(p.a, p.b)}>Link</button>
          </div>
        {:else}<div class="rempty" style="padding:1rem 0">Everything similar is already linked. Good week.</div>{/each}
      </div>
    </div>
  </div>
{/if}

{#if settingsOpen}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) settingsOpen = false; }}>
    <div class="modal settings">
      <button class="mclose" onclick={() => (settingsOpen = false)}>✕</button>
      <h3>Settings</h3>

      <div class="setlabel">Appearance</div>
      <div class="setrow"><span class="sk">Theme</span>
        <div class="seg"><button class:on={theme === 'light'} onclick={() => setTheme('light')}>Light</button><button class:on={theme === 'dark'} onclick={() => setTheme('dark')}>Dark</button></div>
      </div>
      <div class="setrow"><span class="sk">View zoom</span>
        <div class="zoomctl"><button onclick={() => setZoom(zoom - 8)} aria-label="Smaller">−</button><span class="zval">{zoom}%</span><button onclick={() => setZoom(zoom + 8)} aria-label="Larger">+</button><button class="zreset" onclick={() => setZoom(100)}>reset</button></div>
      </div>

      <div class="setlabel">On-device machine</div>
      <div class="setrow"><span class="sk">Connection suggestions <span class="sh">{mlModel === 'multi' ? 'Multilingual model — runs on your device, ~120 MB once' : 'MiniLM — runs on your device, ~23 MB once'}</span></span>
        {#if mlStatus === 'off'}<button class="setbtn" onclick={enableML}>Enable</button>
        {:else if mlStatus === 'loading'}<span class="setstat">downloading {mlPct}%…</span>
        {:else if mlStatus === 'ready'}<span class="setstat ok">✓ on</span>
        {:else}<span class="setstat">unavailable — using the light method</span>{/if}
      </div>
      <div class="setrow"><span class="sk">Model <span class="sh">English is smaller and faster; Multilingual understands 50+ languages, including Turkish</span></span>
        <div class="seg"><button class:on={mlModel === 'en'} onclick={() => setModel('en')}>English</button><button class:on={mlModel === 'multi'} onclick={() => setModel('multi')}>Multilingual</button></div>
      </div>

      <div class="setlabel">Your data</div>
      <div class="setrow"><span class="sk">Vault <span class="sh">{vaultBackend ? 'Markdown files in' + ' “' + vaultBackend.name + '” — ' + 'plain files on your disk, yours to keep' : 'No folder connected'}</span></span>
        <button class="setbtn" onclick={connectFolder}>{vaultBusy ? 'Opening…' : (vaultBackend ? 'Switch folder…' : 'Choose folder…')}</button>
      </div>
      <div class="setrow"><span class="sk">Sync across machines <span class="sh">Keep the vault folder in Dropbox, iCloud Drive, OneDrive, Syncthing, or a Git repo, then open the same folder in Arf on your other computers. Arf keeps it in step automatically — both ways.</span></span></div>
      <div class="setrow"><span class="sk">Workspace backup <span class="sh">{importMsg || 'one .arf file with every note, folder, and reference'}</span></span>
        <span class="setbtnrow"><button class="setbtn" onclick={exportWorkspace}>Export .arf</button><button class="setbtn" onclick={() => fileInput.click()}>Import…</button></span>
      </div>
      <input type="file" accept=".arf,application/json" bind:this={fileInput} onchange={importWorkspace} style="display:none" />

      <div class="setlabel">About</div>
      <div class="setrow"><span class="sk">Arf {APP_VERSION}</span>
        <span class="setstat"><a href="https://tunabirgun.github.io/arf-docs/" target="_blank" rel="noopener">Docs</a> · <a href="https://github.com/tunabirgun/arf" target="_blank" rel="noopener">Source</a></span>
      </div>
    </div>
  </div>
{/if}

