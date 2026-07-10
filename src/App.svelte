<script>
  import { loadNotes, seedNotes, saveNotes, newNote, toMarkdown, loadFolders, saveFolders, corruptBackupKey, ulid } from './lib/vault.js';
  import { buildFolderRows, folderList, canonFolder, planFolderMove } from './lib/folders.js';
  import { mergeByUpdated, syncChanged, conflictDecision } from './lib/sync.js';
  import { buildBundle, readBundle, normalizeNotes, mergeFolders, mergeRefs, mergeHls } from './lib/workspace.js';
  import { buildIndex, buildVectorizer, related, hasLinks, digestPairs, cosine, sharedTerms } from './lib/graphindex.js';
  import { renderMarkdown, setLinkResolver, setCiteResolver } from './lib/markdown.js';
  import katexCss from 'katex/dist/katex.min.css?inline';   // inlined into exports so math positions correctly outside the app
  import { loadRefs, saveRefs, loadLibFolders, saveLibFolders } from './lib/references.js';
  import { fetchOaPdf, looksLikePdf, looksLikeEpub, OA_CONTACT } from './lib/openaccess.js';
  import { formatRef, BIB_STYLES } from './lib/cite.js';
  import { initEmbedder, embedNotes, cosine as mlCosine, resetEmbedder } from './lib/ml.js';
  const ML_MODELS = { en: 'Xenova/all-MiniLM-L6-v2', multi: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' };
  import { connectVault, reconnectVault, lastKnownVaultPath, isTauri } from './lib/vaultadapter.js';
  import Editor from './lib/Editor.svelte';
  import GraphView from './lib/GraphView.svelte';
  import Library from './lib/Library.svelte';
  import Reader from './lib/Reader.svelte';

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
  const MOD = IS_MAC ? '⌘' : 'Ctrl';
  const APP_VERSION = '1.8.0';   // keep in sync with package.json / tauri.conf.json / Cargo.toml

  let notes = $state(loadNotes());
  let refs = $state(loadRefs());        // shared reference library (also used by [@citekey] citations)
  let libFolders = $state(loadLibFolders());   // the Library's folder tree (persisted; travels via library.json)
  let refJump = $state(null);           // { key } → Library selects that reference
  let bibEnabled = $state((() => { try { return localStorage.getItem('arf-bib') === '1'; } catch (e) { return false; } })());   // append a reference list to notes
  let bibStyle = $state((() => { try { return localStorage.getItem('arf-bibstyle') || 'APA'; } catch (e) { return 'APA'; } })());
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
  // note ids deleted locally whose file removal isn't confirmed yet (tombstones). Persisted so a
  // delete that failed (locked file) before quit doesn't resurrect the note on the next launch.
  let pendingDelete = new Set((() => { try { const r = localStorage.getItem('arf-tombstones'); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch (e) { return []; } })());
  function saveTombstones() { try { localStorage.setItem('arf-tombstones', JSON.stringify([...pendingDelete])); } catch (e) {} }
  let refsLoading = false;         // true while loading a vault's references.json — suppresses the debounced write-back
  let refsLoaded = false;          // don't write refs to a vault until its references.json has been read once (else an empty startup list overwrites a real one)
  let reconnected = false;
  let leftW = $state(loadNum('arf-leftw', 220));   // resizable sidebar widths
  let rightW = $state(loadNum('arf-rightw', 268));
  let leftHidden = $state(loadBool('arf-lefthidden', false));   // sidebars can be collapsed out of the way
  let rightHidden = $state(loadBool('arf-righthidden', false));
  let winW = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);   // live viewport width (bound below)
  let dragging = null;             // 'l' | 'r' while resizing
  let settingsOpen = $state(false);
  let zoom = $state(loadNum('arf-zoom', 108)); // UI scale (%), a touch above 100 by default
  let saved = $state(false);
  let paletteOpen = $state(false);
  let digestOpen = $state(false);
  let connect = $state(null);   // { aId, bId, terms, text } — the styled connect-notes modal
  let graphFull = $state(false);
  let focus = $state(false);
  let ctxMenu = $state(null);   // { x, y, items } — the context-aware right-click menu
  let ctxSub = $state(null);    // reserved for future submenus
  let editorRef = $state(null); // Editor.svelte instance, for clipboard/format from the ctx menu
  let libraryRef = $state(null); // Library.svelte instance, so the global menu can drive its folder actions
  let reader = $state(null);    // side-reader descriptor: { kind:'note', id } or a full source object
  let readerHls = $state([]);   // highlight snippets for the current reader source
  let query = $state('');
  let tagInput = $state('');   // the "+ tag" field in the crumbs bar
  let folders = $state(loadFolders());
  let collapsed = $state({});
  let orders = $state(loadOrders());   // manual sidebar order: { notes:{id:rank}, folders:{path:rank} }, sidecar order.json
  let dropEdge = $state(null);         // { kind:'note'|'folder', id?/path?, edge:'before'|'after' } while reordering
  let activeFolder = $state('');
  let newFolderName = $state(null);
  let newFolderParent = $state('');   // where a new folder lands: '' = vault root, or a folder path for a subfolder
  let uiMsg = $state('');             // transient sidebar notice (e.g. a rejected folder move)
  let uiMsgTimer;
  function notify(m) { uiMsg = m; clearTimeout(uiMsgTimer); uiMsgTimer = setTimeout(() => (uiMsg = ''), 2600); }
  let dragItem = $state(null);   // { type:'note'|'folder', id?, path? } — a sidebar drag in progress
  let dropOn = $state(null);     // folder path (or '__root__') currently hovered as a drop target
  let docExport = $state(false);
  let deFmt = $state('PDF');
  let dePage = $state('A4');
  let deMargin = $state('Normal');
  let deOpts = $state({ title: true, numberHeadings: false, keepHeadings: true, fitImages: true, frontmatter: true });
  const PAGE_SIZES = ['A4', 'Letter', 'Legal', 'Tabloid', 'A3', 'A5', 'A6', 'B5', 'Executive'];
  const PAGE_CSS = { A4: 'A4', A3: 'A3', A5: 'A5', A6: 'A6', B5: 'B5', Letter: 'letter', Legal: 'legal', Tabloid: 'ledger', Executive: '7.25in 10.5in' };

  // the link/tag/title index. Debounced (not a live $derived) so a keystroke doesn't re-parse the
  // whole vault's text on every press — the `current` note view reads `notes` directly and is unaffected;
  // only backlinks/tags/resonance/palette lag ~180ms, which is imperceptible.
  let idx = $state(buildIndex(notes));
  const current = $derived(notes.find((n) => n.id === currentId) ?? null);
  const backlinks = $derived((idx.back[currentId] || []).map((id) => idx.byId[id]).filter(Boolean));
  // disambiguate same-first-author + same-year references with a/b/c suffixes, so their in-text
  // citations read "Guth 1981a" / "Guth 1981b" instead of two identical "Guth 1981"
  const citeDisambig = $derived.by(() => {
    const groups = new Map();
    for (const r of refs) {
      const who = (r.authors && r.authors[0] && r.authors[0].f ? r.authors[0].f : '').toLowerCase();
      if (!who && !r.year) continue;
      const key = who + '|' + (r.year || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const m = new Map();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => (a.citekey || '').localeCompare(b.citekey || ''));
      list.forEach((r, i) => m.set(r.id, String.fromCharCode(97 + i)));
    }
    return m;
  });
  function citeResolver(k) { const r = refs.find((x) => x.citekey === k); return r ? { ...r, _suffix: citeDisambig.get(r.id) || '' } : null; }
  const readHTML = $derived.by(() => {
    const byTitle = idx.byTitle;                 // depend on the title index
    setLinkResolver((t) => byTitle[t] || null);  // resolve wikilinks before parsing
    citeDisambig;                                // depend on refs/disambiguation so citations re-render
    setCiteResolver(citeResolver);
    return rewriteVaultImages(current ? renderMarkdown(current.body) : '');
  });
  // optional end-of-note bibliography: the references this note cites via [@key], in the chosen style
  function buildBibHTML(n) {
    if (!bibEnabled || !n) return '';
    const seen = new Set(), keys = []; const re = /\[@([+!]?)([A-Za-z0-9_:.-]+)\]/g; let m;
    // '!' = in-text only → excluded from the list; '' (both) and '+' (reference-only) → listed
    while ((m = re.exec(n.body || ''))) { if (m[1] === '!') continue; const key = m[2]; if (!seen.has(key)) { seen.add(key); keys.push(key); } }
    const cited = keys.map((k) => refs.find((r) => r.citekey === k)).filter(Boolean);
    if (!cited.length) return '';
    const style = BIB_STYLES.includes(bibStyle) ? bibStyle : 'APA';   // a rendered list must be prose, never a multi-line BibTeX/JSON blob
    return '<div class="bib"><h2>References</h2><ol>' + cited.map((r) => {
      const sfx = citeDisambig.get(r.id) || '';
      const rr = sfx ? { ...r, year: (r.year || '') + sfx } : r;   // match the in-text "Guth 1981a" label in the list entry
      return '<li>' + esc(formatRef(rr, style)) + '</li>';
    }).join('') + '</ol></div>';
  }
  const bibHTML = $derived(buildBibHTML(current));
  // after the read view renders, resolve any vault-relative <img> placeholders to inlined data URIs
  $effect(() => {
    readHTML; currentId; mode; view;   // re-run when the rendered note changes OR the .read div remounts (mode/view toggle)
    if (!isTauri || !vaultBackend) return;
    queueMicrotask(async () => {
      const imgs = document.querySelectorAll('.read img[data-vaultimg]');
      for (const el of imgs) {
        const rel = el.getAttribute('data-vaultimg'); if (!rel) continue;
        el.removeAttribute('data-vaultimg');
        if (vaultImgCache.has(rel)) { el.src = vaultImgCache.get(rel); continue; }
        const uri = await vaultImageDataURI(rel);
        if (uri) { vaultImgCache.set(rel, uri); el.src = uri; }
      }
    });
  });
  $effect(() => { try { localStorage.setItem('arf-bib', bibEnabled ? '1' : '0'); localStorage.setItem('arf-bibstyle', bibStyle); } catch (e) {} });
  const allTags = $derived(Object.keys(idx.tagIndex).sort());
  const listNotes = $derived(tagFilter ? notes.filter((n) => (idx.noteTags[n.id] || []).includes(tagFilter)) : notes);
  const folderRows = $derived(buildFolderRows(folders, notes, collapsed, orders));
  // the reference library lives at the vault root as references.json and travels with the folder;
  // localStorage stays as the cache. Reads happen at connect, writes on every change (debounced).
  let refsTimer;
  $effect(() => { saveRefs(refs); clearTimeout(refsTimer); refsTimer = setTimeout(refsToVault, 500); return () => clearTimeout(refsTimer); });
  async function refsToVault() { if (!vaultBackend || refsLoading || !refsLoaded) return; try { await vaultBackend.writeAux('references.json', JSON.stringify(refs, null, 2)); } catch (e) {} }
  // Library folder tree persists to localStorage and, debounced, to the vault's library.json so it
  // travels with the folder. Gated by refsLoaded (shared load latch) so a startup write can't clobber disk.
  let libTimer;
  $effect(() => { saveLibFolders(libFolders); clearTimeout(libTimer); libTimer = setTimeout(libFoldersToVault, 500); return () => clearTimeout(libTimer); });
  async function libFoldersToVault() { if (!vaultBackend || refsLoading || !refsLoaded) return; try { await vaultBackend.writeAux('library.json', JSON.stringify({ folders: libFolders }, null, 2)); } catch (e) {} }
  async function libFoldersFromVault(b, replace = false) {
    try {
      const raw = await b.readAux('library.json');
      if (raw) { const disk = JSON.parse(raw); const list = Array.isArray(disk?.folders) ? disk.folders.filter((x) => typeof x === 'string' && x) : []; libFolders = replace ? list : [...new Set([...libFolders, ...list])]; }
      else if (replace) libFolders = [];
    } catch (e) { if (replace) libFolders = []; }
  }
  // replace=true on a vault switch: adopt only the new vault's references (no old-vault carry-over);
  // guarded by refsLoading so the debounced write-back can't clobber references.json before this read finishes
  async function refsFromVault(b, replace = false) {
    refsLoading = true; refsLoaded = false;
    try {
      const raw = await b.readAux('references.json');
      if (raw) {
        const disk = JSON.parse(raw);
        if (Array.isArray(disk)) {
          for (const r of disk) if (r && !Array.isArray(r.authors)) r.authors = []; // never let the Library see a ref with no authors array
          if (replace) refs = disk;
          else { const m = new Map(refs.map((r) => [r.id, r])); for (const r of disk) m.set(r.id, r); refs = [...m.values()]; }
        } else if (replace) refs = [];
      } else if (replace) refs = [];   // new vault has no references.json yet → start clean
    } catch (e) { if (replace) refs = []; } finally { refsLoading = false; refsLoaded = true; }
  }
  const allFolders = $derived(folderList(folders, notes));

  // one-time cleanup for installs upgraded from before 1.3.2: drop the old demo seed folders
  // (Concepts/Methods) if no note actually lives in them, now that a fresh vault seeds none
  (() => {
    try {
      if (localStorage.getItem('arf-seedfolders-cleaned')) return;
      const legacy = ['Concepts', 'Concepts/Decoherence', 'Methods'];
      const used = (p) => notes.some((n) => { const f = canonFolder(n.folder); return f === p || f.startsWith(p + '/'); });
      const next = folders.filter((f) => !(legacy.includes(f) && !used(f)));
      if (next.length !== folders.length) { folders = next; saveFolders(folders); }
      localStorage.setItem('arf-seedfolders-cleaned', '1');
    } catch (e) {}
  })();

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
  // rebuild the link/tag index off the same debounced signal (see the `idx` declaration above)
  let idxTimer;
  $effect(() => { sig; clearTimeout(idxTimer); idxTimer = setTimeout(() => { idx = buildIndex(notes); }, 180); return () => clearTimeout(idxTimer); });
  let vecTimer;
  $effect(() => {
    sig;
    clearTimeout(vecTimer);
    vecTimer = setTimeout(() => { vectorizer = buildVectorizer(notes); vecs = vectorizer.vecs; }, 350);
    return () => clearTimeout(vecTimer);
  });

  // on-device MiniLM embeddings (opt-in; TF-IDF above serves instantly meanwhile)
  function mlText(n) { return (n.title || '') + '\n' + (n.body || '').replace(/```[\s\S]*?```/g, ' '); }
  let _mlRun = 0;
  async function recomputeML() { if (mlStatus !== 'ready') return; const run = ++_mlRun; try { const v = await embedNotes(notes, mlText); if (run === _mlRun) mlVecs = v; } catch (e) {} } // drop a stale result if a newer recompute started
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
  // turn the on-device model off again: tear down the worker, drop its vectors, fall back to TF-IDF.
  // mlEnabled must go false before mlStatus so the (mlEnabled && off → startML) effect can't relaunch it.
  function disableML() { mlEnabled = false; try { localStorage.setItem('arf-ml', '0'); } catch (e) {} resetEmbedder(); mlStatus = 'off'; mlPct = 0; mlVecs = {}; }
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
  let exportError = $state('');   // a file export/save-dialog failure — distinct from the localStorage cache error
  let exportErrTimer;
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
      const stamp = n.updated;   // a keystroke during the await bumps this — then keep it dirty so the newest edit is written next tick
      // only drop from the retry queue on a confirmed write of the version we actually saved
      try { await vaultBackend.saveNote(n); if (n.updated === stamp) dirty.delete(id); } catch (e) { failed = true; }
    }
    vaultErr = failed;
  }
  // choose a vault folder — first run merges migration-safe; switching clears to the new folder
  async function connectFolder() {
    if (vaultBusy) return; vaultBusy = true;
    try {
      if (vaultBackend) {
        await flushVault();                 // switching: finish pending writes to the old folder first
        if (dirty.size) { vaultErr = true; vaultBusy = false; return; } // an edit failed to flush — abort rather than silently lose it
      }
      const b = await connectVault();
      if (b) {
        flushSave();
        const existing = await b.loadAll();
        const switching = !!vaultBackend;
        if (switching) {
          // the new vault's notes already live on disk — adopt them straight away so the
          // sidebar repaints instantly; do NOT re-save them (that would churn/rename files
          // in the folder we just opened). Clear all old-vault state for a clean slate.
          refsLoading = true; _conflicts.clear(); pendingDelete.clear(); saveTombstones(); activeFolder = ''; tagFilter = null;
          orders = { notes: {}, folders: {} }; reader = null;   // start the new vault's sidecar order/reader clean; ordersFromVault re-reads its own
          adopt(existing);
          folders = [...new Set(existing.map((n) => n.folder).filter(Boolean))]; saveFolders(folders);
        } else {
          // first connect → migrate current (localStorage) notes into the chosen folder,
          // merging with anything already there so nothing is lost
          const merged = existing.length ? mergeByUpdated(existing, notes) : notes.slice();
          const fromDisk = new Set(existing);   // notes the merge kept unchanged from disk — no need to rewrite them
          // a note's _path is only meaningful if THIS folder has that file for that id;
          // anything else (old vault, stale cache) must be cleared or saves could misfire
          const diskPathById = new Map(existing.map((n) => [n.id, n._path]));
          for (const n of merged) {
            if (fromDisk.has(n)) continue;      // byte-for-byte the disk copy → skip the write to avoid needless churn
            if (n._path && diskPathById.get(n.id) !== n._path) n._path = undefined;
            try { await b.saveNote(n); } catch (e) { vaultErr = true; dirty.add(n.id); } // a failed write stays dirty and retries on the next sync tick
          }
          adopt(merged);
          folders = [...new Set([...folders, ...merged.map((n) => n.folder).filter(Boolean)])]; saveFolders(folders); // merge — keep empty user folders through the migration
        }
        vaultBackend = b;
        needVault = false; vaultMissing = null;
        setWinTitle(b.name);
        await refsFromVault(b, switching);      // replace refs on a switch; guarded so the write-back can't clobber references.json
        await libFoldersFromVault(b, switching); // adopt the vault's library folder tree the same way
        await ordersFromVault(b);                // adopt the vault's manual sidebar order (order.json)
        await hlsFromVault(b);                   // merge in the vault's reader highlights (reader-highlights.json)
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
  function adopt(list) { notes = list; if (!list.some((n) => n.id === currentId)) currentId = list[0]?.id ?? null; }

  // continuous two-way sync: push local edits out, pull external ones in, honour deletions.
  // Runs on a short interval and whenever the app regains focus, so a folder kept in
  // Dropbox / iCloud / Syncthing / Git stays in step across devices with no user action.
  let _conflicts = new Set(); // remote versions already stashed, so we don't re-copy every tick
  async function syncFromFolder() {
    if (!vaultBackend || syncing || vaultBusy) return;
    if (document.hidden) return;   // don't re-read the whole vault every 4s while the window is hidden; the focus/visibility listeners pull on regain
    syncing = true;
    try {
      await flushVault();                                   // 1) push local edits to the folder
      const disk = await vaultBackend.loadAll();            // 2) read the folder's current state
      const diskIds = new Set(disk.map((n) => n.id));
      // tombstones: retry a delete whose file removal never confirmed, and never resurrect a note the user deleted
      const reaped = new Set(); // ids whose file we removed THIS tick — `disk` still lists them, so exclude explicitly or they resurrect
      if (pendingDelete.size) {
        for (const dn of disk) if (pendingDelete.has(dn.id)) { if (await vaultBackend.removeByPath(dn._path)) { pendingDelete.delete(dn.id); reaped.add(dn.id); } } // retry; drop tombstone on confirmed removal
        for (const id of [...pendingDelete]) if (!diskIds.has(id)) { pendingDelete.delete(id); reaped.add(id); } // already gone from disk → tombstone resolved
        saveTombstones();
      }
      const live = (pendingDelete.size || reaped.size) ? disk.filter((n) => !pendingDelete.has(n.id) && !reaped.has(n.id)) : disk;
      const protectedId = mode === 'write' && current ? currentId : null;
      // 3) honour deletions from another device: a note that had a file, is gone from a non-empty
      //    folder, has no unsaved edit, and isn't the note open for editing → drop it.
      const kept = disk.length ? notes.filter((n) => !n._path || diskIds.has(n.id) || dirty.has(n.id) || n.id === protectedId) : notes;
      // 4) if the note being edited also changed on another device, keep that remote version as a
      //    conflict copy instead of silently losing it under the local edit (once per remote version).
      //    updated must be STRICTLY newer: a self-flush round-trips `updated` byte-for-byte while the
      //    serializer rewrites body whitespace, so `>=` would flag our own write as a phantom conflict.
      const extra = [];
      if (protectedId) {
        const remote = live.find((n) => n.id === protectedId);
        const localCur = notes.find((n) => n.id === protectedId);
        const { conflict, key } = conflictDecision(localCur, remote, _conflicts);
        if (conflict) {
          _conflicts.add(key);
          const cid = 'conflict_' + Date.now().toString(36);
          extra.push({ ...remote, id: cid, title: (remote.title || 'Note') + ' (conflict copy)', _path: undefined });
          dirty.add(cid);
        }
      }
      const merged = mergeByUpdated(kept, protectedId ? live.filter((n) => n.id !== protectedId) : live).concat(extra);
      if (syncChanged(notes, merged)) {
        const prevId = currentId;
        adopt(merged);
        if (currentId !== prevId && mode === 'write') mode = 'read';   // never leave the cursor on a note that was swapped out
        folders = [...new Set([...folders, ...merged.map((n) => n.folder).filter(Boolean)])];
      }
      lastSync = Date.now();
    } catch (e) { /* transient (permission prompt, mid-sync file swap) — next tick retries */ } finally { syncing = false; }
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
  let importMsgTimer;
  async function exportWorkspace() {
    // inline vault-stored note images into the bundle bodies so the .arf file is fully portable
    let outNotes = notes;
    if (isTauri && vaultBackend) { outNotes = []; for (const n of notes) outNotes.push({ ...n, body: await inlineVaultImagesMd(n.body || '') }); }
    const data = buildBundle(outNotes, folders, refs, APP_VERSION, new Date().toISOString(), libFolders, loadReaderHlMap());
    await saveText('arf-workspace-' + new Date().toISOString().slice(0, 10) + '.arf', 'application/json', JSON.stringify(data, null, 2));
  }
  async function importWorkspace(e) {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!file) return;
    try {
      const data = readBundle(await file.text());
      const localPath = new Map(notes.map((n) => [n.id, n._path]));
      const incoming = normalizeNotes(data.notes, localPath, ulid);
      adopt(mergeByUpdated(notes, incoming)); // merge so nothing already here is lost
      if (vaultBackend) for (const n of incoming) dirty.add(n.id); // write imported notes to the vault now, not next launch
      if (Array.isArray(data.folders)) { folders = mergeFolders(folders, data.folders); saveFolders(folders); }
      if (Array.isArray(data.libFolders)) libFolders = mergeFolders(libFolders, data.libFolders);   // library tree from an older/newer bundle merges in; absence is fine
      if (Array.isArray(data.refs)) refs = mergeRefs(refs, data.refs);
      if (data.readerHls && typeof data.readerHls === 'object') {   // merge highlights from the bundle so they survive an import and re-sync
        try { localStorage.setItem(READER_HL_KEY, JSON.stringify(mergeHls(loadReaderHlMap(), data.readerHls))); const k = readerSource?.key; if (k) readerHls = loadReaderHls(k); queueMicrotask(hlsToVault); } catch (e) {}
      }
      importMsg = '✓ Imported ' + incoming.length + ' notes.';
    } catch (err) { importMsg = '⚠ ' + (err.message || 'Could not read that file'); }
    finally { flushSave(); clearTimeout(importMsgTimer); importMsgTimer = setTimeout(() => (importMsg = ''), 6000); }   // persist adopted notes even if the merge threw; don't let the status stick forever as the help text
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
          // seed the getting-started notes only on a genuine first run (no vault ever chosen),
          // never when the localStorage cache was merely wiped over an existing/known vault
          if (!vaultMissing && !notes.length) adopt(seedNotes());
          return;
        }
        const ex = await b.loadAll();
        vaultBackend = b;
        setWinTitle(b.name);
        // a note whose local delete never confirmed must not resurrect from its lingering file;
        // keep it tombstoned and let the sync loop reap the file through its tested path
        const live = pendingDelete.size ? ex.filter((n) => !pendingDelete.has(n.id)) : ex;
        if (ex.length) {
          const diskPath = new Map(ex.map((n) => [n.id, n._path]));
          const diskUpdated = new Map(live.map((n) => [n.id, n.updated || '']));
          adopt(mergeByUpdated(live, notes));
          // notes only in the cache, or newer there (e.g. a hard quit beat the file flush), must reach the folder
          for (const n of notes) {
            if (diskPath.has(n.id)) n._path = diskPath.get(n.id);   // reconcile a stale cached _path to the real on-disk path, or a rename recreates the old file
            const d = diskUpdated.get(n.id); if (d === undefined || (n.updated || '') > d) dirty.add(n.id);
          }
          folders = [...new Set([...folders, ...notes.map((n) => n.folder).filter(Boolean)])];   // merge, never replace — an empty user-made folder must survive relaunch
          flushVault();
        } else { for (const n of notes) { try { await b.saveNote(n); } catch (e) {} } } // reconnected to an emptied folder → re-seed it
        refsFromVault(b);
        libFoldersFromVault(b);
        ordersFromVault(b);
        hlsFromVault(b);
      } catch (e) {}
    })();
  });
  $effect(() => {
    window.addEventListener('beforeunload', flushSave);
    return () => window.removeEventListener('beforeunload', flushSave);
  });
  function editBody(v) { const n = notes.find((x) => x.id === currentId); if (!n) return; n.body = v; n.updated = new Date().toISOString(); markDirty(currentId); persist(); }
  function editTitle(v) { const n = notes.find((x) => x.id === currentId); if (!n) return; n.title = v; n.updated = new Date().toISOString(); markDirty(currentId); persist(); }
  // edit the note's own tags (the chips above the title) — separate from the #tags typed in the body
  function addNoteTag(v) {
    const t = (v || '').trim().replace(/^#/, '').toLowerCase().replace(/[^\p{L}\p{N}/_-]/gu, '');   // keep Unicode letters (ğ ş ü …)
    const n = current; if (!t || !n) return;
    if (!Array.isArray(n.tags)) n.tags = [];
    if (!n.tags.includes(t)) { n.tags = [...n.tags, t]; n.updated = new Date().toISOString(); markDirty(n.id); persist(); }
  }
  function removeNoteTag(t) { const n = current; if (!n) return; n.tags = (n.tags || []).filter((x) => x !== t); n.updated = new Date().toISOString(); markDirty(n.id); persist(); }
  function create() {
    tagFilter = null;                                  // a tag filter would hide the new note; clear it so it's visible
    if (activeFolder) collapsed[activeFolder] = false;  // and expand the folder it lands in
    const n = newNote(activeFolder); notes.unshift(n); currentId = n.id; mode = 'write'; view = 'notes'; markDirty(n.id); persist();
  }
  // create a note with a given title — used when a dangling [[wikilink]] is clicked in the read view
  function createNamed(title) {
    title = (title || '').trim(); if (!title) { create(); return; }
    tagFilter = null;
    const n = newNote(activeFolder); n.title = title;
    notes.unshift(n); currentId = n.id; mode = 'write'; view = 'notes'; markDirty(n.id); persist();
  }
  function addFolder() {
    const raw = (newFolderName || '').trim(); newFolderName = null;
    if (!raw) return;
    const name = canonFolder(raw.replace(/[\/\\]/g, '-'));   // one segment; canonFolder strips trailing dot/space + reserved names so it matches disk
    if (!name) return;
    const parent = canonFolder(newFolderParent);
    const path = parent ? parent + '/' + name : name;
    if (!folders.includes(path)) folders = [...folders, path];
    saveFolders(folders); if (parent) collapsed[parent] = false;
  }
  function toggleFolder(path) { collapsed[path] = !collapsed[path]; }
  function moveNote(id, folder) {
    const n = notes.find((x) => x.id === id); if (!n) return;
    const dest = canonFolder(folder);
    if (canonFolder(n.folder) === dest) return; // already there — no churn
    n.folder = dest; n.updated = new Date().toISOString(); markDirty(id); persist();
    clearNoteOrder(id);   // moved to a new folder → sort alphabetically there, not by its old rank
  }
  // move/nest a folder subtree under destParent ('' = vault root); reparents its subfolders and notes
  function moveFolder(src, destParent) {
    const plan = planFolderMove(src, destParent, folders, notes);
    if (!plan.ok) { if (plan.reason === 'collision') notify('A folder named “' + plan.leaf + '” already exists there.'); return; }
    folders = plan.newFolders;
    for (const m of plan.noteMoves) {
      const n = notes.find((x) => x.id === m.id);
      if (n) { n.folder = m.to; n.updated = new Date().toISOString(); markDirty(n.id); }
    }
    if (collapsed[plan.src] != null) { collapsed[plan.newPath] = collapsed[plan.src]; delete collapsed[plan.src]; }
    if (activeFolder === plan.src || activeFolder.startsWith(plan.src + '/')) activeFolder = plan.reparent(activeFolder);
    clearFolderOrdersUnder(plan.src);   // old paths no longer exist; the moved folder sorts fresh in its new parent
    saveFolders(folders); persist();
  }
  // --- manual reordering (drag to change order) — persisted in an order.json sidecar so it
  // travels with the vault and never touches note frontmatter or the tested merge path ---
  function loadOrders() { try { const raw = localStorage.getItem('arf-order-v0'); if (raw) { const p = JSON.parse(raw); if (p && typeof p === 'object') return { notes: p.notes || {}, folders: p.folders || {} }; } } catch (e) {} return { notes: {}, folders: {} }; }
  let orderTimer;
  function persistOrders() { try { localStorage.setItem('arf-order-v0', JSON.stringify(orders)); } catch (e) {} clearTimeout(orderTimer); orderTimer = setTimeout(ordersToVault, 500); }
  async function ordersToVault() { if (!vaultBackend) return; try { await vaultBackend.writeAux('order.json', JSON.stringify(orders)); } catch (e) {} }
  async function ordersFromVault(b) { try { const raw = await b.readAux('order.json'); if (raw) { const p = JSON.parse(raw); if (p && typeof p === 'object') orders = { notes: p.notes || {}, folders: p.folders || {} }; } } catch (e) {} }
  // drop a stale manual-order rank when an item leaves its sibling group, so a moved/reparented note
  // sorts alphabetically in its new home instead of carrying its old rank (and a recreated folder of
  // the same name can't inherit a deleted folder's rank)
  function clearNoteOrder(id) { if (orders.notes[id] == null) return; const no = { ...orders.notes }; delete no[id]; orders = { ...orders, notes: no }; persistOrders(); }
  function clearFolderOrdersUnder(path) { let ch = false; const fo = { ...orders.folders }; for (const k in fo) if (k === path || k.startsWith(path + '/')) { delete fo[k]; ch = true; } if (ch) { orders = { ...orders, folders: fo }; persistOrders(); } }
  const folderParent = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  // renumber a whole sibling group 0..n-1 in its new visual order, so the group becomes fully
  // ordered (no Infinity/explicit mix) and later inserts stay predictable
  function reorderNote(dragId, targetId, edge) {
    const drag = notes.find((n) => n.id === dragId), target = notes.find((n) => n.id === targetId);
    if (!drag || !target || dragId === targetId) return;
    const folder = canonFolder(target.folder);
    if (canonFolder(drag.folder) !== folder) return;   // only reorder within the same folder
    const sibs = folderRows.filter((r) => r.type === 'note' && canonFolder(r.note.folder) === folder).map((r) => r.note.id);
    const without = sibs.filter((id) => id !== dragId);
    let at = without.indexOf(targetId); if (at < 0) return;
    at = edge === 'before' ? at : at + 1;
    without.splice(at, 0, dragId);
    const no = { ...orders.notes }; without.forEach((id, i) => (no[id] = i));
    orders = { ...orders, notes: no }; persistOrders();
  }
  function reorderFolder(dragPath, targetPath, edge) {
    dragPath = canonFolder(dragPath); targetPath = canonFolder(targetPath);
    if (!dragPath || dragPath === targetPath || folderParent(dragPath) !== folderParent(targetPath)) return;
    const par = folderParent(targetPath);
    const sibs = folderRows.filter((r) => r.type === 'folder' && folderParent(r.path) === par).map((r) => r.path);
    const without = sibs.filter((p) => p !== dragPath);
    let at = without.indexOf(targetPath); if (at < 0) return;
    at = edge === 'before' ? at : at + 1;
    without.splice(at, 0, dragPath);
    const fo = { ...orders.folders }; without.forEach((p, i) => (fo[p] = i));
    orders = { ...orders, folders: fo }; persistOrders();
  }
  // decide from the pointer's Y whether a drag over a row means "reorder before/after it"
  // (same-container sibling) rather than "move into". Sets dropEdge, or clears it for move-into.
  function noteRowDragOver(e, note) {
    if (!dragItem) return false;
    if (dragItem.type === 'note' && dragItem.id !== note.id) {
      const drag = notes.find((n) => n.id === dragItem.id);
      if (drag && canonFolder(drag.folder) === canonFolder(note.folder)) {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        dropEdge = { kind: 'note', id: note.id, edge: (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after' };
        dropOn = null; return true;
      }
    }
    return false;
  }
  function folderRowDragOver(e, path) {
    if (!dragItem || dragItem.type !== 'folder' || dragItem.path === path) return false;
    if (folderParent(canonFolder(dragItem.path)) !== folderParent(canonFolder(path))) return false;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    // middle band nests INTO the folder (existing behaviour); top/bottom edge reorders siblings
    if (y > 0.28 && y < 0.72) return false;
    e.preventDefault();
    dropEdge = { kind: 'folder', path, edge: y <= 0.28 ? 'before' : 'after' };
    dropOn = null; return true;
  }
  // --- sidebar drag & drop: move notes into folders, nest folders under folders ---
  function onDragStart(e, item) {
    dragItem = item;
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.type + ':' + (item.id || item.path)); } catch (x) {}
  }
  function onDragEnd() { dragItem = null; dropOn = null; dropEdge = null; stopAutoScroll(); }
  // auto-scroll the sidebar while dragging near its top/bottom edge, so an off-screen drop target is reachable
  let autoScrollRAF = null, autoScrollV = 0, autoScrollEl = null;
  function listAutoScroll(e) {
    if (!dragItem) return;
    autoScrollEl = e.currentTarget;
    const r = autoScrollEl.getBoundingClientRect(), edge = 46, y = e.clientY;
    if (y < r.top + edge) autoScrollV = -Math.ceil((r.top + edge - y) / 5);
    else if (y > r.bottom - edge) autoScrollV = Math.ceil((y - (r.bottom - edge)) / 5);
    else autoScrollV = 0;
    if (autoScrollV && !autoScrollRAF) {
      const step = () => { if (!dragItem || !autoScrollV || !autoScrollEl) { autoScrollRAF = null; return; } autoScrollEl.scrollTop += autoScrollV; autoScrollRAF = requestAnimationFrame(step); };
      autoScrollRAF = requestAnimationFrame(step);
    }
  }
  function stopAutoScroll() { autoScrollV = 0; if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; } autoScrollEl = null; }
  function dragAllowed(target) { // '' or a folder path
    if (!dragItem) return false;
    if (dragItem.type === 'folder') { const s = canonFolder(dragItem.path), t = canonFolder(target); if (t === s || t.startsWith(s + '/')) return false; }
    return true;
  }
  function onDragOver(e, target) { if (!dragAllowed(target)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (x) {} dropOn = target === '' ? '__root__' : target; }
  function onDrop(e, target) {
    e.preventDefault();
    const d = dragItem, ok = dragAllowed(target);
    dragItem = null; dropOn = null; dropEdge = null;
    if (!d || !ok) return;
    if (d.type === 'note') moveNote(d.id, target);
    else moveFolder(d.path, target);
  }
  function isEdge(kind, key, edge) { return !!dropEdge && dropEdge.kind === kind && (kind === 'note' ? dropEdge.id : dropEdge.path) === key && dropEdge.edge === edge; }
  function onNoteRowDrop(e, note) {
    e.preventDefault();
    if (dropEdge && dropEdge.kind === 'note') { const id = dragItem && dragItem.id; dragItem = null; dropOn = null; const edge = dropEdge; dropEdge = null; reorderNote(id, edge.id, edge.edge); return; }
    onDrop(e, canonFolder(note.folder));
  }
  function onFolderRowDrop(e, path) {
    e.preventDefault();
    if (dropEdge && dropEdge.kind === 'folder') { const p = dragItem && dragItem.path; dragItem = null; dropOn = null; const edge = dropEdge; dropEdge = null; reorderFolder(p, edge.path, edge.edge); return; }
    onDrop(e, path);
  }

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // The Arf mark for exports: a transparent inline SVG (serif "A" + accent dot), no background, no
  // embedded raster. Sits in the top-right corner of the page; nothing else is added to header/footer.
  const ARF_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 40" role="img" aria-label="Arf"><text x="0" y="33" font-family="Georgia,\'Times New Roman\',serif" font-size="40" font-weight="700" fill="#1a1a1a">A</text><circle cx="37" cy="30" r="4.6" fill="#2c4a6e"/></svg>';
  const ARF_LOGO_HTML = '<div class="arf-logo" aria-hidden="true">' + ARF_LOGO_SVG + '</div>';
  // sidebar-toggle glyphs: a framed rectangle with the side rail marked; the rail is filled when the
  // panel is open, hollow when it's hidden — so state reads at a glance without relying on colour.
  const panelIcon = (side, open) => {
    const x = side === 'l' ? 6 : 10, fx = side === 'l' ? 1.7 : 10.6;
    return '<svg viewBox="0 0 16 14" width="15" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">'
      + '<rect x="1" y="1.6" width="14" height="10.8" rx="1.8"/>'
      + '<line x1="' + x + '" y1="1.6" x2="' + x + '" y2="12.4"/>'
      + (open ? '<rect x="' + fx + '" y="2.3" width="3.7" height="9.4" rx="0.8" fill="currentColor" stroke="none"/>' : '')
      + '</svg>';
  };
  // export CSS, with an optional scope prefix so the same rules serve a standalone document (scope='')
  // and an in-page print container (scope='#arf-printroot ') without clobbering the app's own styles
  function buildExportCSS(scope) {
    const o = deOpts, m = { Narrow: '1.5cm', Normal: '2.4cm', Wide: '3.4cm' }[deMargin] || '2.4cm', size = PAGE_CSS[dePage] || 'A4';
    const B = scope ? scope.trim() : 'body';
    return '@page{size:' + size + ';margin:' + m + ';}'
      + B + "{font-family:'EB Garamond',Georgia,serif;font-size:12pt;line-height:1.6;color:#111;max-width:40em;margin:0 auto;}"
      + scope + 'h1{font-size:22pt}' + scope + 'h2{font-size:16pt}' + scope + 'h1,' + scope + 'h2,' + scope + 'h3{font-weight:600;' + (o.keepHeadings ? 'break-after:avoid;page-break-after:avoid;' : '') + '}'
      + (o.fitImages ? scope + 'img{display:block;max-width:100%;max-height:88vh;height:auto;margin:1em auto;break-inside:avoid}' + scope + 'pre,' + scope + 'table{max-width:100%;overflow-x:auto;break-inside:avoid}' : scope + 'img{display:block;max-width:100%;height:auto;margin:1em auto}')
      + scope + 'pre{font-family:ui-monospace,Consolas,monospace;font-size:10.5pt;background:#f4f4f2;padding:.6em .8em;border-radius:4px}'
      + scope + 'blockquote{border-left:2px solid #ccc;padding-left:1em;color:#555;font-style:italic}'
      + scope + '.katex{font-size:1em}'
      + (o.numberHeadings ? B + '{counter-reset:h2}' + scope + 'h2{counter-increment:h2}' + scope + 'h2::before{content:counter(h2)". "}' : '')
      + scope + '.bib{margin-top:2em;border-top:1px solid #ddd;padding-top:1em}' + scope + '.bib h2{font-size:14pt}' + scope + '.bib ol{padding-left:1.4em}' + scope + '.bib li{margin:.35em 0;font-size:11pt}'
      + scope + '.arf-logo{position:fixed;top:6mm;right:7mm;width:20px;opacity:.9;z-index:10}' + scope + '.arf-logo svg{display:block;width:100%;height:auto}';
  }
  // the note's exportable body (title + rendered markdown + bibliography); resolvers set here because
  // export can fire from write mode where the read-view derived never ran
  function exportBody(n) {
    setLinkResolver((t) => idx.byTitle[t] || null);
    setCiteResolver(citeResolver);
    const title = deOpts.title ? '<h1>' + esc(n.title || 'Untitled') + '</h1>' : '';
    return ARF_LOGO_HTML + title + renderMarkdown(n.body) + buildBibHTML(n);
  }
  function exportHTML(n) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(n.title || 'Untitled') + '</title><style>' + katexCss + '</style><style>' + buildExportCSS('') + '</style></head><body>' + exportBody(n) + '</body></html>';
  }
  async function saveText(name, mime, text) {
    if (isTauri) { // desktop: browser download APIs don't work in the webview — use the native save dialog
      try {
        const [{ save }, { writeTextFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
        const path = await save({ defaultPath: name });
        if (path) await writeTextFile(path, text);
      } catch (e) { exportError = 'Couldn’t save the file — the save was cancelled or the folder isn’t writable.'; clearTimeout(exportErrTimer); exportErrTimer = setTimeout(() => (exportError = ''), 4000); }
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: mime })); // web: Blob is robust for any size
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  // PDF via the print dialog (Save as PDF). Print the TOP-LEVEL document, not an iframe: WKWebView
  // (macOS) silently ignores iframe.contentWindow.print() and WebKitGTK (Linux) is unreliable — only
  // window.print() on the main document works uniformly. A print stylesheet hides the app and shows
  // just the export container; katexCss is included so math typesets.
  function printDoc(bodyHTML, scopedCSS) {
    const root = document.createElement('div'); root.id = 'arf-printroot'; root.innerHTML = bodyHTML;
    const style = document.createElement('style'); style.id = 'arf-printstyle';
    style.textContent = katexCss
      + '@media screen{#arf-printroot{display:none}}'
      + '@media print{html{zoom:1!important}body{margin:0}body>*:not(#arf-printroot){display:none!important}#arf-printroot{display:block}}'
      + scopedCSS;
    document.head.appendChild(style); document.body.appendChild(root);
    const cleanup = () => { try { root.remove(); style.remove(); } catch (e) {} window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => { try { window.print(); } catch (e) {} }, 80);
    setTimeout(cleanup, 60000);   // fallback if afterprint never fires
  }
  async function doExport() {
    const n = current; if (!n) return;
    const slug = (n.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'note';
    if (deFmt === 'Markdown') await saveText(slug + '.md', 'text/markdown', await inlineVaultImagesMd(toMarkdown(n, { frontmatter: deOpts.frontmatter })));
    else if (deFmt === 'HTML') await saveText(slug + '.html', 'text/html', await inlineVaultImages(exportHTML(n)));
    else printDoc(await inlineVaultImages(exportBody(n)), buildExportCSS('#arf-printroot '));
    docExport = false;
  }
  function open(id) { if (!idx.byId[id] && !notes.some((n) => n.id === id)) return; flushSave(); currentId = id; mode = 'read'; view = 'notes'; paletteOpen = false; graphFull = false; }

  // --- context-aware right-click menu ---
  // one global handler suppresses the native WebView menu everywhere and opens an Arf menu
  // whose items depend on what was clicked (note, folder, tag, link, editor, read view, or app).
  function onContextMenu(e) {
    e.preventDefault();
    const items = buildCtxItems(e.target);
    if (!items || !items.length) { closeCtx(); return; }
    const zf = (zoom || 100) / 100;
    const W = window.innerWidth / zf, H = window.innerHeight / zf;
    const rows = items.filter((i) => !i.sep).length, seps = items.filter((i) => i.sep).length;
    const mw = 260, mh = rows * 30 + seps * 9 + 12;      // matches .ctxmenu max-width; labels ellipsize so this holds
    let x = e.clientX / zf, y = e.clientY / zf;
    if (x + mw > W) x = Math.max(4, W - mw - 4);
    if (y + mh > H) y = Math.max(4, H - mh - 4);
    ctxMenu = { x: Math.round(x), y: Math.round(y), items };
    ctxSub = null;
  }
  function closeCtx() { ctxMenu = null; ctxSub = null; }
  function runCtx(it) { if (it.disabled) return; const r = it.run; closeCtx(); if (r) r(); }
  $effect(() => { window.addEventListener('contextmenu', onContextMenu); return () => window.removeEventListener('contextmenu', onContextMenu); });
  // modal a11y: while an overlay is open, make the background inert (Tab/screen-reader can't wander
  // behind it), mark the dialog with role/aria-modal, move focus in, and restore focus to the opener on close
  let overlayReturnFocus = null;
  $effect(() => {
    // read each overlay flag individually so the effect re-fires on ANY change — including a same-tick
    // overlay→overlay swap (e.g. graph → Search), which a single boolean would miss.
    // citePick is intentionally excluded: it's an inline tool that inserts into (and refocuses) the
    // editor, so making the editor inert would break edPaste's view.focus() and strand the caret.
    const open = paletteOpen || settingsOpen || digestOpen || !!connect || docExport || !!movePick || graphFull;
    const shell = document.querySelector('.shell');
    if (open) {
      if (!overlayReturnFocus) overlayReturnFocus = document.activeElement;
      if (shell) shell.setAttribute('inert', '');
      queueMicrotask(() => {
        const dlg = document.querySelector('.palette:not(.citepicker), .modal, .overlay'); if (!dlg) return;   // skip the cite picker (excluded from inert) so a real modal opened over it still gets the dialog aria
        dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
        const h = dlg.querySelector('h3, h1, input');
        if (h && !dlg.hasAttribute('aria-label') && !dlg.hasAttribute('aria-labelledby')) {
          if (h.tagName === 'INPUT') dlg.setAttribute('aria-label', h.getAttribute('placeholder') || 'Dialog');
          else { if (!h.id) h.id = 'arf-dlg-heading'; dlg.setAttribute('aria-labelledby', h.id); }
        }
        if (!dlg.contains(document.activeElement)) { const f = dlg.querySelector('input,button,select,textarea,[tabindex]'); if (f && f.focus) f.focus(); else if (dlg.focus) dlg.focus(); }
      });
    } else {
      if (shell) shell.removeAttribute('inert');
      if (overlayReturnFocus && overlayReturnFocus.focus) {
        const el = overlayReturnFocus; overlayReturnFocus = null;
        // restore only if focus was orphaned to body/null; if something already grabbed it (e.g. the
        // editor after inserting a citation via edPaste's view.focus()), don't steal it back
        queueMicrotask(() => { try { if (document.activeElement === document.body || !document.activeElement) el.focus(); } catch (e) {} });
      }
    }
  });
  // clipboard: navigator.clipboard.readText() is unreliable in WKWebView/WebKitGTK (context-menu Paste
  // silently did nothing), so route through the Tauri clipboard plugin when native; fall back on web
  async function copyText(t) {
    if (isTauri) { try { const { writeText } = await import('@tauri-apps/plugin-clipboard-manager'); await writeText(t); return; } catch (e) {} }
    try { await navigator.clipboard.writeText(t); } catch (e) {}
  }
  async function readClip() {
    if (isTauri) { try { const { readText } = await import('@tauri-apps/plugin-clipboard-manager'); return await readText(); } catch (e) {} }
    try { return await navigator.clipboard.readText(); } catch (e) { return ''; }
  }

  function buildCtxItems(t) {
    if (!t || !t.closest) return generalMenu();
    // the reader is checked first: its rendered content contains wikilinks/citations/tags, but a
    // selection there must always offer Quote/Highlight — readerMenu folds in the link/cite actions
    if (t.closest('.readerbody')) return readerMenu(t);
    const cite = t.closest('[data-cite]'); if (cite) return [{ label: 'Open reference', run: () => openReference(cite.getAttribute('data-cite')) }];
    const rref = t.closest('[data-ref]'); if (rref) return refMenu(rref.getAttribute('data-ref'));
    const libf = t.closest('[data-libfolder]'); if (libf) return libFolderMenu(libf.getAttribute('data-libfolder'));
    const nav = t.closest('[data-nav]'); if (nav) return linkMenu(nav.getAttribute('data-nav'));
    const nl = t.closest('[data-newlink]'); if (nl) return [{ label: 'Create note “' + nl.getAttribute('data-newlink') + '”', run: () => createNamed(nl.getAttribute('data-newlink')) }];
    const tag = t.closest('[data-tag]'); if (tag) return tagMenu(tag.getAttribute('data-tag'));
    const nid = t.closest('[data-nid]'); if (nid) return noteMenu(nid.getAttribute('data-nid'));
    const fol = t.closest('.frow[data-folder]'); if (fol) return folderMenu(fol.getAttribute('data-folder'));
    if (t.closest('.cm-editor')) return editorMenu();
    const inp = t.closest('textarea, input:not([type=checkbox]):not([type=file]):not([type=radio])'); if (inp) return inputMenu(inp);
    if (t.closest('.read')) return readMenu();
    if (t.closest('.overlay')) return graphMenu();
    if (t.closest('.libview')) return libraryMenu();
    return generalMenu();
  }
  function noteMenu(id) {
    const n = idx.byId[id]; if (!n) return generalMenu();
    return [
      { label: 'Open', run: () => open(id) },
      { label: 'Open & edit', run: () => { open(id); mode = 'write'; } },
      { label: 'Open in reader', run: () => openReaderNote(id) },
      { label: 'Rename', run: () => renameFromCtx(id) },
      { label: 'Duplicate', run: () => dupNote(id) },
      { label: 'Move to…', run: () => { movePick = { kind: 'note', id }; closeCtx(); } },
      { sep: true },
      { label: 'Copy wikilink', run: () => copyWikilink(id) },
      { label: 'Copy as Markdown', run: () => copyMd(id) },
      { label: 'Export…', run: () => { currentId = id; mode = 'read'; view = 'notes'; flushSave(); docExport = true; } },
      { sep: true },
      { label: 'Delete', danger: true, run: () => deleteNote(id) },
    ];
  }
  function linkMenu(id) {
    if (!idx.byId[id]) return [{ label: 'Note not created yet', disabled: true }];
    return [
      { label: 'Open note', run: () => open(id) },
      { label: 'Open & edit', run: () => { open(id); mode = 'write'; } },
      { label: 'Open in reader', run: () => openReaderNote(id) },
      { label: 'Copy wikilink', run: () => copyWikilink(id) },
    ];
  }
  function tagMenu(tag) {
    return [
      { label: tagFilter === tag ? 'Clear filter' : 'Filter by #' + tag, run: () => (tagFilter = tagFilter === tag ? null : tag) },
      { label: 'Copy #' + tag, run: () => copyText('#' + tag) },
    ];
  }
  function refMenu(id) {
    const r = refs.find((x) => x.id === id); if (!r) return generalMenu();
    return [
      { label: 'Copy citation [@' + r.citekey + ']', run: () => copyText('[@' + r.citekey + ']') },
      { label: 'Open reference', run: () => { refJump = { key: r.citekey }; } },
      { sep: true },
      { label: 'Delete reference', danger: true, run: () => deleteRefById(id) },
    ];
  }
  function deleteRefById(id) {
    const r = refs.find((x) => x.id === id); if (!r) return;
    if (!window.confirm('Delete the reference “' + (r.title || r.citekey) + '”?\n\nCitations to it in your notes will show as unknown until you re-add it.')) return;
    refs = refs.filter((x) => x.id !== id);
    queueMicrotask(refsToVault);   // flush references.json now so it can't resurrect on next launch
  }
  function libFolderMenu(path) {
    return [
      { label: 'Show references here', run: () => libraryRef?.ctxSelectFolder(path) },
      { label: 'New subfolder', run: () => libraryRef?.ctxNewSubfolder(path) },
      { label: 'Rename…', run: () => libraryRef?.ctxRenameFolder(path) },
      { label: 'Move to…', run: () => libraryRef?.ctxMoveFolder(path) },
      { sep: true },
      { label: 'Delete folder', danger: true, run: () => libraryRef?.ctxDeleteFolder(path) },
    ];
  }
  function graphMenu() {
    return [
      { label: 'Close graph', run: () => (graphFull = false) },
      { sep: true },
      { label: 'New note', run: () => { graphFull = false; create(); } },
      { label: 'Search…', run: () => { graphFull = false; paletteOpen = true; query = ''; } },
      { label: theme === 'dark' ? 'Light theme' : 'Dark theme', run: toggleTheme },
    ];
  }
  function libraryMenu() {
    return [
      { label: 'Add reference…', run: () => libraryRef?.ctxNewRef() },
      { label: 'New folder', run: () => libraryRef?.ctxNewFolder() },
      { sep: true },
      { label: 'Notes', run: () => (view = 'notes') },
      { label: 'Knowledge graph', run: () => (graphFull = true) },
      { label: theme === 'dark' ? 'Light theme' : 'Dark theme', run: toggleTheme },
      { label: 'Settings', run: () => (settingsOpen = true) },
    ];
  }
  function folderMenu(path) {
    return [
      { label: 'New note here', run: () => { activeFolder = path; create(); } },
      { label: 'New subfolder', run: () => { newFolderParent = path; renameFolderPath = null; newFolderName = ''; collapsed[path] = false; } },
      { label: 'Rename…', run: () => { renameFolderPath = path; newFolderName = path.slice(path.lastIndexOf('/') + 1); } },
      { label: 'Move to…', run: () => { movePick = { kind: 'folder', src: path }; closeCtx(); } },
      { sep: true },
      { label: collapsed[path] ? 'Expand' : 'Collapse', run: () => toggleFolder(path) },
      { sep: true },
      { label: 'Delete folder', danger: true, run: () => deleteFolder(path) },
    ];
  }
  function editorMenu() {
    if (!editorRef) return generalMenu();
    const has = editorRef.edHasSelection();
    // re-guard editorRef inside every run(): the editor can unmount (mode→read) while the menu is open
    return [
      { label: 'Cut', disabled: !has, run: () => { const s = editorRef?.edCut(); if (s) copyText(s); } },
      { label: 'Copy', disabled: !has, run: () => { const s = editorRef?.edCopy(); if (s) copyText(s); } },
      { label: 'Paste', run: async () => { const txt = await readClip(); editorRef?.edPaste(txt); } },
      { label: 'Select all', run: () => editorRef?.edSelectAll() },
      { sep: true },
      { label: 'Bold', disabled: !has, run: () => editorRef?.edFormat('bold') },
      { label: 'Italic', disabled: !has, run: () => editorRef?.edFormat('italic') },
      { label: 'Inline code', disabled: !has, run: () => editorRef?.edFormat('code') },
      { label: 'Link', run: () => editorRef?.edFormat('link') },
      { sep: true },
      { label: 'Insert image…', run: () => editorRef?.edInsertImage() },
    ];
  }
  function inputMenu(el) {
    const has = el.selectionStart !== el.selectionEnd;
    return [
      { label: 'Cut', disabled: !has, run: () => inputCut(el) },
      { label: 'Copy', disabled: !has, run: () => copyText(el.value.slice(el.selectionStart, el.selectionEnd)) },
      { label: 'Paste', run: async () => inputPaste(el, await readClip()) },
      { label: 'Select all', run: () => { el.focus(); el.select(); } },
    ];
  }
  function inputCut(el) {
    const t = el.value.slice(el.selectionStart, el.selectionEnd); if (!t) return;
    copyText(t);
    const s = el.selectionStart; el.value = el.value.slice(0, s) + el.value.slice(el.selectionEnd);
    el.setSelectionRange(s, s); el.dispatchEvent(new Event('input', { bubbles: true })); el.focus();
  }
  function inputPaste(el, txt) {
    if (txt == null) return;
    const s = el.selectionStart, e = el.selectionEnd;
    el.value = el.value.slice(0, s) + txt + el.value.slice(e);
    const p = s + txt.length; el.setSelectionRange(p, p); el.dispatchEvent(new Event('input', { bubbles: true })); el.focus();
  }
  function readMenu() {
    const selText = (typeof window.getSelection === 'function' && String(window.getSelection())) || '';
    const items = [];
    if (selText.trim()) items.push({ label: 'Copy', run: () => copyText(selText) }, { sep: true });
    items.push(
      { label: 'Edit note', run: () => (mode = 'write') },
      { label: 'Copy as Markdown', disabled: !current, run: () => current && copyMd(current.id) },
      { label: 'Export…', disabled: !current, run: () => (docExport = true) },
    );
    return items;
  }
  function generalMenu() {
    if (needVault || vaultMissing) return [{ label: vaultMissing ? 'Locate vault folder…' : 'Choose vault folder…', run: connectFolder }];
    return [
      { label: 'New note', run: create },
      { label: 'New folder', run: () => { newFolderParent = ''; renameFolderPath = null; newFolderName = ''; } },
      { sep: true },
      { label: 'Search…', run: () => { paletteOpen = true; query = ''; } },
      { label: 'Knowledge graph', run: () => (graphFull = true) },
      { label: 'Synthesis', run: () => (digestOpen = true) },
      { sep: true },
      { label: view === 'library' ? 'Notes' : 'Library', run: () => (view = view === 'library' ? 'notes' : 'library') },
      { label: theme === 'dark' ? 'Light theme' : 'Dark theme', run: toggleTheme },
      { label: 'Switch vault…', disabled: !isTauri, run: connectFolder },
      { label: 'Settings', run: () => (settingsOpen = true) },
    ];
  }
  function dupNote(id) {
    const n = idx.byId[id]; if (!n) return;
    const copy = { ...n, id: ulid(), title: (n.title || 'Untitled') + ' (copy)', created: new Date().toISOString(), updated: new Date().toISOString() };
    delete copy._path;  // a duplicate must be written to a new file, not overwrite the original
    notes.unshift(copy); markDirty(copy.id); persist();
    currentId = copy.id; mode = 'write'; view = 'notes';
    closeCtx();
  }
  function copyMd(id) {
    const n = idx.byId[id]; if (!n) return;
    copyText(toMarkdown(n)); closeCtx();
  }
  function copyWikilink(id) {
    const n = idx.byId[id]; if (!n) return;
    copyText('[[' + n.title + ']]'); closeCtx();
  }
  function renameFromCtx(id) {
    const n = idx.byId[id]; if (!n) return;
    currentId = id; view = 'notes'; mode = 'read';
    closeCtx();
    setTimeout(() => { const el = document.querySelector('.title.ro'); if (el) { mode = 'write'; requestAnimationFrame(() => { const inp = document.querySelector('.title:not(.ro)'); if (inp) { inp.focus(); inp.select(); } }); } }, 30);
  }
  async function deleteNote(id) {
    const n = idx.byId[id]; if (!n) return;
    if (!window.confirm('Delete “' + (n.title || 'Untitled') + '”?' + (vaultBackend ? '\n\nThis removes the file from your vault folder.' : ''))) return;
    const note = n;
    notes = notes.filter((x) => x.id !== id);
    if (currentId === id) currentId = notes[0]?.id ?? null;
    dirty.delete(id); clearNoteOrder(id);
    if (reader && reader.kind === 'note' && reader.id === id) reader = null;   // don't leave the reader pointed at a deleted note
    if (vaultBackend) { pendingDelete.add(id); saveTombstones(); }   // tombstone first: an in-flight first-save (no _path yet) must not resurrect the note
    closeCtx();
    writeNow();
    if (vaultBackend && note._path) {
      if (await vaultBackend.removeNote(note)) { pendingDelete.delete(id); saveTombstones(); } // confirmed gone → clear it
      else vaultErr = true;                      // still on disk → stays tombstoned; syncFromFolder retries the removal
    }
  }
  function moveToFolder(id, folder) {
    moveNote(id, folder);
    closeCtx();
  }
  // rename / delete a folder (delete moves its notes and subfolders up to the parent — no note is lost)
  let renameFolderPath = $state(null);
  function commitFolderInput() { if (renameFolderPath != null) commitRename(); else addFolder(); }
  function folderCollision(src, newPath, leaf) {
    if (folders.some((p) => (p === newPath || p.startsWith(newPath + '/')) && !(p === src || p.startsWith(src + '/'))) ||
        notes.some((n) => { const f = canonFolder(n.folder); return (f === newPath || f.startsWith(newPath + '/')) && !(f === src || f.startsWith(src + '/')); })) {
      notify('A folder named “' + leaf + '” already exists there.'); return true;
    }
    return false;
  }
  function commitRename() {
    const raw = (newFolderName || '').trim(); const src = canonFolder(renameFolderPath); newFolderName = null; renameFolderPath = null;
    if (!raw || !src) return;
    const name = canonFolder(raw.replace(/[\/\\]/g, '-')); if (!name) return;
    const parent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
    const newPath = parent ? parent + '/' + name : name;
    if (newPath === src || folderCollision(src, newPath, name)) return;
    const re = (p) => p === src ? newPath : (p.startsWith(src + '/') ? newPath + p.slice(src.length) : p);
    folders = [...new Set(folders.map(re))];
    for (const n of notes) { const f = canonFolder(n.folder); if (f === src || f.startsWith(src + '/')) { n.folder = re(f); n.updated = new Date().toISOString(); markDirty(n.id); } }
    if (collapsed[src] != null) { collapsed[newPath] = collapsed[src]; delete collapsed[src]; }
    if (activeFolder === src || activeFolder.startsWith(src + '/')) activeFolder = re(activeFolder);
    clearFolderOrdersUnder(src);   // old folder paths are gone; the renamed folder sorts fresh
    saveFolders(folders); persist();
  }
  function deleteFolder(path) {
    path = canonFolder(path); if (!path) return;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const reDesc = (p) => { const suf = p.slice(path.length + 1); return parent ? parent + '/' + suf : suf; };
    const reparentedIds = notes.filter((n) => canonFolder(n.folder) === path).map((n) => n.id);   // notes moving up to the parent lose their sibling context
    folders = [...new Set(folders.flatMap((p) => p === path ? [] : (p.startsWith(path + '/') ? [reDesc(p)] : [p])))];
    for (const n of notes) { const f = canonFolder(n.folder); if (f === path) { n.folder = parent; n.updated = new Date().toISOString(); markDirty(n.id); } else if (f.startsWith(path + '/')) { n.folder = reDesc(f); n.updated = new Date().toISOString(); markDirty(n.id); } }
    if (activeFolder === path) activeFolder = parent; else if (activeFolder.startsWith(path + '/')) activeFolder = reDesc(activeFolder);
    if (collapsed[path] != null) delete collapsed[path];
    if (reparentedIds.length) { const no = { ...orders.notes }; let ch = false; for (const id of reparentedIds) if (no[id] != null) { delete no[id]; ch = true; } if (ch) orders = { ...orders, notes: no }; }
    clearFolderOrdersUnder(path);   // and drop the deleted folder's ranks so a same-named folder can't inherit them
    saveFolders(folders); persist(); closeCtx();
  }
  // "Move to…" picker (menu path parallel to drag & drop): { kind, id?/src? }
  let movePick = $state(null);
  function moveDestinations(src) {
    const tops = ['']; // '' = top level
    const all = allFolders.filter((f) => src == null || (f !== src && !f.startsWith(src + '/'))); // a folder can't move into itself/descendant
    return tops.concat(all);
  }
  function doMovePick(dest) {
    const p = movePick; movePick = null; if (!p) return;
    if (p.kind === 'note') moveNote(p.id, dest);
    else if (p.kind === 'folder') moveFolder(p.src, dest);
  }
  // insert-citation picker: filter the reference library, insert [@citekey] at the cursor
  let citePick = $state(false);
  let citeQuery = $state('');
  let citeMode = $state('both');   // 'both' (in-text + list) · 'intext' (in-text only) · 'ref' (reference-list only)
  const citeMatches = $derived.by(() => {
    const all = refs.filter((r) => r && r.citekey);
    const q = citeQuery.trim().toLowerCase();
    if (!q) return all.slice(0, 40);
    return all.filter((r) => (r.citekey || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q)
      || (r.authors || []).some((a) => (a.f || '').toLowerCase().includes(q)) || String(r.year || '').includes(q)).slice(0, 40);
  });
  function openCitePicker() { citeQuery = ''; citePick = true; }
  function insertCite(r) { citePick = false; citeQuery = ''; if (r && editorRef) { const pfx = citeMode === 'intext' ? '!' : citeMode === 'ref' ? '+' : ''; editorRef.edPaste('[@' + pfx + r.citekey + '] '); } }
  function firstLine(b) { const l = (b || '').split('\n').find((x) => x.trim()); return l ? l.replace(/[#>*`\[\]]/g, '').slice(0, 52) : 'Empty note'; }
  function invDot(id) { return hasLinks(id, idx) ? '●' : '○'; }
  function dotTitle(id) { return hasLinks(id, idx) ? 'Linked to other notes' : 'Orphan — not linked to any note yet'; }

  function toggleTheme() { theme = theme === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', theme); try { localStorage.setItem('arf-theme', theme); } catch (e) {} }

  function loadNum(k, d) { try { const v = +localStorage.getItem(k); return v && v > 0 ? v : d; } catch (e) { return d; } }
  function loadBool(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch (e) { return d; } }
  // sidebar width caps are window-relative, not fixed: a panel can grow until the note column would
  // fall below MIN_CENTER — so the reader/PDF pane can take most of the window when you want it to.
  const MIN_CENTER = 300, MIN_LEFT = 170, MIN_RIGHT = 200;
  function maxLeftW(wsW) { return Math.max(MIN_LEFT, wsW - MIN_CENTER - (rightHidden ? 0 : rightW)); }
  function maxRightW(wsW) { return Math.max(MIN_RIGHT, wsW - MIN_CENTER - (leftHidden ? 0 : leftW)); }
  // The *rendered* track widths, clamped to the live workspace so a width saved on a wider window — or
  // grown while the other panel was hidden — can never collapse the note column when the window shrinks
  // or that panel is revealed. Non-destructive: the stored leftW/rightW are untouched, so widening the
  // window restores them. Layout px = viewport / zoom-factor (the resize handlers use the same relation).
  const wsW = $derived((winW || 1280) / ((zoom || 100) / 100));
  const appliedLeftW = $derived(leftHidden ? 0 : Math.max(MIN_LEFT, Math.min(maxLeftW(wsW), leftW)));
  const appliedRightW = $derived(rightHidden ? 0 : Math.max(MIN_RIGHT, Math.min(maxRightW(wsW), rightW)));
  function startResize(which, e) { dragging = which; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); }
  function onResizeMove(e) {
    if (!dragging) return;
    const zf = (zoom || 100) / 100; // getBoundingClientRect/clientX are in zoomed px; store widths in layout px
    const ws = e.currentTarget.parentElement.getBoundingClientRect();
    const wsW = (ws.right - ws.left) / zf;
    if (dragging === 'l') leftW = Math.max(MIN_LEFT, Math.min(maxLeftW(wsW), Math.round((e.clientX - ws.left) / zf)));
    else rightW = Math.max(MIN_RIGHT, Math.min(maxRightW(wsW), Math.round((ws.right - e.clientX) / zf)));
  }
  function endResize() { if (!dragging) return; dragging = null; try { localStorage.setItem('arf-leftw', leftW); localStorage.setItem('arf-rightw', rightW); } catch (e) {} }
  function nudgeResize(which, e) {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0; if (!step) return; e.preventDefault();
    const ws = e.currentTarget.parentElement.getBoundingClientRect();
    const zf = (zoom || 100) / 100, wsW = (ws.right - ws.left) / zf;
    if (which === 'l') leftW = Math.max(MIN_LEFT, Math.min(maxLeftW(wsW), leftW + step)); else rightW = Math.max(MIN_RIGHT, Math.min(maxRightW(wsW), rightW - step));
    try { localStorage.setItem('arf-leftw', leftW); localStorage.setItem('arf-rightw', rightW); } catch (e2) {}
  }
  function toggleLeftPanel() { leftHidden = !leftHidden; try { localStorage.setItem('arf-lefthidden', leftHidden ? '1' : '0'); } catch (e) {} }
  function toggleRightPanel() { rightHidden = !rightHidden; try { localStorage.setItem('arf-righthidden', rightHidden ? '1' : '0'); } catch (e) {} }
  function setZoom(z) { zoom = Math.max(70, Math.min(160, z)); }
  function setTheme(tv) { theme = tv; document.documentElement.setAttribute('data-theme', tv); try { localStorage.setItem('arf-theme', tv); } catch (e) {} }
  $effect(() => { try { document.documentElement.style.zoom = String(zoom / 100); localStorage.setItem('arf-zoom', zoom); } catch (e) {} });
  // Open the styled connect modal (replaces the native window.prompt). Appends to note A on confirm.
  function linkPair(aId, bId, terms) {
    const a = idx.byId[aId], b = idx.byId[bId]; if (!a || !b) return;
    connect = { aId, bId, terms: (terms || []).filter((x) => x.length > 3).slice(0, 5), text: suggestRelation(a, b, terms) };
  }
  // Link the note being viewed to a Resonance suggestion on the right rail.
  function linkResonance(bId) {
    if (!currentId) return;
    linkPair(currentId, bId, sharedTerms(idx.byId[currentId], idx.byId[bId], 5, vectorizer.idf));
  }
  function confirmConnect() {
    if (!connect) return;
    const { aId, bId, text } = connect; connect = null;
    const a = idx.byId[aId], b = idx.byId[bId]; if (!a || !b) return;
    let line = (text || '').trim();
    if (!line) line = 'Related to [[' + b.title + ']].';
    else if (line.toLowerCase().indexOf('[[' + b.title.toLowerCase() + ']]') < 0) line = line.replace(/[\s.]*$/, '') + ' — see [[' + b.title + ']].';
    else if (!/[.!?]$/.test(line)) line += '.';
    a.body = (a.body || '').trimEnd() + '\n\n' + line; a.updated = new Date().toISOString(); markDirty(aId); flushSave();
  }
  // Stable index into a template list, so the same pair always yields the same phrasing.
  function pick(s, n) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return ((h % n) + n) % n; }
  // A natural connecting sentence built from the titles and the shared terms — MiniLM gives
  // the similarity, the shared terms give the *why*. Varied phrasing, chosen stably per pair.
  // Detect the note's own language from its text, so an inserted connecting sentence matches the
  // note (not the UI language). Scored by language-distinctive function words + diacritics; the
  // highest scorer above a floor wins, else 'other' (a neutral, grammar-free connector).
  // [regex, weight] hint sets of language-distinctive function words / diacritics; the highest
  // scorer (≥3, and ahead of the runner-up) wins, else 'other' → the neutral connector.
  const LANG_HINTS = {
    tr: [[/[ğışİı]/g, 2], [/\b(ve|bir|için|ile|değil|çok|daha|gibi|olarak|arasında|üzerine|ancak|kadar)\b/g, 1]],
    de: [[/[äöüß]/g, 2], [/\b(und|der|die|das|ist|nicht|mit|für|auch|eine|zwischen|über|sich|werden|wird|dass|den|dem)\b/g, 1]],
    fr: [[/\b(les|des|une|dans|pour|avec|est|entre|cette|sont|qui|aux|ne|pas|ce|ces|leur)\b/g, 1], [/(qu'|d'|l'|c'est|n')/g, 1]],
    es: [[/[ñ]/g, 2], [/\b(el|los|las|del|que|como|para|con|entre|sobre|porque|pero|más|esta|este|una|por)\b/g, 1]],
    it: [[/\b(il|lo|gli|della|delle|degli|nel|nella|nello|sono|che|perché|anche|questo|questa|più|tra|fra|come|una|per)\b/g, 1], [/\bè\b/g, 1]],
    en: [[/\b(the|and|of|to|in|is|for|with|that|this|are|be|on|as|it|by|an|or|from|which|at|was)\b/g, 1]],
  };
  function noteLang(n) {
    const t = ((n.title || '') + ' ' + (n.body || '')).toLowerCase();
    if (!t.trim()) return 'en';
    let best = 'other', bestS = 0, second = 0;
    for (const [lang, hints] of Object.entries(LANG_HINTS)) {
      let s = 0; for (const [re, w] of hints) s += (t.match(re) || []).length * w;
      if (s > bestS) { second = bestS; bestS = s; best = lang; } else if (s > second) second = s;
    }
    return (bestS >= 3 && bestS > second) ? best : 'other';
  }
  const LANG_AND = { en: ' and ', tr: ' ve ', de: ' und ', fr: ' et ', es: ' y ', it: ' e ' };
  // per-language connecting-sentence templates. cap = capitalize; A = source title, bl = [[target]],
  // list = shared terms joined in-language, lead = first shared term.
  const REL_TPL = {
    en: {
      no: (A, bl) => [A + ' and ' + bl + ' develop the same idea from different sides.', 'A through-line runs from ' + A + ' to ' + bl + '.', A + ' and ' + bl + ' belong to one line of thought.', A + ' sets up a question that ' + bl + ' answers.'],
      yes: (A, bl, list, lead, cap) => [A + ' and ' + bl + ' both turn on ' + list + '.', cap(list) + ' runs through both ' + A + ' and ' + bl + '.', 'Where ' + A + ' works out ' + lead + ', ' + bl + ' carries it further.', A + ' leans on ' + list + ', and ' + bl + ' returns to the same ground.', 'Two takes on ' + list + ': ' + A + ' and ' + bl + '.'],
    },
    tr: {
      no: (A, bl) => [A + ' ve ' + bl + ' aynı fikri farklı yönlerden geliştiriyor.', A + ' ile ' + bl + ' arasında bir düşünce hattı uzanıyor.', A + ' ve ' + bl + ' aynı düşünce çizgisine ait.'],
      yes: (A, bl, list, lead, cap) => [A + ' ve ' + bl + ' ikisi de ' + list + ' üzerine kurulu.', cap(list) + ', hem ' + A + ' hem de ' + bl + ' boyunca işleniyor.', A + ', ' + lead + ' konusunu ele alıyor; ' + bl + ' bunu ileri taşıyor.', list + ' üzerine iki bakış: ' + A + ' ve ' + bl + '.'],
    },
    de: {
      no: (A, bl) => [A + ' und ' + bl + ' entwickeln denselben Gedanken aus verschiedenen Richtungen.', 'Zwischen ' + A + ' und ' + bl + ' verläuft ein gemeinsamer Gedanke.', A + ' und ' + bl + ' gehören zu einem Gedankengang.'],
      yes: (A, bl, list, lead, cap) => [A + ' und ' + bl + ' beruhen beide auf ' + list + '.', cap(list) + ' verbindet ' + A + ' und ' + bl + '.', A + ' behandelt ' + lead + '; ' + bl + ' führt es weiter.'],
    },
    fr: {
      no: (A, bl) => [A + ' et ' + bl + ' développent la même idée sous des angles différents.', 'Un fil conducteur relie ' + A + ' à ' + bl + '.', A + ' et ' + bl + ' relèvent d’une même ligne de pensée.'],
      yes: (A, bl, list, lead, cap) => [A + ' et ' + bl + ' reposent tous deux sur ' + list + '.', cap(list) + ' relie ' + A + ' et ' + bl + '.', A + ' aborde ' + lead + ' ; ' + bl + ' le prolonge.'],
    },
    es: {
      no: (A, bl) => [A + ' y ' + bl + ' desarrollan la misma idea desde ángulos distintos.', 'Un hilo conductor enlaza ' + A + ' con ' + bl + '.', A + ' y ' + bl + ' pertenecen a una misma línea de pensamiento.'],
      yes: (A, bl, list, lead, cap) => [A + ' y ' + bl + ' se basan ambos en ' + list + '.', cap(list) + ' conecta ' + A + ' y ' + bl + '.', A + ' aborda ' + lead + '; ' + bl + ' lo lleva más allá.'],
    },
    it: {
      no: (A, bl) => [A + ' e ' + bl + ' sviluppano la stessa idea da angolazioni diverse.', 'Un filo conduttore collega ' + A + ' a ' + bl + '.', A + ' e ' + bl + ' appartengono a una stessa linea di pensiero.'],
      yes: (A, bl, list, lead, cap) => [A + ' e ' + bl + ' si fondano entrambi su ' + list + '.', cap(list) + ' collega ' + A + ' e ' + bl + '.', A + ' affronta ' + lead + '; ' + bl + ' lo porta oltre.'],
    },
  };
  function suggestRelation(a, b, terms) {
    const bl = '[[' + b.title + ']]';
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const t = (terms || []).filter((x) => x.length > 3).slice(0, 3);
    const lang = noteLang(a);
    const tpl = REL_TPL[lang];
    // a language we don't have prose for → neutral connector: link + shared key terms (in the
    // note's own words), punctuation only, no verbs to conjugate wrong
    if (!tpl) return t.length ? a.title + ' ↔ ' + bl + ' · ' + t.join(', ') : a.title + ' ↔ ' + bl;
    if (!t.length) { const g = tpl.no(a.title, bl); return g[pick(a.id + b.id, g.length)]; }
    const join = LANG_AND[lang];
    const list = t.length === 1 ? t[0] : t.slice(0, -1).join(', ') + join + t[t.length - 1];
    const forms = tpl.yes(a.title, bl, list, t[0], cap);
    return forms[pick(a.id + b.id + list, forms.length)];
  }

  // read-view delegation
  function readClick(e) {
    const task = e.target.closest && e.target.closest('input[data-task]');
    if (task) { e.preventDefault(); const boxes = [...e.currentTarget.querySelectorAll('input[data-task]')]; toggleTaskAt(boxes.indexOf(task)); return; }
    const nav = e.target.closest('[data-nav]'); if (nav) { e.preventDefault(); open(nav.getAttribute('data-nav')); return; }
    const nl = e.target.closest('[data-newlink]'); if (nl) { e.preventDefault(); createNamed(nl.getAttribute('data-newlink')); return; }
    const tg = e.target.closest('[data-tag]'); if (tg) { e.preventDefault(); tagFilter = tg.getAttribute('data-tag'); return; }
    const ck = e.target.closest('[data-cite]'); if (ck) { e.preventDefault(); openReference(ck.getAttribute('data-cite')); return; }
  }
  // toggle the i-th task line in the current note (clicked in the read view). The marker set must
  // match exactly what marked renders as a checkbox — bullets AND ordered items (1. / 1)) — or the
  // DOM checkbox index and this line count diverge and a click toggles the wrong line.
  function toggleTaskAt(i) {
    if (i < 0) return; const n = current; if (!n) return;
    let count = -1;
    const lines = (n.body || '').split('\n').map((line) => {
      const m = line.match(/^(\s*(?:[-*+]|\d+[.)]) +)\[([ xX])\](.*)$/);
      if (!m) return line;
      count++; if (count !== i) return line;
      return m[1] + '[' + (m[2] === ' ' ? 'x' : ' ') + ']' + m[3];
    });
    n.body = lines.join('\n'); n.updated = new Date().toISOString(); markDirty(n.id); persist();
  }
  // a [@citekey] citation opens the Library on that reference's detail
  function openReference(key) {
    refJump = { key };
    view = 'library';
  }

  // --- side reader: read a note / reference while writing, quote + highlight from it ---
  // resolve the descriptor to a live source: a note source re-reads the note's current body so
  // an edit to it reflects in the reader; file/pdf/text sources are passed through as-is.
  const readerSource = $derived.by(() => {
    const r = reader; if (!r) return null;
    if (r.kind === 'note') { const n = notes.find((x) => x.id === r.id); return n ? { kind: 'note', key: 'note:' + n.id, title: n.title, body: n.body } : null; }
    return r;
  });
  // Reader highlights persist to localStorage AND (debounced) to the vault's reader-highlights.json
  // sidecar, keyed by source key (a reference's `ref:<id>` key is stable across devices via
  // references.json), so highlights travel with the vault and can re-sync — like references.json.
  const READER_HL_KEY = 'arf-reader-hl-v0';
  function loadReaderHlMap() { try { const m = JSON.parse(localStorage.getItem(READER_HL_KEY) || '{}'); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; } }
  function loadReaderHls(k) { const m = loadReaderHlMap(); return Array.isArray(m[k]) ? m[k] : []; }
  function saveReaderHls(k, list) {
    try { const m = loadReaderHlMap(); if (list && list.length) m[k] = list; else delete m[k]; localStorage.setItem(READER_HL_KEY, JSON.stringify(m)); } catch (e) {}
    clearTimeout(hlsTimer); hlsTimer = setTimeout(hlsToVault, 500);
  }
  let hlsTimer;
  async function hlsToVault() { if (!vaultBackend || refsLoading || !refsLoaded) return; try { await vaultBackend.writeAux('reader-highlights.json', JSON.stringify(loadReaderHlMap(), null, 2)); } catch (e) {} }
  async function hlsFromVault(b) {
    try {
      const raw = await b.readAux('reader-highlights.json'); if (!raw) return;
      const remote = JSON.parse(raw); if (!remote || typeof remote !== 'object') return;
      const merged = mergeHls(loadReaderHlMap(), remote);
      localStorage.setItem(READER_HL_KEY, JSON.stringify(merged));
      const k = readerSource?.key; if (k) readerHls = Array.isArray(merged[k]) ? merged[k] : [];
    } catch (e) {}
  }
  $effect(() => { const k = readerSource?.key; readerHls = k ? loadReaderHls(k) : []; });
  function openReaderNote(id) { if (idx.byId[id] || notes.some((n) => n.id === id)) { reader = { kind: 'note', id }; view = 'notes'; rightHidden = false; } }
  function closeReader() { reader = null; }
  function addHighlight(text) {
    const k = readerSource?.key, t = (text || '').trim(); if (!k || t.length < 3) return;
    if (!readerHls.includes(t)) { readerHls = [...readerHls, t]; saveReaderHls(k, readerHls); }
  }
  // insert the selected passage as a Markdown blockquote at the cursor in the open note, attributed
  // to its source ([[note]] or [@citekey]). This is the reader → note quote path.
  function quoteIntoNote(text) {
    const t = (text || '').trim(); if (!current || !t) return;
    const src = readerSource;
    let attrib = '';
    if (src && src.kind === 'note' && src.title) attrib = ' — from [[' + src.title + ']]';
    else if (src && src.citekey) attrib = ' — [@' + src.citekey + ']';
    const quote = t.split(/\n+/).map((l) => '> ' + l).join('\n');
    const block = quote + (attrib ? '\n>' + attrib : '');
    if (mode === 'write' && editorRef) editorRef.edPaste('\n' + block + '\n');
    else { const n = current; n.body = (n.body || '').trimEnd() + '\n\n' + block + '\n'; n.updated = new Date().toISOString(); markDirty(n.id); persist(); if (mode !== 'write') mode = 'write'; }
  }
  // open a reference in the reader: its attached file if present (native), else its abstract
  async function openReferenceInReader(ref) {
    if (!ref) return;
    const att = ref.attachment;
    if (att && att.path && vaultBackend) {
      const bytes = await vaultBackend.readBinary(att.path);
      if (bytes) {
        view = 'notes'; rightHidden = false;
        if (att.kind === 'pdf') reader = { kind: 'pdf', key: 'ref:' + ref.id, title: ref.title || att.name, citekey: ref.citekey, bytes };
        else if (att.kind === 'html') reader = { kind: 'html', key: 'ref:' + ref.id, title: ref.title || att.name, citekey: ref.citekey, html: new TextDecoder().decode(bytes) };
        else if (att.kind === 'epub') reader = { kind: 'epub', key: 'ref:' + ref.id, title: ref.title || att.name, citekey: ref.citekey, bytes };
        else reader = { kind: att.kind === 'md' ? 'md' : 'text', key: 'ref:' + ref.id, title: ref.title || att.name, citekey: ref.citekey, body: new TextDecoder().decode(bytes) };
        return;
      }
    }
    if (ref.abstract) { view = 'notes'; rightHidden = false; reader = { kind: 'text', key: 'refabs:' + ref.id, title: ref.title || 'Abstract', citekey: ref.citekey, body: ref.abstract }; return; }
    notify('Nothing to read yet — attach a file to this reference or add an abstract.');
  }
  // --- note images: organized files in the vault (attachments/images/), data-URI on the web ---
  const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
  const isExternalSrc = (s) => /^(data:|https?:|blob:|asset:|tauri:)/i.test(s);
  async function bytesHash(buf) {
    try { const d = await crypto.subtle.digest('SHA-256', buf); return [...new Uint8Array(d)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join(''); }
    catch (e) { let h = 0; for (let i = 0; i < buf.length; i++) h = (h * 31 + buf[i]) | 0; return 'img' + (h >>> 0).toString(16); }
  }
  // store an inserted image as a content-addressed file under the vault; returns its relative path.
  // Null → the editor falls back to an inline data URI (web, or if the write fails).
  async function saveNoteImage(file) {
    if (!vaultBackend) return null;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const ext = ((file.name || '').split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const rel = 'attachments/images/' + (await bytesHash(buf)) + '.' + ext;
      await vaultBackend.saveBinary(rel, buf);
      return rel;
    } catch (e) { return null; }
  }
  // read view: swap a vault-relative image path for a placeholder + a data-vaultimg marker; the
  // effect below resolves each to an inlined data URI (readBinary → base64). This deliberately avoids
  // the Tauri asset protocol, so images render regardless of where the vault folder lives (any drive,
  // network share, macOS/Linux) — the asset-protocol scope only covered $HOME/Documents/Desktop/Downloads.
  const IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const vaultImgCache = new Map();
  function rewriteVaultImages(html) {
    if (!isTauri || !vaultBackend || html.indexOf('<img') < 0) return html;
    return html.replace(/(<img\b[^>]*?)\bsrc="([^"]+)"/gi, (m, pre, src) => {
      if (isExternalSrc(src)) return m;
      return pre + 'data-vaultimg="' + src.replace(/"/g, '&quot;') + '" src="' + IMG_PLACEHOLDER + '"';
    });
  }
  function u8ToBase64(bytes) { let bin = ''; const c = 0x8000; for (let i = 0; i < bytes.length; i += c) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + c)); return btoa(bin); }
  async function vaultImageDataURI(src) {
    try { const b = await vaultBackend.readBinary(src); if (!b) return null; const ext = (src.split('.').pop() || '').toLowerCase(); return 'data:' + (IMG_MIME[ext] || 'application/octet-stream') + ';base64,' + u8ToBase64(b instanceof Uint8Array ? b : new Uint8Array(b)); }
    catch (e) { return null; }
  }
  // export: inline vault-relative images as data URIs so the standalone HTML/PDF/Markdown is self-contained
  async function inlineVaultImages(html) {
    if (!isTauri || !vaultBackend) return html;
    const srcs = new Set(); html.replace(/<img\b[^>]*?\bsrc="([^"]+)"/gi, (m, src) => { if (!isExternalSrc(src)) srcs.add(src); return m; });
    if (!srcs.size) return html;
    const map = {}; for (const s of srcs) { const d = await vaultImageDataURI(s); if (d) map[s] = d; }
    return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (m, a, src, c) => map[src] ? a + map[src] + c : m);
  }
  async function inlineVaultImagesMd(md) {
    if (!isTauri || !vaultBackend) return md;
    const srcs = new Set(); md.replace(/!\[[^\]]*\]\(([^)\s]+)/g, (m, src) => { if (!isExternalSrc(src)) srcs.add(src); return m; });
    if (!srcs.size) return md;
    const map = {}; for (const s of srcs) { const d = await vaultImageDataURI(s); if (d) map[s] = d; }
    return md.replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (m, a, src) => map[src] ? a + map[src] : m);
  }
  // --- reference attachments (PDF / EPUB / reader files) — native fs, vault-only ---
  function attachSlug(ref) { return (ref.citekey || ref.id || 'ref').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ref'; }
  function attKind(ext) { ext = (ext || '').toLowerCase(); return ext === 'pdf' ? 'pdf' : ext === 'epub' ? 'epub' : (ext === 'md' || ext === 'markdown') ? 'md' : (ext === 'html' || ext === 'htm') ? 'html' : 'text'; }
  async function attachLocalFile(ref) {
    if (!ref) return;
    if (!vaultBackend) { notify('Attachments need the desktop app with a vault folder open.'); return; }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, filters: [{ name: 'Reader files', extensions: ['pdf', 'epub', 'txt', 'md', 'markdown', 'html', 'htm'] }] });
    if (!path) return;
    const fs = await import('@tauri-apps/plugin-fs');
    let data;
    // read the picked source file separately from the vault write, so the two failure modes get
    // accurate messages: a picked file outside the granted scope ($HOME/Documents/Desktop/Downloads)
    // can't be read, which is different from the vault not being writable
    try { data = await fs.readFile(path); }
    catch (e) { notify('Couldn’t read that file. Pick one under your Home, Documents, Desktop, or Downloads folder.'); return; }
    try {
      const name = String(path).split(/[\\/]/).pop() || 'file';
      const ext = (name.split('.').pop() || '').toLowerCase();
      const rel = 'attachments/' + attachSlug(ref) + '.' + (ext || 'bin');
      await removeStaleAttachment(ref, rel);   // drop a prior attachment at a different path so it isn't orphaned
      await vaultBackend.saveBinary(rel, data);
      refs = refs.map((r) => r.id === ref.id ? { ...r, attachment: { path: rel, name, kind: attKind(ext) } } : r);
      notify('Attached “' + name + '”.');
    } catch (e) { notify('Couldn’t save the attachment to your vault folder.'); }
  }
  // remove a reference's existing attachment file when the new one lands at a different path
  // (e.g. re-attaching an .epub over a .pdf), so stale binaries don't accumulate in the vault
  async function removeStaleAttachment(ref, newRel) {
    const old = ref.attachment && ref.attachment.path;
    if (old && old !== newRel && vaultBackend) { try { await vaultBackend.removeBinary(old); } catch (e) {} }
  }
  // Open-access PDF fetch. The download runs through Tauri's native HTTP (Rust/reqwest), NOT the
  // webview's browser fetch: publisher OA hosts (PLoS, Nature, MDPI…) serve the PDF with no
  // Access-Control-Allow-Origin, so a browser fetch is CORS-blocked — native reqwest is not.
  // Discovery (openaccess.js) queries Unpaywall, OpenAlex, Semantic Scholar, arXiv and Europe PMC,
  // ordered repository-first, and each candidate is verified as a real PDF (%PDF magic bytes) before
  // it is saved. If every candidate is blocked (e.g. a Cloudflare challenge), the OA page is opened
  // so the user can grab it by hand.
  const OA_UA = 'Arf/' + APP_VERSION + ' (+https://github.com/tunabirgun/arf; mailto:' + OA_CONTACT + ')';
  const PDF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const MAX_PDF_BYTES = 80 * 1024 * 1024;   // reject a runaway body (a streamed HTML page, a huge scan)
  async function openExternal(url) {
    try { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); }
    catch (e) { try { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click(); } catch (e2) {} }
  }
  async function fetchPdfForRef(ref) {
    if (!ref) return;
    if (!isTauri || !vaultBackend) { notify('Open-access fetch needs the desktop app with a vault folder open.'); return; }
    let httpFetch;
    try { ({ fetch: httpFetch } = await import('@tauri-apps/plugin-http')); }
    catch (e) { notify('Couldn’t start the network request.'); return; }
    notify('Looking for an open-access PDF…');
    // metadata indexes: honest polite-pool identity. Origin:'' drops the tauri.localhost Origin header.
    const httpJson = async (url) => {
      const r = await httpFetch(url, { method: 'GET', maxRedirections: 5, connectTimeout: 15000,
        signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'User-Agent': OA_UA, Origin: '' } });
      return r.ok ? await r.json() : null;
    };
    // the PDF GET: browser-like headers so naive UA blocks don't fire; magic-byte check happens upstream
    const httpBytes = async (url) => {
      const r = await httpFetch(url, { method: 'GET', maxRedirections: 10, connectTimeout: 20000,
        signal: AbortSignal.timeout(60000), headers: { Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': PDF_UA, Origin: '' } });
      if (!r.ok) throw new Error('http ' + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) throw new Error('too large');
      return buf;
    };
    try {
      // a reference that already carries a direct reader URL (e.g. a Project Gutenberg EPUB): fetch it directly
      if (ref.readerUrl) {
        const kind = ref.readerKind === 'epub' ? 'epub' : 'pdf';
        try {
          const bytes = await httpBytes(ref.readerUrl);
          if (kind === 'epub' ? looksLikeEpub(bytes) : looksLikePdf(bytes)) {
            const rel = 'attachments/' + attachSlug(ref) + '.' + kind;
            await removeStaleAttachment(ref, rel);
            await vaultBackend.saveBinary(rel, bytes);
            refs = refs.map((x) => x.id === ref.id ? { ...x, attachment: { path: rel, name: attachSlug(ref) + '.' + kind, kind } } : x);
            notify('Attached the open-access ' + (kind === 'epub' ? 'EPUB' : 'PDF') + ' from ' + (ref.sources && ref.sources[0] ? ref.sources[0] : 'open access') + '.');
            return;
          }
        } catch (e) { /* fall through to the DOI-based cascade */ }
      }
      const res = await fetchOaPdf(ref, httpJson, httpBytes, { contact: OA_CONTACT });
      if (res.ok) {
        const rel = 'attachments/' + attachSlug(ref) + '.pdf';
        await removeStaleAttachment(ref, rel);
        await vaultBackend.saveBinary(rel, res.bytes);
        refs = refs.map((x) => x.id === ref.id ? { ...x, attachment: { path: rel, name: attachSlug(ref) + '.pdf', kind: 'pdf' } } : x);
        notify('Attached the open-access PDF' + (res.source ? ' from ' + res.source + '.' : '.'));
      } else if (res.firstUrl) {
        notify('Found an open-access copy but the host blocked the download — opening it so you can save it.');
        openExternal(res.firstUrl);
      } else {
        notify('No open-access PDF found — you can attach one by hand.');
      }
    } catch (e) { notify('Couldn’t fetch an open-access PDF — you can attach one by hand.'); }
  }
  async function detachFromRef(ref) {
    if (!ref || !ref.attachment) return;
    if (vaultBackend && ref.attachment.path) { try { await vaultBackend.removeBinary(ref.attachment.path); } catch (e) {} }
    refs = refs.map((r) => r.id === ref.id ? { ...r, attachment: undefined } : r);
    if (reader && reader.key === 'ref:' + ref.id) closeReader();
    notify('Removed the attachment.');
  }
  function readerMenu(t) {
    const selText = (typeof window.getSelection === 'function' && String(window.getSelection())) || '';
    const items = [];
    if (selText.trim()) items.push(
      { label: 'Quote into note', disabled: !current, run: () => quoteIntoNote(selText) },
      { label: 'Highlight', run: () => addHighlight(selText) },
      { label: 'Copy', run: () => copyText(selText) },
      { sep: true },
    );
    // if the click landed on a rendered link/citation/tag inside the reader, still offer to follow it
    const nav = t && t.closest && t.closest('[data-nav]');
    const cite = t && t.closest && t.closest('[data-cite]');
    const tg = t && t.closest && t.closest('[data-tag]');
    let followed = false;
    if (nav && idx.byId[nav.getAttribute('data-nav')]) { items.push({ label: 'Open linked note', run: () => open(nav.getAttribute('data-nav')) }); followed = true; }
    if (cite) { items.push({ label: 'Open reference', run: () => openReference(cite.getAttribute('data-cite')) }); followed = true; }
    if (tg) { items.push({ label: 'Filter by #' + tg.getAttribute('data-tag'), run: () => { tagFilter = tg.getAttribute('data-tag'); view = 'notes'; } }); followed = true; }
    if (followed) items.push({ sep: true });
    items.push({ label: 'Close reader', run: closeReader });
    return items;
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
    if (!digestOpen) return [];   // the pairwise scan is O(n²); only run it while the Synthesis panel is open
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
    return pairs.map((p) => ({ ...p, terms: sharedTerms(idx.byId[p.a], idx.byId[p.b], 5, vectorizer.idf) }));
  });

  const editable = (t) => !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || (t.closest && t.closest('.cm-editor'))));
  function onKey(e) {
    if (e.defaultPrevented) return; // let the editor/inputs claim a key before the global shortcuts run
    // Escape always closes whatever is open, then stops
    if (e.key === 'Escape') { paletteOpen = false; digestOpen = false; connect = null; graphFull = false; docExport = false; settingsOpen = false; focus = false; movePick = null; citePick = null; closeCtx(); return; }
    // an open overlay owns the keyboard — don't let a global shortcut mutate hidden state behind it
    if (paletteOpen || settingsOpen || digestOpen || connect || graphFull || docExport || movePick || citePick) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey; // ⌘ on macOS, Ctrl elsewhere — leaves Ctrl free for caret shortcuts on Mac
    const inField = editable(e.target); // view/edit chords must not fire while typing a title/body
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen = true; query = ''; }
    else if (mod && e.key.toLowerCase() === 'e') { if (inField) return; e.preventDefault(); if (view === 'notes') mode = mode === 'read' ? 'write' : 'read'; }
    else if (mod && e.key.toLowerCase() === 'g') { if (inField) return; e.preventDefault(); graphFull = !graphFull; }
    else if (mod && e.key.toLowerCase() === 'n') { if (inField) return; e.preventDefault(); if (view === 'library') view = 'notes'; create(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); }
    else if (mod && e.key.toLowerCase() === 'b') { if (inField) return; e.preventDefault(); view = view === 'library' ? 'notes' : 'library'; }
    else if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); flushSave(); syncFromFolder(); }
    else if (mod && e.key === 'Backspace' && current && mode === 'read' && !inField) { e.preventDefault(); deleteNote(currentId); }
  }
</script>

<!-- with the OS drag-drop handler off (tauri dragDropEnabled:false, required for HTML5 DnD on Windows),
     an unhandled file drop would otherwise make the webview navigate to file:// and replace the app.
     These bubble-phase guards neutralise any drop the row/editor handlers didn't already accept. -->
<svelte:window onkeydown={onKey} bind:innerWidth={winW} ondragover={(e) => e.preventDefault()} ondrop={(e) => e.preventDefault()} />

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
        <p class="wsub">A new vault starts with three short notes on linking and Markdown — delete them whenever you like. Everything stays on this machine.</p>
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
    {#if view === 'notes' && !focus}
      <button class="tbtn iconbtn" class:on={!leftHidden} aria-pressed={!leftHidden} title={leftHidden ? 'Show the notes sidebar' : 'Hide the notes sidebar'} aria-label="Toggle notes sidebar" onclick={toggleLeftPanel}>{@html panelIcon('l', !leftHidden)}</button>
    {/if}
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
      {#if view === 'notes' && !focus && winW > 900}
        <button class="tbtn iconbtn" class:on={!rightHidden} aria-pressed={!rightHidden} title={rightHidden ? 'Show the right panel' : 'Hide the right panel'} aria-label="Toggle right panel" onclick={toggleRightPanel}>{@html panelIcon('r', !rightHidden)}</button>
      {/if}
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
  {#if exportError}
    <div class="savebanner">⚠ {exportError}</div>
  {/if}
  {#if uiMsg}
    <div class="savebanner">{uiMsg}</div>
  {/if}

  {#if view === 'library'}
    <Library bind:this={libraryRef} {notes} {idx} onopen={open} bind:refs bind:libFolders jumpTo={refJump} onjumped={() => (refJump = null)} onrefsdelete={() => queueMicrotask(refsToVault)}
      hasVault={!!vaultBackend} onopenreader={openReferenceInReader} onattach={attachLocalFile} onfetchpdf={fetchPdfForRef} ondetach={detachFromRef} />
  {:else}
    <div class="ws" class:lhide={leftHidden} class:rhide={rightHidden} style="--leftw:{appliedLeftW}px; --rightw:{appliedRightW}px">
      <button type="button" class="resizer rz-l" aria-label="Resize left sidebar"
        style="left:{appliedLeftW - 5}px" onpointerdown={(e) => startResize('l', e)} onpointermove={onResizeMove} onpointerup={endResize} onpointercancel={endResize} onkeydown={(e) => nudgeResize('l', e)}></button>
      <button type="button" class="resizer rz-r" aria-label="Resize right sidebar"
        style="right:{appliedRightW - 5}px" onpointerdown={(e) => startResize('r', e)} onpointermove={onResizeMove} onpointerup={endResize} onpointercancel={endResize} onkeydown={(e) => nudgeResize('r', e)}></button>
      <aside class="list" ondragover={(e) => { listAutoScroll(e); if (e.target === e.currentTarget) onDragOver(e, ''); }} ondrop={(e) => { stopAutoScroll(); if (e.target === e.currentTarget) onDrop(e, ''); }} role="group">
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
        <div class="lhrow" class:dropon={dropOn === '__root__'} ondragover={(e) => onDragOver(e, '')} ondragleave={() => { if (dropOn === '__root__') dropOn = null; }} ondrop={(e) => onDrop(e, '')} role="group">
          <span class="lh">{dropOn === '__root__' ? 'Move to top level' : 'Vault · ' + notes.length}</span>
          <button class="mini" title="New folder" onclick={() => { newFolderParent = ''; renameFolderPath = null; newFolderName = ''; }}>+ Folder</button></div>
        {#if newFolderName !== null}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="nfinput" autofocus placeholder={renameFolderPath != null ? 'Rename folder' : (newFolderParent ? 'Subfolder of ' + newFolderParent : 'Folder name')} bind:value={newFolderName}
            onkeydown={(e) => { if (e.key === 'Enter') commitFolderInput(); else if (e.key === 'Escape') { newFolderName = null; renameFolderPath = null; } }} onblur={commitFolderInput} />
        {/if}

        {#if tagFilter}
          <button class="clearfilter" onclick={() => (tagFilter = null)}>← clear #{tagFilter}</button>
          {#each listNotes as n (n.id)}
            <button class="item" class:on={n.id === currentId} data-nid={n.id} draggable="true"
              ondragstart={(e) => onDragStart(e, { type: 'note', id: n.id })} ondragend={onDragEnd} onclick={() => open(n.id)}>
              <span class="dot2" class:orphan={invDot(n.id) === '○'}>{invDot(n.id)}</span>
              <span class="txt"><span class="t">{n.title || 'Untitled'}</span></span>
            </button>
          {/each}
        {:else}
          {#each folderRows as r}
            {#if r.type === 'folder'}
              <button class="frow" class:active={activeFolder === r.path} class:dropon={dropOn === r.path} class:dropbefore={isEdge('folder', r.path, 'before')} class:dropafter={isEdge('folder', r.path, 'after')} class:dragging={dragItem && dragItem.type === 'folder' && dragItem.path === r.path}
                data-folder={r.path} style="padding-left:{6 + r.depth * 12}px" draggable="true"
                ondragstart={(e) => onDragStart(e, { type: 'folder', path: r.path })} ondragend={onDragEnd}
                ondragover={(e) => { if (!folderRowDragOver(e, r.path)) { onDragOver(e, r.path); if (dropEdge && dropEdge.kind === 'folder' && dropEdge.path === r.path) dropEdge = null; } }} ondragleave={() => { if (dropOn === r.path) dropOn = null; if (dropEdge && dropEdge.kind === 'folder' && dropEdge.path === r.path) dropEdge = null; }} ondrop={(e) => onFolderRowDrop(e, r.path)}
                onclick={() => { if (activeFolder === r.path) toggleFolder(r.path); else { activeFolder = r.path; collapsed[r.path] = false; } }}>
                <span class="caret" role="button" tabindex="-1" onclick={(e) => { e.stopPropagation(); toggleFolder(r.path); }}>{r.hasChildren ? (r.collapsed ? '▸' : '▾') : '·'}</span><span class="fn">{r.name}</span>{#if r.count}<span class="fcount">{r.count}</span>{/if}
              </button>
            {:else}
              <button class="item" class:on={r.note.id === currentId} class:dropon={dropOn === '__note__' + r.note.id} class:dropbefore={isEdge('note', r.note.id, 'before')} class:dropafter={isEdge('note', r.note.id, 'after')} class:dragging={dragItem && dragItem.type === 'note' && dragItem.id === r.note.id}
                data-nid={r.note.id} style="padding-left:{6 + r.depth * 12}px" draggable="true"
                ondragstart={(e) => onDragStart(e, { type: 'note', id: r.note.id })} ondragend={onDragEnd}
                ondragover={(e) => { if (!noteRowDragOver(e, r.note)) { if (dragAllowed(canonFolder(r.note.folder))) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (x) {} dropOn = '__note__' + r.note.id; dropEdge = null; } } }}
                ondragleave={() => { if (dropOn === '__note__' + r.note.id) dropOn = null; if (dropEdge && dropEdge.kind === 'note' && dropEdge.id === r.note.id) dropEdge = null; }}
                ondrop={(e) => onNoteRowDrop(e, r.note)}
                onclick={() => open(r.note.id)}>
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
              <button class="tag" class:on={tagFilter === tg} data-tag={tg} onclick={() => (tagFilter = tagFilter === tg ? null : tg)}>#{tg}</button>
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
            <span class="ctags">
              {#each (current.tags || []) as tg}<span class="ctag" data-tag={tg}>#{tg}<button class="ctagx" title="Remove tag" aria-label={'Remove tag ' + tg} onclick={() => removeNoteTag(tg)}>×</button></span>{/each}
              <input class="ctaginput" placeholder="+ tag" bind:value={tagInput}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addNoteTag(tagInput); tagInput = ''; } else if (e.key === 'Backspace' && !tagInput && (current.tags || []).length) removeNoteTag(current.tags[current.tags.length - 1]); }}
                onblur={() => { if (tagInput.trim()) { addNoteTag(tagInput); tagInput = ''; } }} />
            </span>
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
            {#key currentId}<div class="editor"><Editor bind:this={editorRef} value={current.body} onchange={editBody} resemble={resembleParagraph} oncite={openCitePicker} onimage={saveNoteImage} /></div>{/key}
          {:else}
            <div class="read" onclick={readClick}>{@html readHTML}{@html bibHTML}</div>
          {/if}
        {:else}
          <p class="empty">No note selected. Create one with “＋ New”.</p>
        {/if}
      </main>

      {#if reader}
        <aside class="rail readerpane">
          <Reader source={readerSource} highlights={readerHls} canQuote={!!current} onclose={closeReader} onquote={quoteIntoNote} onhighlight={addHighlight} />
        </aside>
      {:else}
      <aside class="rail">
        <div class="rh">Referenced in <span>{backlinks.length}</span></div>
        {#if backlinks.length}
          {#each backlinks as b}<button class="ref" data-nid={b.id} onclick={() => open(b.id)}>{b.title}</button>{/each}
        {:else}<div class="rempty">No backlinks yet.</div>{/if}

        <div class="rh" style="margin-top:1.3rem">Resonance · {mlStatus === 'ready' ? 'MiniLM' : 'on-device'}
          {#if mlStatus === 'off'}<button class="mltoggle" title="Downloads a ~23MB model once; runs entirely on your device" onclick={enableML}>enable AI model</button>
          {:else if mlStatus === 'loading'}<span class="mlstat">↓ model {mlPct}%</span>
          {:else if mlStatus === 'ready'}<span class="mlstat ok">✓ on device</span><button class="mltoggle" title="Turn the on-device model off — Resonance falls back to the light TF-IDF method" onclick={disableML}>disable</button>
          {:else}<span class="mlstat">TF-IDF</span><button class="mltoggle" title="Try loading the on-device model again" onclick={enableML}>retry</button>{/if}
        </div>
        {#if resonance.length}
          {#each resonance as r}
            <div class="mlrow">
              <button class="ref ml" data-nid={r.note.id} onclick={() => open(r.note.id)}><span class="sim" title="Similarity 0–1 (on-device)">{r.s.toFixed(2)}</span><span class="nm">{r.note.title}</span></button>
              <button class="mllink" title={'Link this note to “' + r.note.title + '”'} aria-label={'Link this note to ' + r.note.title} onclick={() => linkResonance(r.note.id)}>+ link</button>
            </div>
          {/each}
        {:else}<div class="rempty">Nothing close enough yet.</div>{/if}

        <div class="rh" style="margin-top:1.3rem">Local graph <button class="expand" onclick={() => (graphFull = true)}>⤢ full</button></div>
        <GraphView {notes} {idx} centerId={currentId} mode="ego" onopen={open} />
      </aside>
      {/if}
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

{#if citePick}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) citePick = false; }}>
    <div class="palette citepicker">
      <!-- svelte-ignore a11y_autofocus -->
      <input autofocus placeholder="Insert citation — filter by author, title, year, or key…" bind:value={citeQuery}
        onkeydown={(e) => { if (e.key === 'Enter' && citeMatches[0]) insertCite(citeMatches[0]); else if (e.key === 'Escape') citePick = false; }} />
      <div class="citemode">
        <button class:on={citeMode === 'both'} onclick={() => (citeMode = 'both')} title="Show the citation in the text and list it at the end of the note">In text + list</button>
        <button class:on={citeMode === 'intext'} onclick={() => (citeMode = 'intext')} title="Show the citation in the text only, without an entry in the reference list">In text only</button>
        <button class:on={citeMode === 'ref'} onclick={() => (citeMode = 'ref')} title="Add the work to the reference list without an in-text marker (like \nocite)">References only</button>
      </div>
      <div class="presults">
        <div class="pg">References</div>
        {#each citeMatches as r (r.id)}
          <button class="prow" onclick={() => insertCite(r)}><span class="pt">{(r.authors && r.authors[0] ? r.authors[0].f : r.citekey)}{r.year ? ' ' + r.year : ''} — {r.title || 'Untitled'}</span><span class="pm">[@{r.citekey}]</span></button>
        {:else}
          <div class="prow none">{refs.length ? 'No matching reference' : 'No references yet — add one in the Library first.'}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if movePick}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) movePick = null; }}>
    <div class="palette">
      <div class="pg" style="padding:.7rem .9rem .3rem">Move {movePick.kind === 'folder' ? 'folder' : 'note'} to…</div>
      <div class="presults">
        {#each moveDestinations(movePick.kind === 'folder' ? movePick.src : null) as dest}
          <button class="prow" onclick={() => doMovePick(dest)}><span class="pt">{dest === '' ? '↑ Top level' : dest}</span></button>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if docExport}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) docExport = false; }}>
    <div class="modal">
      <button class="dlg-x" onclick={() => (docExport = false)}>✕</button>
      <h3>Export writing</h3>
      <p class="msub">Your note as a clean document — headings kept with their text, images fit to the page.</p>
      <div class="fmtpick">
        {#each ['Markdown', 'HTML', 'PDF'] as f}<button class:on={deFmt === f} onclick={() => (deFmt = f)}>{f}</button>{/each}
      </div>
      {#if deFmt === 'Markdown'}
        <p class="msub" style="margin-top:.2rem">Plain Markdown — the same text your vault stores, portable to any editor.</p>
        <div class="optrow"><label for="de-fm">Include YAML frontmatter (id, title, tags, dates)</label><input id="de-fm" type="checkbox" bind:checked={deOpts.frontmatter} /></div>
      {:else if deFmt === 'HTML'}
        <p class="msub" style="margin-top:.2rem">A self-contained web page — fonts and math inlined, opens in any browser.</p>
        <div class="optrow"><label for="de-t">Include title heading</label><input id="de-t" type="checkbox" bind:checked={deOpts.title} /></div>
        <div class="optrow"><label for="de-n">Number section headings</label><input id="de-n" type="checkbox" bind:checked={deOpts.numberHeadings} /></div>
        <div class="optrow"><label for="de-i">Fit images & code to the width (no out-scaling)</label><input id="de-i" type="checkbox" bind:checked={deOpts.fitImages} /></div>
      {:else}
        <p class="msub" style="margin-top:.2rem">A print-ready document via your browser's Save-as-PDF dialog.</p>
        <div class="optrow"><label for="de-page">Page size</label><select id="de-page" class="expsel" bind:value={dePage}>{#each PAGE_SIZES as p}<option>{p}</option>{/each}</select></div>
        <div class="optrow"><label for="de-margin">Margins</label><select id="de-margin" class="expsel" bind:value={deMargin}><option value="Narrow">Narrow</option><option value="Normal">Normal</option><option value="Wide">Wide</option></select></div>
        <div class="optrow"><label for="de-t2">Include title heading</label><input id="de-t2" type="checkbox" bind:checked={deOpts.title} /></div>
        <div class="optrow"><label for="de-n2">Number section headings</label><input id="de-n2" type="checkbox" bind:checked={deOpts.numberHeadings} /></div>
        <div class="optrow"><label for="de-k">Keep headings with their text (no orphans)</label><input id="de-k" type="checkbox" bind:checked={deOpts.keepHeadings} /></div>
        <div class="optrow"><label for="de-i2">Fit images & code to the page (no out-scaling)</label><input id="de-i2" type="checkbox" bind:checked={deOpts.fitImages} /></div>
      {/if}
      <button class="libbtn pri" onclick={doExport}>{'Export as ' + deFmt}</button>
    </div>
  </div>
{/if}

{#if digestOpen}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) digestOpen = false; }}>
    <div class="modal">
      <button class="dlg-x" onclick={() => (digestOpen = false)}>✕</button>
      <h3>This week's synthesis</h3>
      <p class="msub">Notes the machine finds alike but you've never linked — with the concepts they share, so you can see the connection at a glance and link what belongs.</p>
      <div class="dgbody">
        {#each digest as p}
          <div class="pair">
            <span class="txt">
              <span class="pairtitles"><button class="a" onclick={() => open(p.a)}>{idx.byId[p.a].title}</button> <span class="mid">↔</span> <button class="a" onclick={() => open(p.b)}>{idx.byId[p.b].title}</button></span>
              {#if p.terms.length}<span class="shared">shared: {#each p.terms as tm}<span class="shtag">{tm}</span>{/each}</span>{/if}
            </span>
            <span class="psim">{p.s.toFixed(2)}</span><button class="link" onclick={() => linkPair(p.a, p.b, p.terms)}>Link</button>
          </div>
        {:else}<div class="rempty" style="padding:1rem 0">Everything similar is already linked. Good week.</div>{/each}
      </div>
    </div>
  </div>
{/if}

{#if connect}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) connect = null; }}>
    <div class="modal">
      <button class="dlg-x" onclick={() => (connect = null)}>✕</button>
      <h3>Connect notes</h3>
      <p class="msub">A line will be added to <b>{idx.byId[connect.aId]?.title}</b> that links to <b>{idx.byId[connect.bId]?.title}</b>. Edit it to say what the connection is.</p>
      {#if connect.terms.length}<div class="cnterms">shared: {#each connect.terms as tm}<span class="shtag">{tm}</span>{/each}</div>{/if}
      <!-- svelte-ignore a11y_autofocus -->
      <textarea class="cninput" rows="3" autofocus bind:value={connect.text} onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); confirmConnect(); } }}></textarea>
      <div class="cnrow">
        <span class="cnhint">{MOD}+Enter to add</span>
        <button class="cnbtn" onclick={() => (connect = null)}>Cancel</button>
        <button class="cnbtn pri" onclick={confirmConnect}>Add link</button>
      </div>
    </div>
  </div>
{/if}

{#if settingsOpen}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) settingsOpen = false; }}>
    <div class="modal settings">
      <button class="dlg-x" onclick={() => (settingsOpen = false)}>✕</button>
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
        {:else if mlStatus === 'loading'}<span class="setbtnrow"><span class="setstat">downloading {mlPct}%…</span><button class="setbtn" onclick={disableML}>Cancel</button></span>
        {:else if mlStatus === 'ready'}<span class="setbtnrow"><span class="setstat ok">✓ on</span><button class="setbtn" onclick={disableML}>Disable</button></span>
        {:else}<span class="setbtnrow"><span class="setstat">unavailable — using the light method</span><button class="setbtn" onclick={disableML}>Dismiss</button></span>{/if}
      </div>
      <div class="setrow"><span class="sk">Model <span class="sh">English is smaller and faster; Multilingual understands 50+ languages, including Turkish</span></span>
        <div class="seg"><button class:on={mlModel === 'en'} onclick={() => setModel('en')}>English</button><button class:on={mlModel === 'multi'} onclick={() => setModel('multi')}>Multilingual</button></div>
      </div>

      <div class="setlabel">Citations</div>
      <div class="setrow"><span class="sk">Reference list <span class="sh">Append a formatted bibliography of the works a note cites with [@key] — shown at the end of the note and included in exports</span></span>
        <input type="checkbox" bind:checked={bibEnabled} aria-label="Append a reference list to notes" />
      </div>
      {#if bibEnabled}
        <div class="setrow"><span class="sk">Citation style</span>
          <select class="expsel" bind:value={bibStyle}>{#each BIB_STYLES as s}<option>{s}</option>{/each}</select>
        </div>
      {/if}

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
        <span class="setstat"><a href="https://tunabirgun.github.io/arf/" target="_blank" rel="noopener">Docs</a> · <a href="https://github.com/tunabirgun/arf" target="_blank" rel="noopener">Source</a></span>
      </div>
    </div>
  </div>
{/if}

{#if ctxMenu}
  <div class="ctxback" onclick={closeCtx} oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); closeCtx(); }} onkeydown={(e) => { if (e.key === 'Escape') closeCtx(); }} role="button" tabindex="0" aria-label="Close menu"></div>
  <div class="ctxmenu" style="left:{ctxMenu.x}px; top:{ctxMenu.y}px" oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); }} role="menu" tabindex="-1">
    {#each ctxMenu.items as it}
      {#if it.sep}
        <div class="ctxsep"></div>
      {:else}
        <button class="ctxi" class:danger={it.danger} disabled={it.disabled} onclick={() => runCtx(it)}>{it.label}</button>
      {/if}
    {/each}
  </div>
{/if}

