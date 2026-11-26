<script>
  import { seedNotes, saveNotes, newNote, toMarkdown, loadFolders, saveFolders, corruptBackupKey, ulid } from './lib/vault.js';
  import { bootNotes, changedIds } from './lib/cache.js';
  import { toggleTaskAt as toggleTaskBody } from './lib/tasks.js';
  import { buildFolderRows, folderList, canonFolder, planFolderMove, isReservedRoot, mapReservedRoot } from './lib/folders.js';
  import { mergeByUpdated, syncChanged, conflictDecision, reconnectMerge, adoptDiskStamps, fullReadGate } from './lib/sync.js';
  import { buildBundle, readBundle, normalizeNotes, mergeFolders, mergeRefs, mergeHls } from './lib/workspace.js';
  import { buildIndex, buildVectorizer, related, hasLinks, digestPairs, cosine, sharedTerms, TFIDF_FLOOR } from './lib/graphindex.js';
  import { renderMarkdown, setLinkResolver, setCiteResolver, parseImageAlt, withSizeHint, loadMath, mathPending, onMathReady } from './lib/markdown.js';
  import { loadRefs, saveRefs, loadLibFolders, saveLibFolders } from './lib/references.js';
  import { fetchOaPdf, looksLikePdf, looksLikeEpub, OA_CONTACT } from './lib/openaccess.js';
  import { formatRef, BIB_STYLES } from './lib/cite.js';
  import { coerceHl, HL_COLORS, HL_DEFAULT } from './lib/highlight.js';
  import { initEmbedder, embedNotes, cosine as mlCosine, resetEmbedder, download as downloadModel, cancelDownload, downloadedSet, remove as removeModelFiles, embedGeneration, embeddedText } from './lib/ml.js';
  import { confirmAsk } from './lib/confirm.js';
  import { MODELS, RECOMMENDED_ID, findModel, customEntry, migrateModelKey, adaptiveThresholds, repoInfo, validateRepo } from './lib/models.js';
  import { icon } from './lib/icons.js';
  import { importKind, stripTopFolder, rewriteImageLinks, planImport, importSummary, hashedImagePath, composeKeyMaps, rewriteCitekeys, attachmentPaths, localDate } from './lib/importflow.js';
  import { linkContext, previewText } from './lib/linkcontext.js';
  import { connectVault, reconnectVault, lastKnownVaultPath, isTauri } from './lib/vaultadapter.js';
  import GraphView from './lib/GraphView.svelte';   // static: the ego graph renders in the right rail at boot
  import { untrack, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { quintOut, cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { dur, dist, DUR } from './lib/motion.svelte.js';
  import { step as navStep, rove, NAV_KEYS } from './lib/listnav.js';

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
  const MOD = IS_MAC ? '⌘' : 'Ctrl';
  const APP_VERSION = '3.0.0';   // keep in sync with package.json / tauri.conf.json / Cargo.toml

  // Material tier: Linux defaults to the opaque "flat" tier (WebKitGTK backdrop-filter is unreliable
  // before 2.46). A ?material= query param or arf-material localStorage overrides it, so CI can exercise
  // the glass tier on Linux. Set before first paint so glass never flashes on then off.
  const IS_LINUX = /Linux|X11/.test(navigator.userAgent || '') && !/Android/.test(navigator.userAgent || '');
  (() => { try {
    const q = new URLSearchParams(location.search).get('material');
    const mat = q || localStorage.getItem('arf-material') || (IS_LINUX ? 'flat' : '');
    if (mat === 'flat') document.documentElement.setAttribute('data-material', 'flat');
    else document.documentElement.removeAttribute('data-material');
  } catch (e) {} })();

  let notes = $state([]);               // filled from the note cache (cache.js) at boot; cacheReady gates the UI
  let cacheReady = $state(false);
  let refs = $state(loadRefs());        // shared reference library (also used by [@citekey] citations)
  let libFolders = $state(loadLibFolders());   // the Library's folder tree (persisted; travels via library.json)
  let refJump = $state(null);           // { key } → Library selects that reference
  let bibEnabled = $state((() => { try { return localStorage.getItem('arf-bib') === '1'; } catch (e) { return false; } })());   // append a reference list to notes
  let bibStyle = $state((() => { try { return localStorage.getItem('arf-bibstyle') || 'APA'; } catch (e) { return 'APA'; } })());
  let currentId = $state(null);
  let mode = $state('read');            // 'read' | 'write'
  let theme = $state(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  let view = $state('notes');           // 'notes' | 'library'
  let tagFilter = $state(null);
  let vectorizer = buildVectorizer([]);     // { vecs, vectorize } — TF-IDF, refreshed on the debounce
  let vecs = $state(vectorizer.vecs);       // seeded at boot so Resonance is never blank on load
  let mlEnabled = $state((() => { try { return localStorage.getItem('arf-ml') === '1'; } catch (e) { return false; } })());
  // active embedding model (a Hugging Face repo id) or null; old 'en'/'multi' values migrate to their Xenova ids,
  // so an upgraded install keeps its model and its IndexedDB vectors
  let mlModel = $state((() => {
    try {
      const raw = localStorage.getItem('arf-mlmodel'), id = migrateModelKey(raw, localStorage.getItem('arf-ml'));
      if (id && id !== raw) localStorage.setItem('arf-mlmodel', id);
      return id;
    } catch (e) { return null; }
  })());
  // user-added repos: [{ id, pooling, dims, q8Bytes, fileBytes, licence }]
  let customModels = $state((() => { try { const v = JSON.parse(localStorage.getItem('arf-custommodels') || '[]'); return Array.isArray(v) ? v.filter((c) => c && typeof c.id === 'string') : []; } catch (e) { return []; } })());
  const modelList = $derived([...MODELS, ...customModels.map(customEntry)]);
  const activeEntry = $derived(mlModel ? findModel(mlModel, customModels) : null);
  // per-model file state: id -> { state: 'absent' | 'present' | 'downloading' | 'error', pct, error }
  let mlFiles = $state({});
  // repo file sizes learned from the Hugging Face API for entries the registry has no size for (the Arf repos until published)
  let mlSizes = $state((() => { try { return JSON.parse(localStorage.getItem('arf-modelsizes') || '{}') || {}; } catch (e) { return {}; } })());
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
  let reduceTransparency = $state(loadBool('arf-reduce-transparency', false));   // in-app opaque tier (WebKit never fires prefers-reduced-transparency)
  let centerScrolled = $state(false);   // true once the reading column scrolls under the top bar (scroll-edge)
  let centerEl = $state(null);
  // reading-column width preset. clamp(floor, %, ceiling): the % resolves against .center — which
  // already narrows/widens with the side panels — so the column scales both ways, with a readable
  // floor and a line-length ceiling.
  const READ_W = { tight: 'clamp(30em, 66%, 38em)', middle: 'clamp(34em, 80%, 50em)', comfy: 'clamp(40em, 94%, 66em)' };
  let readWidth = $state((() => { try { const v = localStorage.getItem('arf-readwidth'); return READ_W[v] ? v : 'middle'; } catch (e) { return 'middle'; } })());
  function setReadWidth(v) { if (READ_W[v]) readWidth = v; }
  let saved = $state(false);
  let paletteOpen = $state(false);
  let digestOpen = $state(false);
  let connect = $state(null);   // { aId, bId, terms, text } — the styled connect-notes modal
  let graphFull = $state(false);
  let focus = $state(false);
  let fullscreen = $state(false);   // real window/browser fullscreen; reconciled with external F11/Esc
  let topReveal = $state(false);    // in focus mode, the top bar shows only while the pointer is at the top edge
  let fsFocusDriven = false;        // true when Focus turned fullscreen on, so exiting Focus restores it
  let ctxMenu = $state(null);   // { x, y, items } — the context-aware right-click menu
  let ctxSub = $state(null);    // reserved for future submenus
  let editorRef = $state(null); // Editor.svelte instance, for clipboard/format from the ctx menu
  // Editor, Library and Reader load on demand (prefetched at idle after boot) to keep them out of the entry chunk
  let EditorC = $state.raw(null), LibraryC = $state.raw(null), ReaderC = $state.raw(null);
  function lazy(imp, set) { let p = null; return () => p || (p = imp().then((m) => set(m.default), () => { p = null; })); }
  const loadEditor = lazy(() => import('./lib/Editor.svelte'), (c) => (EditorC = c));
  const loadLibrary = lazy(() => import('./lib/Library.svelte'), (c) => (LibraryC = c));
  const loadReader = lazy(() => import('./lib/Reader.svelte'), (c) => (ReaderC = c));
  function whenIdle(fn) { if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 }); else setTimeout(fn, 200); }   // WKWebView/WebKitGTK lack requestIdleCallback
  // KaTeX loads lazily too: a render that met math shows a placeholder until it arrives, then re-renders
  let mathVersion = $state(0);
  onMathReady(() => mathVersion++);
  let libraryRef = $state(null); // Library.svelte instance, so the global menu can drive its folder actions
  let reader = $state(null);    // side-reader descriptor: { kind:'note', id } or a full source object
  let readerHls = $state([]);   // highlight snippets for the current reader source
  let query = $state('');
  let tagInput = $state('');   // the "+ tag" field in the crumbs bar
  let folders = $state(loadFolders());
  // folder collapse state persists per machine (paths only); rename/move/delete already re-key it
  let collapsed = $state((() => { try { const p = JSON.parse(localStorage.getItem('arf-collapsed-v1') || '{}'); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch (e) { return {}; } })());
  $effect(() => { const keep = {}; for (const k in collapsed) if (collapsed[k]) keep[k] = true; try { localStorage.setItem('arf-collapsed-v1', JSON.stringify(keep)); } catch (e) {} });
  // focus an input after the current frame, so a closing context menu's focus restore cannot take it back
  function focusLater(node) { const f = (sel) => { try { if (document.activeElement !== node) node.focus(); if (sel) node.select?.(); } catch (e) {} }; f(true); queueMicrotask(() => f(true)); const r = requestAnimationFrame(() => f(false)); return { destroy() { cancelAnimationFrame(r); } }; }   // the microtask pass selects a prefilled value (bind:value fills it after mount) before any keystroke; the frame pass only re-focuses
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
  let imgCtl = $state(null);   // read-view image control: { index, x, y, w, cap } — set size and caption
  const PAGE_SIZES = ['A4', 'Letter', 'Legal', 'Tabloid', 'A3', 'A5', 'A6', 'B5', 'Executive'];
  const PAGE_CSS = { A4: 'A4', A3: 'A3', A5: 'A5', A6: 'A6', B5: 'B5', Letter: 'letter', Legal: 'legal', Tabloid: 'ledger', Executive: '7.25in 10.5in' };

  // the link/tag/title index. Debounced (not a live $derived) so a keystroke doesn't re-parse the
  // whole vault's text on every press — the `current` note view reads `notes` directly and is unaffected;
  // only backlinks/tags/resonance/palette lag ~180ms, which is imperceptible.
  let idx = $state(buildIndex([]));
  const current = $derived(notes.find((n) => n.id === currentId) ?? null);
  const backlinks = $derived((idx.back[currentId] || []).map((id) => idx.byId[id]).filter(Boolean));
  // the sentence around the [[link]] in each backlinking note (null when it can't be located, e.g. a link
  // the index read differently): computed for the open note only, when its backlinks change
  const backContext = $derived.by(() => {
    const t = current ? current.title : '';
    return new Map(backlinks.map((b) => [b.id, linkContext(b.body, t)]));
  });
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
    mathVersion;                                 // re-render once KaTeX has loaded
    return rewriteVaultImages(current ? renderMarkdown(current.body) : '');
  });
  $effect(() => { readHTML; if (mathPending()) loadMath().catch(() => {}); });
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
  // (Concepts/Methods) if no note actually lives in them, now that a fresh vault seeds none.
  // Runs at boot once the cached notes are loaded.
  function cleanupSeedFolders() {
    try {
      if (localStorage.getItem('arf-seedfolders-cleaned')) return;
      const legacy = ['Concepts', 'Concepts/Decoherence', 'Methods'];
      const used = (p) => notes.some((n) => { const f = canonFolder(n.folder); return f === p || f.startsWith(p + '/'); });
      const next = folders.filter((f) => !(legacy.includes(f) && !used(f)));
      if (next.length !== folders.length) { folders = next; saveFolders(folders); }
      localStorage.setItem('arf-seedfolders-cleaned', '1');
    } catch (e) {}
  }

  // cut-offs for the model in use: its measured values when calibrated, else adaptive quantiles of this
  // vault's random note pairs (models.js adaptiveThresholds); null until there are two vectors to compare
  const mlThresholds = $derived.by(() => {
    if (mlStatus !== 'ready' || !activeEntry) return null;
    // adaptive cut-offs need enough comparable notes (null below models.js's minimum): then Resonance stays on TF-IDF
    return activeEntry.thresholds.calibrated ? activeEntry.thresholds : adaptiveThresholds(mlVecs, { textOf: embeddedText });
  });
  // which method produced the Resonance list: the model once this note has a vector, else TF-IDF word overlap
  const resonanceByModel = $derived(mlStatus === 'ready' && !!activeEntry && !!mlVecs[currentId] && !!mlThresholds);
  const resonance = $derived.by(() => {
    if (!current) return [];
    const excl = new Set([...(idx.fwd[currentId] || []), ...(idx.back[currentId] || [])]);
    if (resonanceByModel) {
      if (!mlThresholds) return [];
      const v = mlVecs[currentId], floor = mlThresholds.resonance;
      return notes.filter((n) => n.id !== currentId && !excl.has(n.id) && mlVecs[n.id])
        .map((n) => ({ note: n, s: mlCosine(v, mlVecs[n.id]) }))
        .filter((x) => x.s >= floor).sort((a, b) => b.s - a.s).slice(0, 5);
    }
    return related(currentId, vecs, notes, { exclude: excl, max: 5, min: TFIDF_FLOOR })
      .map((r) => ({ note: idx.byId[r.id], s: r.s })).filter((x) => x.note);
  });
  // the Resonance list as unlinked pairs: both graphs draw them as dashed suggestion edges. An unchanged
  // list keeps its identity, so a vector refresh that moved nothing doesn't rebuild the graphs.
  let prevSuggest = [];
  const graphSuggest = $derived.by(() => {
    const next = resonance.map((r) => ({ a: currentId, b: r.note.id, s: r.s }));
    const same = next.length === prevSuggest.length && next.every((p, i) => p.a === prevSuggest[i].a && p.b === prevSuggest[i].b && p.s === prevSuggest[i].s);
    return same ? prevSuggest : (prevSuggest = next);
  });

  // debounce vector recompute so typing never triggers a full-vault rescan per keystroke. `rev` counts
  // wholesale replacements (adopt), so an external edit that kept `updated` still rebuilds idx/vectors/ML.
  let rev = $state(0);
  const sig = $derived(rev + '#' + notes.map((n) => n.id + n.updated).join('|'));
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

  // on-device sentence embeddings (opt-in; TF-IDF above serves instantly meanwhile)
  function mlText(n) { return (n.title || '') + '\n' + (n.body || '').replace(/```[\s\S]*?```/g, ' '); }
  let _mlRun = 0;
  // A result is dropped when a newer recompute started (_mlRun) or the model changed meanwhile: setModel, disableML and
  // removeModel bump _mlRun, and ml.js's run generation (bumped by initEmbedder/resetEmbedder) rejects a stale run
  // with StaleRunError, so another model's vectors can never land in mlVecs.
  async function recomputeML() {
    if (mlStatus !== 'ready') return;
    const run = ++_mlRun, gen = embedGeneration();
    const prog = (done, total) => { if (run === _mlRun) mlIndex = done < total ? { done, total } : null; };
    try { const v = await embedNotes(notes, mlText, prog); if (run === _mlRun && gen === embedGeneration() && mlStatus === 'ready') mlVecs = v; } catch (e) {} finally { if (run === _mlRun) mlIndex = null; }
  }
  let mlIndex = $state(null);   // { done, total } while notes are being embedded for the first time (or after edits)
  // the rail header's model label: the repo name without its owner (the full name is in the title)
  const shortModelName = (m) => String((m && (m.name || m.id)) || '').split('/').pop();
  const modelSpec = (m) => ({ model: m.id, pooling: m.pooling, prefix: m.prefix.passage, dtype: 'q8' });
  const setFiles = (id, v) => { mlFiles = { ...mlFiles, [id]: v }; };
  // Transformers.js reports a missing or private repo as an HTTP error on the first file
  const modelError = (msg) => (/\b(401|403|404)\b|unauthori[sz]ed|not found|could not locate/i.test(msg || '') ? 'Not found, or not public yet' : 'Download failed');
  function persistModel() { try { if (mlModel) localStorage.setItem('arf-mlmodel', mlModel); else localStorage.removeItem('arf-mlmodel'); } catch (e) {} }
  function startML() {
    if (mlStatus !== 'off') return;
    const m = activeEntry; if (!m) return;
    mlStatus = 'loading'; mlPct = 0;
    initEmbedder((s) => {
      if (s.status === 'loading') { mlPct = s.pct || mlPct; setFiles(m.id, { state: 'downloading', pct: mlPct }); }
      else if (s.status === 'ready') { mlStatus = 'ready'; setFiles(m.id, { state: 'present' }); recomputeML(); }
      else if (s.status === 'error') { mlStatus = 'error'; setFiles(m.id, { state: 'error', error: modelError(s.error), detail: s.error }); }
    }, modelSpec(m));
  }
  // Turning suggestions on with no model chosen picks a downloaded one, else the recommended model. Like the
  // picker, a model that is not on this device goes through fetchModel first (Hub availability and size check,
  // then the download, shown in the rail); when that repo is unavailable the registry's recommended entry is
  // used instead. mlEnabled turns true only once the files are in, so the (mlEnabled && off) effect can't skip this.
  let mlEnabling = $state(false), mlEnablingId = $state(null);   // the model enableML is fetching (the rail shows its progress)
  async function enableML() {
    if (mlEnabled || mlEnabling) return;
    mlEnabling = true;
    const failed = (x) => { const st = mlFiles[x.id]; if (st?.state === 'error') notify('Couldn’t load ' + x.name + ': ' + (st.error || 'Download failed') + '. Connection suggestions stay off.'); };
    try {
      if (!activeEntry) {
        const have = await downloadedSet(modelList.map((m) => m.id));
        mlModel = (modelList.find((m) => have.has(m.id)) || findModel(RECOMMENDED_ID)).id; persistModel();
      }
      const m = activeEntry; if (!m) return;
      mlEnablingId = m.id;
      if (!(await downloadedSet([m.id])).has(m.id) && !(await fetchModel(m))) {
        const rec = findModel(RECOMMENDED_ID);
        if (mlFiles[m.id]?.state === 'absent') return;                     // cancelled
        if (!rec || rec.id === m.id) { failed(m); return; }                // nothing else to try
        mlEnablingId = rec.id;
        if (!(await downloadedSet([rec.id])).has(rec.id) && !(await fetchModel(rec))) { failed(rec); return; }
        mlModel = rec.id; persistModel();
        notify(m.name + ' is not available; using ' + rec.name + ' instead.');
      }
      mlEnabled = true; try { localStorage.setItem('arf-ml', '1'); } catch (e) {} startML();
    } finally { mlEnabling = false; mlEnablingId = null; }
  }
  // the rail's progress while enableML downloads (before the worker loads) or the worker loads
  const railPct = $derived(mlEnabling ? (mlFiles[mlEnablingId]?.pct || 0) : mlPct);
  // turn the on-device model off again: tear down the worker, drop its vectors, fall back to TF-IDF.
  // mlEnabled must go false before mlStatus so the (mlEnabled && off → startML) effect can't relaunch it.
  function disableML() { _mlRun++; mlEnabled = false; try { localStorage.setItem('arf-ml', '0'); } catch (e) {} resetEmbedder(); mlStatus = 'off'; mlPct = 0; mlVecs = {}; }
  // switch embedding model: reload the worker and re-embed under the new model's cache key
  function setModel(id) {
    if (id === mlModel) return;
    _mlRun++;
    mlModel = id; persistModel();
    if (mlEnabled) { resetEmbedder(); mlStatus = 'off'; mlPct = 0; mlVecs = {}; startML(); }
  }

  // --- model files (Settings, Connection suggestions) ---
  // Download without activating. A repo the registry has no size for is checked against the Hugging Face API
  // first: that records its size and stops early when it is not public yet.
  async function fetchModel(m) {
    const id = m.id;
    setFiles(id, { state: 'downloading', pct: 0 });
    if (m.fileBytes == null && mlSizes[id] == null) {
      const info = await repoInfo(id);
      if (mlFiles[id]?.state !== 'downloading') return false;   // cancelled meanwhile
      if (!info.ok) { setFiles(id, { state: 'error', error: info.error }); return false; }
      mlSizes = { ...mlSizes, [id]: info.fileBytes }; try { localStorage.setItem('arf-modelsizes', JSON.stringify(mlSizes)); } catch (e) {}
    }
    try {
      await downloadModel(modelSpec(m), (p) => setFiles(id, { state: 'downloading', pct: p.pct }));
      setFiles(id, { state: 'present' }); return true;
    } catch (e) {
      setFiles(id, e.message === 'cancelled' ? { state: 'absent' } : { state: 'error', error: modelError(e.message), detail: e.message });
      return false;
    }
  }
  // Use: download first if needed, then make it the active model and turn suggestions on
  async function useModel(m) {
    if (mlFiles[m.id]?.state !== 'present' && !(await fetchModel(m))) return;
    setModel(m.id);
    if (!mlEnabled) enableML();
  }
  // the Download button leaves the row once the files are in; keep keyboard focus in the row (on Use)
  async function fetchFromButton(m, btn) {
    const row = btn.closest('.mrow');
    await fetchModel(m);
    await tick();
    const a = document.activeElement;
    if (row && row.isConnected && (!a || a === document.body || !a.isConnected)) { const u = row.querySelector('[data-act="use"]'); if (u) u.focus(); }
  }
  function cancelModel(m) {
    if (m.id === mlModel && mlStatus === 'loading') disableML();
    cancelDownload(m.id);   // also stops a download that enableML or Use started
    setFiles(m.id, { state: 'absent' });
  }
  async function removeModel(m) {
    if (m.id === mlModel && mlEnabled) return;   // the model in use stays until suggestions are off
    _mlRun++;   // no recompute that started before the removal may land afterwards
    if (!(await confirmAsk('Remove ' + m.name + ' from this device?' + (m.custom ? '\n\nIts downloaded files are deleted and it leaves the model list.' : '\n\nIts downloaded files are deleted; you can download it again later.'), { okLabel: 'Remove' }))) return;
    try { await removeModelFiles(m.id); } catch (e) {}
    setFiles(m.id, { state: 'absent' });
    if (m.custom) {
      customModels = customModels.filter((c) => c.id !== m.id);
      try { localStorage.setItem('arf-custommodels', JSON.stringify(customModels)); } catch (e) {}
      if (m.id === mlModel) { mlModel = null; persistModel(); }
    }
  }
  // which models are on this device: read from Cache Storage only (no network) whenever Settings opens
  async function refreshModelFiles(ids) {
    const have = await downloadedSet(ids), next = { ...mlFiles };
    for (const id of ids) {
      if (next[id]?.state === 'downloading') continue;
      next[id] = have.has(id) ? { state: 'present' } : next[id]?.state === 'error' ? next[id] : { state: 'absent' };
    }
    mlFiles = next;
  }
  $effect(() => { if (settingsOpen) refreshModelFiles(modelList.map((m) => m.id)); });
  function modelStatus(m) {
    const f = mlFiles[m.id], active = m.id === mlModel && mlEnabled;
    if (f?.state === 'downloading') return 'Downloading ' + (f.pct || 0) + '%';
    if (active && mlStatus === 'ready') return 'In use';
    if (active && mlStatus === 'loading') return 'Loading';
    if (f?.state === 'error') return f.error;
    if (f?.state === 'present') return m.id === mlModel ? 'Downloaded, selected' : 'Downloaded';
    return 'Not downloaded';
  }
  function modelSize(m) { const b = m.fileBytes ?? mlSizes[m.id]; return b ? Math.round(b / 1e5) / 10 + ' MB' : 'size shown after first check'; }
  // custom repo: validate against the Hugging Face API, then add with the pooling its 1_Pooling config names
  let customId = $state(''), customCheck = $state(null), customPooling = $state('mean'), customPrefix = $state('');
  async function checkCustom() {
    const id = customId.trim();
    if (!id) return;
    customCheck = { busy: true };
    const r = await validateRepo(id);
    if (customId.trim() !== id) return;   // the field changed while the check ran
    customCheck = r.ok && modelList.some((m) => m.id === r.id) ? { ok: false, error: 'Already in the list' } : r;
    customPooling = r.ok ? r.pooling : 'mean';
  }
  function addCustom() {
    const r = customCheck; if (!r || !r.ok) return;
    // the optional passage prefix (e5 'passage: ', nomic 'search_document: ') is part of the model's cache space
    customModels = [...customModels, { id: r.id, pooling: customPooling, dims: r.dims, q8Bytes: r.q8Bytes, fileBytes: r.fileBytes, licence: r.licence, prefix: customPrefix }];
    try { localStorage.setItem('arf-custommodels', JSON.stringify(customModels)); } catch (e) {}
    customId = ''; customCheck = null; customPrefix = '';
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
  let vaultCorrupt = $state(false); // saved notes couldn't be parsed on load (set at boot)
  let flashTimer, saveTimer;
  // The always-on local note cache (cache.js): IndexedDB, written per changed note, with a synchronous
  // localStorage journal of those notes until the IndexedDB commit lands. noteCache null = the legacy
  // whole-vault localStorage path (IndexedDB unavailable). saveError means an edit is persisted nowhere:
  // a failed cache write only raises it when no vault folder took the edit either.
  let noteCache = null;
  let readFailed = false;          // cached notes may exist but couldn't be read — never seed over them
  const cacheDirty = new Set();    // note ids changed since the last cache write (the vault's `dirty` tracks file flushes)
  let cacheFull = false;           // notes were replaced wholesale: the next cache write replaces the store
  let cacheOrder = [];             // the note order the cache last stored
  let cacheChain = Promise.resolve(true), cacheQueued = false;
  function syncCache() {
    if (!cacheReady) return Promise.resolve(true);
    if (!noteCache) { cacheDirty.clear(); cacheFull = false; return Promise.resolve(saveNotes(notes)); }
    if (cacheDirty.size) { const live = new Map(notes.map((n) => [n.id, n])); noteCache.journal([...cacheDirty].map((id) => [id, live.get(id) || null])); }
    return (cacheChain = cacheChain.then(commitCache, commitCache));   // serialized, so IndexedDB applies writes in call order
  }
  async function commitCache() {
    const full = cacheFull, ids = [...cacheDirty];
    if (!full && !ids.length) return true;
    cacheFull = false; cacheDirty.clear();   // snapshot taken now, so the write carries the newest state
    const order = notes.map((n) => n.id);
    let ok = false;
    try {
      if (full) ok = await noteCache.replaceAll(notes, order);
      else {
        const live = new Map(notes.map((n) => [n.id, n]));
        const reordered = order.length !== cacheOrder.length || order.some((id, i) => id !== cacheOrder[i]);
        ok = await noteCache.write(ids.filter((id) => live.has(id)).map((id) => live.get(id)), ids.filter((id) => !live.has(id)), reordered ? order : null);
      }
    } catch (e) { ok = false; }
    if (ok) cacheOrder = order;
    else { if (full) cacheFull = true; for (const id of ids) cacheDirty.add(id); }   // retried by the next write
    return ok;
  }
  // background cache write (adopted notes, confirmed file flushes): no "saved" flash
  function queueCache() {
    if (cacheQueued) return; cacheQueued = true;
    queueMicrotask(() => { cacheQueued = false; syncCache().then((ok) => { saveError = !ok && (!vaultBackend || vaultErr); }); });
  }
  function flashSaved() { saved = true; clearTimeout(flashTimer); flashTimer = setTimeout(() => (saved = false), 800); }
  function writeNow() {
    if (!cacheReady) return;
    const c = syncCache();
    const v = flushVault();             // and mirror changed notes to real files, if connected
    c.then((ok) => {
      if (ok) { saveError = false; flashSaved(); return; }
      if (!vaultBackend) { saveError = true; return; }
      v.then(() => { saveError = vaultErr; if (!vaultErr) flashSaved(); });   // the folder holds the edit even though the cache missed it
    });
  }
  function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 400); }
  function flushSave() { clearTimeout(saveTimer); writeNow(); }
  function markDirty(id) { if (!id) return; cacheDirty.add(id); if (vaultBackend) dirty.add(id); }
  let flushChain = Promise.resolve();
  function flushVault() { flushChain = flushChain.then(doFlush).catch(() => {}); return flushChain; } // serialize: never two overlapping flushes
  async function doFlush() {
    if (!vaultBackend || !dirty.size) return;
    const ids = [...dirty];
    let failed = false, wrote = false;
    for (const id of ids) {
      const n = notes.find((x) => x.id === id);
      if (!n) { dirty.delete(id); continue; }
      const stamp = n.updated;   // a keystroke during the await bumps this — then keep it dirty so the newest edit is written next tick
      // only drop from the retry queue on a confirmed write of the version we actually saved.
      // _flushed records that version as on disk (F5b: a later absence from disk then means an external delete).
      try { await vaultBackend.saveNote(n); if (n.updated === stamp) dirty.delete(id); n._flushed = stamp; cacheDirty.add(id); wrote = true; } catch (e) { failed = true; }
    }
    vaultErr = failed;
    if (wrote) queueCache();   // persist the new _path/_flushed
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
        for (const n of existing) n._flushed = n.updated;   // read straight from this folder
        const switching = !!vaultBackend;
        if (switching) {
          // the new vault's notes already live on disk — adopt them straight away so the
          // sidebar repaints instantly; do NOT re-save them (that would churn/rename files
          // in the folder we just opened). Clear all old-vault state for a clean slate.
          refsLoading = true; _conflicts.clear(); pendingDelete.clear(); saveTombstones(); deletedAt.clear(); activeFolder = ''; tagFilter = null;
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
            n._flushed = undefined;             // a marker from another folder says nothing about this one
            const stamp = n.updated;
            try { await b.saveNote(n); n._flushed = stamp; } catch (e) { vaultErr = true; dirty.add(n.id); } // a failed write stays dirty and retries on the next sync tick
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
  // replace the note set wholesale (vault load, sync merge, import, seed); the cache store follows
  // the notes it adds or changes are journaled first (changedIds, by content), so a hard quit before the
  // IndexedDB commit can't lose an import or seed; a journal that doesn't fit is skipped quietly
  function adopt(list) {
    if (noteCache) { try { const live = new Map(list.map((n) => [n.id, n])); noteCache.journal(changedIds(notes, list).map((id) => [id, live.get(id)])); } catch (e) {} }
    notes = list; rev++; cacheFull = true; queueCache(); if (!list.some((n) => n.id === currentId)) currentId = list[0]?.id ?? null;
  }
  // the live note object: idx.byId lags ~180 ms behind a create and still holds replaced objects after an adopt
  function noteById(id) { return notes.find((n) => n.id === id) || idx.byId[id] || null; }

  // continuous two-way sync: push local edits out, pull external ones in, honour deletions.
  // Runs on a short interval and whenever the app regains focus, so a folder kept in
  // Dropbox / iCloud / Syncthing / Git stays in step across devices with no user action.
  let _conflicts = new Set(); // remote versions already stashed, so we don't re-copy every tick
  // F5c: a delete made while a tick's loadAll is in flight must not come back from that tick's stale
  // snapshot. Each tick takes an epoch before its read; a delete records the epoch current when it
  // happened and again when its file removal settled. A tick excludes ids recorded at or after its own
  // epoch, and forgets records older than the epoch of a tick that completed.
  let tickEpoch = 0;
  const deletedAt = new Map();   // note id -> epoch
  const fullGate = fullReadGate(); // full re-reads requested (focus regained, Ctrl+R); focus + visibilitychange coalesce into one
  async function syncFromFolder(opts) {
    if (opts && opts.full) fullGate.request();
    if (!vaultBackend || syncing || vaultBusy) return;
    if (document.hidden) return;   // don't re-read the whole vault every 4s while the window is hidden; the focus/visibility listeners pull on regain
    syncing = true;
    const full = fullGate.begin();
    let ok = false;
    try {
      await flushVault();                                   // 1) push local edits to the folder
      const epoch = ++tickEpoch;
      const disk = await vaultBackend.loadAll({ full });    // 2) read the folder's current state (incremental unless asked)
      for (const n of disk) n._flushed = n.updated;
      const diskIds = new Set(disk.map((n) => n.id));
      // tombstones: retry a delete whose file removal never confirmed, and never resurrect a note the user deleted
      const reaped = new Set(); // ids whose file we removed THIS tick — `disk` still lists them, so exclude explicitly or they resurrect
      if (pendingDelete.size) {
        for (const dn of disk) if (pendingDelete.has(dn.id)) { if (await vaultBackend.removeByPath(dn._path)) { pendingDelete.delete(dn.id); reaped.add(dn.id); } } // retry; drop tombstone on confirmed removal
        for (const id of [...pendingDelete]) if (!diskIds.has(id)) { pendingDelete.delete(id); reaped.add(id); } // already gone from disk → tombstone resolved
        saveTombstones();
      }
      const late = (id) => (deletedAt.get(id) ?? -1) >= epoch;   // deleted after this tick's read began
      const live = (pendingDelete.size || reaped.size || deletedAt.size) ? disk.filter((n) => !pendingDelete.has(n.id) && !reaped.has(n.id) && !late(n.id)) : disk;
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
          extra.push({ ...remote, id: cid, title: (remote.title || 'Note') + ' (conflict copy)', _path: undefined, _flushed: undefined });
          dirty.add(cid);
        }
      }
      const incoming = protectedId ? live.filter((n) => n.id !== protectedId) : live;
      const local = adoptDiskStamps(kept, incoming);   // a stamped frontmatter-less file with unchanged content keeps its disk timestamps
      const merged = mergeByUpdated(local, incoming).concat(extra);
      // a kept local note whose exact version is on disk is confirmed flushed (covers notes cached before _flushed existed)
      const diskUpd = new Map(live.map((n) => [n.id, n.updated]));
      for (const n of local) if (n._flushed !== n.updated && !dirty.has(n.id) && diskUpd.get(n.id) === n.updated) { n._flushed = n.updated; cacheDirty.add(n.id); }
      if (syncChanged(notes, merged)) {
        const prevId = currentId;
        adopt(merged);
        if (currentId !== prevId && mode === 'write') mode = 'read';   // never leave the cursor on a note that was swapped out
        folders = [...new Set([...folders, ...merged.map((n) => n.folder).filter(Boolean)])];
      } else if (cacheDirty.size) queueCache();
      for (const [id, e] of deletedAt) if (e < epoch) deletedAt.delete(id);
      lastSync = Date.now();
      ok = true;
    } catch (e) { /* transient (permission prompt, mid-sync file swap) — next tick retries, a full one again if this was */ } finally { fullGate.end(ok); syncing = false; }
  }
  $effect(() => {
    if (!vaultBackend) return;
    const iv = setInterval(() => syncFromFolder(), 4000);   // incremental scan
    const pull = () => { if (!document.hidden) syncFromFolder({ full: true }); };   // focus regained: re-read everything
    window.addEventListener('focus', pull);
    document.addEventListener('visibilitychange', pull);
    return () => { clearInterval(iv); window.removeEventListener('focus', pull); document.removeEventListener('visibilitychange', pull); };
  });

  // --- whole-workspace backup: one portable .arf file (notes + folders + references) ---
  let fileInput = $state();
  let importMsg = $state('');
  async function exportWorkspace() {
    // inline vault-stored note images into the bundle bodies so the .arf file is fully portable
    let outNotes = notes;
    if (isTauri && vaultBackend) { outNotes = []; for (const n of notes) outNotes.push({ ...n, body: await inlineVaultImagesMd(n.body || '') }); }
    const data = buildBundle(outNotes, folders, refs, APP_VERSION, new Date().toISOString(), libFolders, loadReaderHlMap());
    const name = 'arf-workspace-' + localDate() + '.arf';
    reportExport(await saveText(name, 'application/json', JSON.stringify(data, null, 2)), name, outNotes.length + ' note' + (outNotes.length === 1 ? '' : 's'));
  }
  // one status line for an export, like an import's: what was written, or that nothing was
  function reportExport(r, name, what) {
    if (r === 'saved') showImportMsg('✓ Exported ' + what + ' to ' + name + '.');
    else if (r === 'downloaded') showImportMsg('✓ Exported ' + what + ' as ' + name + ' (your browser’s downloads).');
    else if (r === 'cancelled') showImportMsg('Export cancelled; nothing was saved.');
    else if (r === 'failed') showImportMsg('⚠ Couldn’t save ' + name + '.');
  }
  // clear an import's notes from the delete tombstones, so a pending or just-made delete can't remove the
  // file the import is about to write (and drop the note again on the next sync tick)
  function untombstone(ids) {
    let ch = false;
    for (const id of ids) { if (pendingDelete.delete(id)) ch = true; deletedAt.delete(id); }
    if (ch) saveTombstones();
  }
  async function importWorkspace(e) {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (file) await importArfFile(file);
  }
  async function importArfFile(file) {
    if (!cacheReady) return;
    try {
      const data = readBundle(await file.text());
      const localPath = new Map(notes.map((n) => [n.id, n._path]));
      // a root "attachments" folder is the vault's reserved one (never scanned): such notes move to attachments-notes
      const incoming = normalizeNotes(data.notes, localPath, ulid).map((n) => (isReservedRoot(n.folder) ? { ...n, folder: mapReservedRoot(n.folder) } : n));
      adopt(mergeByUpdated(notes, incoming)); // merge so nothing already here is lost
      untombstone(incoming.map((n) => n.id));
      if (vaultBackend) for (const n of incoming) dirty.add(n.id); // write imported notes to the vault now, not next launch
      if (Array.isArray(data.folders)) { folders = mergeFolders(folders, data.folders.map((f) => (typeof f === 'string' ? mapReservedRoot(f) : f))); saveFolders(folders); }
      if (Array.isArray(data.libFolders)) libFolders = mergeFolders(libFolders, data.libFolders);   // library tree from an older/newer bundle merges in; absence is fine
      if (Array.isArray(data.refs)) refs = mergeRefs(refs, data.refs);
      if (data.readerHls && typeof data.readerHls === 'object') {   // merge highlights from the bundle so they survive an import and re-sync
        try { localStorage.setItem(READER_HL_KEY, JSON.stringify(mergeHls(loadReaderHlMap(), data.readerHls))); const k = readerSource?.key; if (k) readerHls = loadReaderHls(k); queueMicrotask(hlsToVault); } catch (e) {}
      }
      importMsg = '✓ Imported ' + incoming.length + (incoming.length === 1 ? ' note.' : ' notes.');
    } catch (err) { importMsg = '⚠ ' + (err.message || 'Could not read that file'); }
    finally { flushSave(); }   // persist adopted notes even if the merge threw; the status stays until the next import or export
  }

  // --- import from Markdown files, folders, zips and reference files; export the vault as a zip ---
  // Sources arrive as File objects (web pickers, drops) or as path-backed stand-ins (Tauri dialogs) with
  // the same name / webkitRelativePath / size / text() / arrayBuffer() surface. importers.js parses
  // (loaded on first use); importflow.js routes, merges and words the result.
  let importBusy = $state(false);
  const MAX_IMPORT_IMAGE = 25 * 1024 * 1024;   // importers.js applies the same cap to images inside a zip
  // the result of the last import or export stays on the status line below the buttons until the next one
  function showImportMsg(m) {
    importMsg = m;
    if (!settingsOpen) notify(m);   // a drop or the Library button: Settings, where importMsg shows, is closed
  }
  // a relative path with no empty, '.' or '..' segment, so a stored image can't land outside attachments/images
  const safeRel = (p) => String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.' && x !== '..').join('/');
  // -> { keyMap: incoming key -> key in the library, added: the refs this merge added }
  function mergeRefsInto(io, list, sum) {
    const m = io.mergeImportedRefs(refs, list);
    if (m.added.length) refs = m.refs;
    sum.refsAdded += m.added.length; sum.refsDuplicates += m.duplicates.length;
    return { keyMap: m.keyMap || {}, added: m.added };
  }
  // Reference files from Arf's own export, restored for the refs this import added. A path that another reference
  // owns, or a file already on disk, is never reused: the file goes to a free name and the added ref points there,
  // so no reference ever opens another work's PDF.
  async function restoreAttachments(files, added, sum) {
    if (!vaultBackend || !files || !files.length || !added.length) return;
    const byPath = new Map(files.map((f) => [f.path, f]));
    for (const r0 of added) {
      const p = r0.attachment && r0.attachment.path, f = p && byPath.get(p);
      if (!f) continue;
      const claimed = (q) => refs.some((x) => x.id !== r0.id && x.attachment && x.attachment.path === q);
      const ext = (/\.([A-Za-z0-9]+)$/.exec(p) || [])[1] || 'bin';
      let target = p;
      try {
        for (let i = 1; claimed(target) || (await vaultBackend.pathExists(target)); i++) target = 'attachments/' + attachSlug(r0) + (i > 1 ? '-' + i : '') + '.' + ext.toLowerCase();
        await vaultBackend.saveBinary(target, f.bytes);
        if (target !== p) refs = refs.map((x) => (x.id === r0.id ? { ...x, attachment: { ...x.attachment, path: target } } : x));
        sum.files++;
      } catch (e) {}
    }
  }
  // merge one importMarkdownFiles/importZip result into the vault; counts go into sum
  async function applyNoteImport(io, res, sum) {
    // references first: a key renamed (or matched to a duplicate) in the library rewrites this import's citations
    let keyMap = res.refKeyMap || {}, addedRefs = [];
    if (res.refs && res.refs.length) { const m = mergeRefsInto(io, res.refs, sum); keyMap = composeKeyMaps(keyMap, m.keyMap); addedRefs = m.added; }
    let incoming = rewriteCitekeys(res.notes, keyMap);
    // images: only those a note of this import links, stored content-addressed like a pasted image (a different
    // image with the same name can never replace another; an identical one is written once)
    const assets = new Map();
    for (const a of res.assets || []) { const p = safeRel(a.path); if (p && !io.ignoredPath(p) && !assets.has(p)) assets.set(p, a); }
    const used = rewriteImageLinks(incoming, [...assets.keys()]).used;
    const stored = new Map();
    let tooLarge = 0;
    if (vaultBackend) for (const p of used) {
      const a = assets.get(p);
      if (!a || a.size > MAX_IMPORT_IMAGE) { if (a) tooLarge++; continue; }
      try {
        const bytes = a.bytes || (a.read ? await a.read() : null);
        if (!bytes) continue;
        if (bytes.length > MAX_IMPORT_IMAGE) { tooLarge++; continue; }   // a desktop pick reports no size until read
        const rel = hashedImagePath(await bytesHash(bytes), p);
        if (!(await vaultBackend.pathExists(rel))) await vaultBackend.saveBinary(rel, bytes);
        stored.set(p, rel);
      } catch (e) {}
    }
    if (stored.size) incoming = rewriteImageLinks(incoming, [...assets.keys()], stored).notes;
    const plan = planImport(notes, incoming);
    if (plan.added.length || plan.merged.length) {
      adopt(plan.notes);
      untombstone([...plan.added, ...plan.merged]);
      if (vaultBackend) for (const id of [...plan.added, ...plan.merged]) dirty.add(id);   // write them to the folder now, not next launch
    }
    if (res.folders && res.folders.length) { folders = mergeFolders(folders, res.folders); saveFolders(folders); }
    await restoreAttachments(res.attachments, addedRefs, sum);   // reference files carried by Arf's own export
    sum.added += plan.added.length; sum.merged += plan.merged.length; sum.unchanged += plan.unchanged.length;
    sum.skipped.push(...res.skipped); sum.images += stored.size; sum.imagesTooLarge += tooLarge;
    sum.imagesSkipped += vaultBackend ? 0 : used.size;
  }
  // folder: the files came from a picked folder (keep its structure, copy its images, report what was skipped)
  async function importFiles(list, { folder = false } = {}) {
    if (!cacheReady || importBusy || !list.length) return;
    importBusy = true;
    const sum = { added: 0, merged: 0, unchanged: 0, skipped: [], refsAdded: 0, refsDuplicates: 0, images: 0, imagesSkipped: 0, imagesTooLarge: 0, files: 0, errors: [] };
    const msgs = [];
    importMsg = '';
    try {
      const io = await import('./lib/importers.js');
      const rel = folder ? stripTopFolder(list.map((f) => f.webkitRelativePath || f.name)) : list.map((f) => f.name);
      const md = [], assets = [], batchKeys = {};
      for (let i = 0; i < list.length; i++) {
        const f = list[i], kind = importKind(f.name);
        try {
          if (kind === 'notes') md.push({ path: rel[i], text: await f.text() });
          else if (kind === 'zip') await applyNoteImport(io, io.importZip(new Uint8Array(await f.arrayBuffer()), { existing: notes, existingRefs: refs }), sum);
          else if (kind === 'refs' && !folder) {
            const r = io.importReferences(await f.text(), f.name, { existingRefs: refs });
            // a key renamed here rewrites the citations of the Markdown files dropped or picked with it
            if (r.refs.length) Object.assign(batchKeys, composeKeyMaps(r.keyMap, mergeRefsInto(io, r.refs, sum).keyMap));
            sum.errors.push(...r.errors.map((m) => f.name + ': ' + m));
          } else if (kind === 'arf' && !folder) { await importArfFile(f); if (importMsg) msgs.push(importMsg); }
          // images are read later, and only those a note links (hidden folders and __MACOSX never)
          else if (kind === 'image' && folder) { if (!io.ignoredPath(safeRel(rel[i]))) assets.push({ path: rel[i], size: f.size || 0, read: async () => new Uint8Array(await f.arrayBuffer()) }); }
          else if (folder) md.push({ path: rel[i], text: null });   // listed as skipped, with its reason
        } catch (e) { sum.errors.push('Couldn’t read ' + f.name + '.'); }
      }
      if (md.length || assets.length) {
        // loose files and drops carry no folder: a note matched by id stays in its folder
        const res = io.importMarkdownFiles(md, { existing: notes, loose: !folder });
        res.assets = assets; res.refKeyMap = batchKeys;
        await applyNoteImport(io, res, sum);
      }
    } catch (e) { sum.errors.push('Import failed: ' + (e && e.message ? e.message : e)); }
    finally { importBusy = false; flushSave(); }
    const summary = importSummary(sum);
    showImportMsg(msgs.length && !sum.errors.length && summary === importSummary({}) ? msgs.join(' ') : [...msgs, summary].join(' '));
  }
  // pick files: a temporary <input type=file> on the web, the native dialog in the desktop app
  const PICK = {
    notes: { accept: '.md,.markdown', multiple: true, label: 'Markdown', ext: ['md', 'markdown'] },
    folder: { folder: true },
    zip: { accept: '.zip', label: 'ZIP archive', ext: ['zip'] },
    refs: { accept: '.bib,.bibtex,.ris,.json', multiple: true, label: 'References', ext: ['bib', 'bibtex', 'ris', 'json'] },
  };
  async function pickImport(kind) {
    const k = PICK[kind];
    let list;
    try { list = isTauri ? await pickNative(k) : await pickWeb(k); }
    catch (e) { showImportMsg('⚠ ' + (e && e.message ? e.message : 'Couldn’t read that selection.')); return; }
    if (list && list.length) await importFiles(list, { folder: !!k.folder });
  }
  function pickWeb(k) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.style.display = 'none';
      if (k.accept) inp.accept = k.accept;
      if (k.multiple) inp.multiple = true;
      if (k.folder) inp.webkitdirectory = true;
      const done = (v) => { inp.remove(); resolve(v); };
      inp.addEventListener('change', () => done([...(inp.files || [])]));
      inp.addEventListener('cancel', () => done([]));
      document.body.appendChild(inp);
      inp.click();
    });
  }
  // a file on disk with the File surface importFiles reads; bytes are read only when asked for. The size is
  // unknown (0) until read: applyNoteImport checks an image's byte length after reading it.
  function diskFile(fs, path, relPath) {
    const name = String(path).split(/[\\/]/).pop();
    return { name, webkitRelativePath: relPath || '', size: 0, text: () => fs.readTextFile(path), arrayBuffer: async () => { const b = await fs.readFile(path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
  }
  const SCOPE_MSG = 'Couldn’t read that folder. Pick one under your Home, Documents, Desktop, or Downloads folder.';
  async function pickNative(k) {
    const [{ open: openDialog }, fs] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
    if (k.folder) {
      const root = await openDialog({ directory: true, multiple: false });
      if (!root) return [];
      const top = String(root).split(/[\\/]/).filter(Boolean).pop() || 'folder', out = [];
      // like the vault loader's walk: hidden entries and symlinks are skipped
      const walk = async (dir, rel) => {
        let entries;
        try { entries = await fs.readDir(dir); } catch (e) { if (!rel) throw new Error(SCOPE_MSG); return; }
        for (const e of entries) {
          if (!e.name || e.name.startsWith('.') || e.isSymlink) continue;
          const p = rel ? rel + '/' + e.name : e.name, abs = dir + '/' + e.name;
          if (e.isDirectory) await walk(abs, p); else out.push(diskFile(fs, abs, top + '/' + p));
        }
      };
      await walk(String(root), '');
      return out;
    }
    const sel = await openDialog({ multiple: !!k.multiple, filters: [{ name: k.label, extensions: k.ext }] });
    if (!sel) return [];
    return (Array.isArray(sel) ? sel : [sel]).map((p) => diskFile(fs, p));
  }
  async function exportVaultZipFile() {
    try {
      const { exportVaultZip } = await import('./lib/exporters.js');
      const now = new Date().toISOString(), date = localDate(), name = 'arf-vault-' + date + '.zip';
      // the vault's images and reference files travel along (desktop with a vault folder; the web build has none)
      const attachments = [];
      if (vaultBackend) for (const p of attachmentPaths(notes, refs)) { const bytes = await vaultBackend.readBinary(p); if (bytes) attachments.push({ path: p, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }); }
      const what = notes.length + ' note' + (notes.length === 1 ? '' : 's') + (attachments.length ? ' and ' + attachments.length + ' attached file' + (attachments.length === 1 ? '' : 's') : '');
      reportExport(await saveBytes(name, 'application/zip', exportVaultZip(notes, folders, refs, { now, date, attachments })), name, what);
    } catch (e) { showImportMsg('⚠ Couldn’t build the ZIP: ' + (e && e.message ? e.message : e)); }
  }
  // HTML5 file drops on the window (the OS drop handler is off, see the guard on <svelte:window>):
  // notes, zips, reference files and .arf bundles import; any other drop is only kept from navigating
  function onWindowDrop(e) {
    e.preventDefault();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (dragItem || !files || !files.length || needVault) return;
    if (e.target && e.target.closest && e.target.closest('.cm-editor')) return;   // the editor takes its own drops (images inline, import files via onimport)
    const list = [...files].filter((f) => { const k = importKind(f.name); return k && k !== 'image'; });
    if (list.length) importFiles(list);
  }
  // boot: load the note cache (IndexedDB, migrating the legacy localStorage value once). Everything
  // that reads the notes at launch — selection, index, vectors, the reconnect below — waits for it, so
  // nothing seeds or writes over a cache that hasn't been read yet.
  bootNotes().catch(() => ({ notes: [], cache: null, readFailed: true })).then((r) => {
    noteCache = r.cache; readFailed = r.readFailed;
    notes = r.notes; rev++;
    cacheOrder = notes.map((n) => n.id);
    currentId = notes[0]?.id ?? null;
    idx = buildIndex(notes); vectorizer = buildVectorizer(notes); vecs = vectorizer.vecs;
    vaultCorrupt = !!corruptBackupKey();
    cleanupSeedFolders();
    cacheReady = true;
    // after first paint, prefetch the lazy pieces so opening the editor/library/reader never waits
    requestAnimationFrame(() => whenIdle(() => { loadEditor(); loadLibrary(); loadReader(); loadMath().catch(() => {}); }));
  });
  // launch: reopen the vault folder this app is bound to. First run (no stored path) or a
  // path that can't be found → the welcome gate. The local cache keeps the last known notes
  // visible instantly either way, and everything merges once a folder is open.
  $effect(() => {
    if (!cacheReady || reconnected) return; reconnected = true;
    (async () => {
      try {
        const b = await reconnectVault();
        if (!b) {
          if (isTauri) { vaultMissing = await lastKnownVaultPath(); needVault = true; }
          // seed the getting-started notes only on a genuine first run (no vault ever chosen),
          // never when the cache was merely wiped over an existing/known vault, or couldn't be read
          if (!vaultMissing && !notes.length && !readFailed) adopt(seedNotes());
          return;
        }
        const ex = await b.loadAll();
        for (const n of ex) n._flushed = n.updated;   // read straight from the folder
        vaultBackend = b;
        setWinTitle(b.name);
        // a note whose local delete never confirmed must not resurrect from its lingering file;
        // keep it tombstoned and let the sync loop reap the file through its tested path
        if (ex.length) {
          // sync.js reconnectMerge: F5b external deletes drop, stamped frontmatter-less files take their
          // disk timestamps, and only notes missing from the folder or newer in the cache are written.
          // An empty listing never drops anything (the else branch below).
          const r = reconnectMerge(notes, ex, pendingDelete);
          adopt(r.notes);
          for (const id of r.dirty) dirty.add(id);
          folders = [...new Set([...folders, ...notes.map((n) => n.folder).filter(Boolean)])];   // merge, never replace — an empty user-made folder must survive relaunch
          flushVault();
        } else { // reconnected to an emptied folder → re-seed it
          let wrote = false;
          for (const n of notes) { const stamp = n.updated; try { await b.saveNote(n); n._flushed = stamp; cacheDirty.add(n.id); wrote = true; } catch (e) {} }
          if (wrote) queueCache();
        }
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
  // Retitling a note rewrites every inbound [[Old Title]] in other notes to [[New Title]], so links
  // (which resolve by title, not id) survive a rename in-app the way a file rename already does.
  // The title input updates live per keystroke, so this runs only on commit (blur), comparing the
  // title captured on focus with the title on blur.
  let titleEditStart = null;
  function rewriteInboundLinks(oldTitle, newTitle) {
    const from = (oldTitle || '').trim().toLowerCase(), to = (newTitle || '').trim();
    if (!from || !to) return 0;
    // a new title with '|' or ']' can't round-trip through the [[Target|Display]] grammar — rewriting would
    // corrupt the link (and any alias). Leave inbound links as they are (they just dangle, recoverable).
    if (/[\]|]/.test(to)) return 0;
    // only the note [[old]] actually resolved to should be rewritten. byTitle resolves a duplicate title to
    // the lowest id; if a lower-id note shares the old title, those links pointed at it, not here — leave them.
    for (const n of notes) { if (n.id < currentId && String(n.title == null ? '' : n.title).trim().toLowerCase() === from) return 0; }
    // match code first so [[...]] inside a fence or inline code is never rewritten (same regions the index ignores)
    const CODE_OR_LINK = /(^|\n)(```|~~~)[\s\S]*?(?:\n\2|$)|`[^`]*`|\[\[([^\]]+?)\]\]/g;
    let changed = 0;
    for (const n of notes) {
      if (!n.body || n.body.indexOf('[[') < 0) continue;
      const next = n.body.replace(CODE_OR_LINK, (m, _p1, _p2, inner) => {
        if (inner === undefined) return m;                           // a code span/fence — leave verbatim
        const bar = inner.indexOf('|');                              // [[Target|Display]] — rewrite Target, keep Display
        const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
        if (target.toLowerCase() !== from) return m;
        return '[[' + to + (bar < 0 ? '' : inner.slice(bar)) + ']]';
      });
      if (next !== n.body) { n.body = next; n.updated = new Date().toISOString(); markDirty(n.id); changed++; }
    }
    return changed;
  }
  function commitTitleRename() {
    const old = titleEditStart; titleEditStart = null;
    if (old == null || !current) return;
    const now = (current.title || '').trim();
    if (!now || !old.trim() || now === old) return;
    if (rewriteInboundLinks(old, now)) persist();
  }
  // edit the note's own tags (the chips above the title) — separate from the #tags typed in the body
  function addNoteTag(v) {
    const t = (v || '').trim().replace(/^#/, '').toLowerCase().replace(/[^\p{L}\p{N}/_-]/gu, '');   // keep Unicode letters (ğ ş ü …)
    const n = current; if (!t || !n) return;
    if (!Array.isArray(n.tags)) n.tags = [];
    if (!n.tags.includes(t)) { n.tags = [...n.tags, t]; n.updated = new Date().toISOString(); markDirty(n.id); persist(); }
  }
  function removeNoteTag(t) { const n = current; if (!n) return; n.tags = (n.tags || []).filter((x) => x !== t); n.updated = new Date().toISOString(); markDirty(n.id); persist(); }
  function create() {
    if (!cacheReady) return;
    tagFilter = null;                                  // a tag filter would hide the new note; clear it so it's visible
    if (activeFolder) collapsed[activeFolder] = false;  // and expand the folder it lands in
    const n = newNote(activeFolder); notes.unshift(n); currentId = n.id; mode = 'write'; view = 'notes'; markDirty(n.id); persist();
  }
  // create a note with a given title — used when a dangling [[wikilink]] is clicked in the read view
  function createNamed(title) {
    if (!cacheReady) return;
    title = (title || '').trim(); if (!title) { create(); return; }
    tagFilter = null;
    const n = newNote(activeFolder); n.title = title;
    notes.unshift(n); currentId = n.id; mode = 'write'; view = 'notes'; markDirty(n.id); persist();
  }
  // the vault root's attachments/ holds images and reference files and is never read as notes
  const RESERVED_MSG = '“attachments” is reserved at the top level for images and reference files. Choose another name.';
  function addFolder() {
    const raw = (newFolderName || '').trim(); newFolderName = null;
    if (!raw) return;
    const name = canonFolder(raw.replace(/[\/\\]/g, '-'));   // one segment; canonFolder strips trailing dot/space + reserved names so it matches disk
    if (!name) return;
    const parent = canonFolder(newFolderParent);
    const path = parent ? parent + '/' + name : name;
    if (isReservedRoot(path)) { notify(RESERVED_MSG); return; }
    if (!folders.includes(path)) folders = [...folders, path];
    saveFolders(folders); if (parent) collapsed[parent] = false;
  }
  function toggleFolder(path) { collapsed[path] = !collapsed[path]; }
  // ArrowRight expands a folder row, ArrowLeft collapses it (the caret itself is pointer-only and aria-hidden)
  function folderKey(e, r) {
    if (!r.hasChildren || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    e.preventDefault();
    collapsed[r.path] = e.key === 'ArrowLeft';
  }
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
    if (!plan.ok) { if (plan.reason === 'collision') notify('A folder named “' + plan.leaf + '” already exists there.'); else if (plan.reason === 'reserved') notify(RESERVED_MSG); return; }
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
      + scope + 'figure.fig{margin:1.3em auto;text-align:center;break-inside:avoid;page-break-inside:avoid}' + scope + 'figure.fig img{margin:0 auto}'
      + scope + 'figcaption{margin-top:.5em;font-size:10.5pt;color:#555;line-height:1.4}' + scope + 'figcaption .fign{color:#111;font-weight:600}'
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
  // KaTeX and its stylesheet load lazily; exports wait for both so no math is left as a placeholder
  let katexCss = '';
  async function exportAssets() {
    await loadMath();
    if (!katexCss) katexCss = (await import('katex/dist/katex.min.css?inline')).default;   // inlined into exports so math positions correctly outside the app
  }
  function exportHTML(n) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(n.title || 'Untitled') + '</title><style>' + katexCss + '</style><style>' + buildExportCSS('') + '</style></head><body>' + exportBody(n) + '</body></html>';
  }
  async function saveText(name, mime, text) {
    if (isTauri) { // desktop: browser download APIs don't work in the webview — use the native save dialog
      try {
        const [{ save }, { writeTextFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
        const path = await save({ defaultPath: name });
        if (!path) return 'cancelled';
        await writeTextFile(path, text); return 'saved';
      } catch (e) { exportError = 'Couldn’t save the file — the save was cancelled or the folder isn’t writable.'; clearTimeout(exportErrTimer); exportErrTimer = setTimeout(() => (exportError = ''), 4000); return 'failed'; }
    }
    const url = URL.createObjectURL(new Blob([text], { type: mime })); // web: Blob is robust for any size
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return 'downloaded';
  }
  // binary counterpart of saveText: data is a Blob or a Uint8Array
  async function saveBytes(name, mime, data) {
    if (isTauri) {
      try {
        const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
        const ext = name.slice(name.lastIndexOf('.') + 1);
        const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
        if (!path) return 'cancelled';
        await writeFile(path, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data); return 'saved';
      } catch (e) { exportError = 'Couldn’t save the file — the save was cancelled or the folder isn’t writable.'; clearTimeout(exportErrTimer); exportErrTimer = setTimeout(() => (exportError = ''), 4000); return 'failed'; }
    }
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return 'downloaded';
  }
  // the full graph's PNG/SVG export: the webview can't download, so route it through the save dialog
  function saveGraphExport({ name, blob }) { return saveBytes(name, blob.type, blob); }
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
    if (deFmt !== 'Markdown') {
      try { await exportAssets(); }
      catch (e) { exportError = 'Couldn’t load the math renderer for the export — try again.'; clearTimeout(exportErrTimer); exportErrTimer = setTimeout(() => (exportError = ''), 4000); return; }
    }
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
    // keyboard-opened (Shift+F10 / Menu key): the event point can lie outside the focused target, so anchor below it
    const tr = e.target && e.target.getBoundingClientRect ? e.target.getBoundingClientRect() : null;
    const kb = tr && e.target === document.activeElement && !(e.clientX >= tr.left && e.clientX <= tr.right && e.clientY >= tr.top && e.clientY <= tr.bottom);
    let x = (kb ? tr.left + 8 : e.clientX) / zf, y = (kb ? tr.bottom : e.clientY) / zf;
    if (x + mw > W) x = Math.max(4, W - mw - 4);
    if (y + mh > H) y = Math.max(4, H - mh - 4);
    if (!ctxMenu) ctxOpener = document.activeElement;
    ctxMenu = { x: Math.round(x), y: Math.round(y), items };
    ctxSub = null;
    // focus the first enabled item, so arrows, Enter and Escape work at once
    queueMicrotask(() => { const f = document.querySelector('.ctxmenu .ctxi:not(:disabled)'); if (f) f.focus({ preventScroll: true }); });
  }
  let ctxOpener = null;   // focus returns here when the menu closes
  function closeCtx() {
    if (!ctxMenu) return;
    ctxMenu = null; ctxSub = null;
    const el = ctxOpener; ctxOpener = null;
    const a = document.activeElement;
    if (el && el.isConnected && el.focus && (!a || a === document.body || a.closest('.ctxmenu'))) { try { el.focus({ preventScroll: true }); } catch (e) {} }
  }
  function ctxKey(e) {
    if (rove(e.currentTarget, e, '.ctxi')) { e.preventDefault(); return; }
    if (e.key === 'Tab') { e.preventDefault(); closeCtx(); }   // a menu is not a tab stop; Tab dismisses it
  }
  function runCtx(it) { if (it.disabled) return; const r = it.run; closeCtx(); if (r) r(); }
  $effect(() => { window.addEventListener('contextmenu', onContextMenu); return () => window.removeEventListener('contextmenu', onContextMenu); });
  // modal a11y: while an overlay is open, make the background inert (Tab/screen-reader can't wander
  // behind it), mark the dialog with role/aria-modal, move focus in, and restore focus to the opener on close
  let overlayReturnFocus = null;
  let libOverlay = $state(false);   // the Library's own export modal or move picker is open (bound from Library)
  // an overlay on its way out (exit fade) goes inert at once, so it can't take focus, clicks or the dialog role
  const leaving = (e) => { e.currentTarget.setAttribute('inert', ''); e.currentTarget.setAttribute('data-leaving', ''); };
  $effect(() => {
    // read each overlay flag individually so the effect re-fires on ANY change — including a same-tick
    // overlay→overlay swap (e.g. graph → Search), which a single boolean would miss.
    // citePick is intentionally excluded: it's an inline tool that inserts into (and refocuses) the
    // editor, so making the editor inert would break edPaste's view.focus() and strand the caret.
    const open = paletteOpen || settingsOpen || digestOpen || !!connect || docExport || !!movePick || graphFull || libOverlay;
    const shell = document.querySelector('.shell');
    if (open) {
      if (!overlayReturnFocus) overlayReturnFocus = document.activeElement;
      queueMicrotask(() => {
        // skip the cite picker (excluded from inert) so a real modal opened over it still gets the dialog aria
        const dlg = [...document.querySelectorAll('.palette:not(.citepicker), .modal, .overlay')].find((el) => !el.closest('[inert]'));
        // inert every part of the shell that doesn't hold the dialog: App's overlays sit outside .shell (so all of it),
        // the Library's export modal and move picker sit inside it (so everything but their scrim)
        if (shell) for (const c of shell.children) c.toggleAttribute('inert', c.hasAttribute('data-leaving') || !(dlg && c.contains(dlg)));
        if (!dlg) return;
        dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
        const h = dlg.querySelector('h3, h1, input');
        if (h && !dlg.hasAttribute('aria-label') && !dlg.hasAttribute('aria-labelledby')) {
          if (h.tagName === 'INPUT') dlg.setAttribute('aria-label', h.getAttribute('placeholder') || 'Dialog');
          else { if (!h.id) h.id = 'arf-dlg-heading'; dlg.setAttribute('aria-labelledby', h.id); }
        }
        if (!dlg.contains(document.activeElement)) { const f = dlg.querySelector('input,button,select,textarea,[tabindex]'); if (f && f.focus) f.focus(); else if (dlg.focus) dlg.focus(); }
      });
    } else {
      if (shell) for (const c of shell.children) if (!c.hasAttribute('data-leaving')) c.removeAttribute('inert');
      if (overlayReturnFocus && overlayReturnFocus.focus) {
        const el = overlayReturnFocus; overlayReturnFocus = null;
        // restore only if focus was orphaned (body/null, or still inside an overlay that is fading out); if
        // something already grabbed it (e.g. the editor after edPaste's view.focus()), don't steal it back
        queueMicrotask(() => { try { const a = document.activeElement; if (!a || a === document.body || a.closest('[inert], .scrim, .overlay')) el.focus(); } catch (e) {} });
      }
    }
  });
  // focus wrap inside the open dialog: Tab from its last focusable goes to its first (Shift+Tab the reverse),
  // instead of leaving for <body> or the browser chrome on the way round (the shell behind is inert)
  const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]';
  $effect(() => {
    const open = paletteOpen || settingsOpen || digestOpen || !!connect || docExport || !!movePick || graphFull || libOverlay;
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const dlg = [...document.querySelectorAll('.palette:not(.citepicker), .modal, .overlay')].find((el) => !el.closest('[inert]'));
      if (!dlg) return;
      const list = [...dlg.querySelectorAll(TABBABLE)].filter((el) => el.tabIndex >= 0 && !el.disabled && !el.closest('[inert]') && el.getClientRects().length > 0);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1], a = document.activeElement;
      if (!dlg.contains(a)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
    // fall back to live notes when the index hasn't rebuilt yet (180ms debounce after a change/boot),
    // so a right-click during that window still shows the note menu, not the general one
    const n = idx.byId[id] || notes.find((x) => x.id === id); if (!n) return generalMenu();
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
  async function deleteRefById(id) {
    const r = refs.find((x) => x.id === id); if (!r) return;
    if (!(await confirmAsk('Delete the reference “' + (r.title || r.citekey) + '”?\n\nCitations to it in your notes will show as unknown until you re-add it.'))) return;
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
    const n = noteById(id); if (!n) return;
    const copy = { ...n, id: ulid(), title: (n.title || 'Untitled') + ' (copy)', created: new Date().toISOString(), updated: new Date().toISOString() };
    delete copy._path;  // a duplicate must be written to a new file, not overwrite the original
    delete copy._flushed;   // and has never been written
    notes.unshift(copy); markDirty(copy.id); persist();
    currentId = copy.id; mode = 'write'; view = 'notes';
    closeCtx();
  }
  function copyMd(id) {
    const n = noteById(id); if (!n) return;
    copyText(toMarkdown(n)); closeCtx();
  }
  function copyWikilink(id) {
    const n = noteById(id); if (!n) return;
    copyText('[[' + n.title + ']]'); closeCtx();
  }
  function renameFromCtx(id) {
    const n = noteById(id); if (!n) return;
    currentId = id; view = 'notes'; mode = 'read';
    closeCtx();
    setTimeout(() => { const el = document.querySelector('.title.ro'); if (el) { mode = 'write'; requestAnimationFrame(() => { const inp = document.querySelector('.title:not(.ro)'); if (inp) { inp.focus(); inp.select(); } }); } }, 30);
  }
  async function deleteNote(id) {
    const n = noteById(id); if (!n) return;
    if (!(await confirmAsk('Delete “' + (n.title || 'Untitled') + '”?' + (vaultBackend ? '\n\nThis removes the file from your vault folder.' : '')))) return;
    const note = n;
    notes = notes.filter((x) => x.id !== id);
    if (currentId === id) currentId = notes[0]?.id ?? null;
    dirty.delete(id); cacheDirty.add(id); clearNoteOrder(id);
    if (reader && reader.kind === 'note' && reader.id === id) reader = null;   // don't leave the reader pointed at a deleted note
    if (vaultBackend) { pendingDelete.add(id); saveTombstones(); deletedAt.set(id, tickEpoch); }   // tombstone first: an in-flight first-save (no _path yet) must not resurrect the note
    closeCtx();
    writeNow();
    if (vaultBackend && note._path) {
      const b = vaultBackend;
      if (await b.removeNote(note)) { pendingDelete.delete(id); saveTombstones(); } // confirmed gone → clear it
      else vaultErr = true;                      // still on disk → stays tombstoned; syncFromFolder retries the removal
      if (b === vaultBackend) deletedAt.set(id, tickEpoch);   // a tick that read before this point may still list the file
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
    if (newPath !== src && isReservedRoot(newPath)) { notify(RESERVED_MSG); return; }
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

  // one-time property-whitelisted cross-fade on theme change: color/border/fill/stroke ease over --dur-base,
  // while --ser-wght (400<->440) snaps with the text color so the variable font never shimmers
  let themeFadeTimer = null;
  function applyTheme(tv) {
    const de = document.documentElement;
    if (dur(1) > 0) { de.classList.add('theming'); clearTimeout(themeFadeTimer); themeFadeTimer = setTimeout(() => de.classList.remove('theming'), DUR.base + 60); }
    theme = tv; de.setAttribute('data-theme', tv); try { localStorage.setItem('arf-theme', tv); } catch (e) {}
  }
  function toggleTheme() { applyTheme(theme === 'dark' ? 'light' : 'dark'); }

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

  // --- fullscreen (native window in Tauri, Fullscreen API on the web) + focus mode ---
  async function applyFullscreen(v) {
    try {
      if (isTauri) { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().setFullscreen(v); }
      else if (v) { await document.documentElement.requestFullscreen?.(); }
      else if (document.fullscreenElement) { await document.exitFullscreen?.(); }
    } catch (e) {}
  }
  // an explicit user fullscreen toggle detaches the Focus coupling, so leaving Focus never force-exits a
  // fullscreen the user turned on (or off) by hand afterwards
  function toggleFullscreen() { fsFocusDriven = false; fullscreen = !fullscreen; applyFullscreen(fullscreen); }
  // Focus mode strips the app to the read/write column and the open reader; it also enters fullscreen,
  // but the two stay independently reversible — leaving Focus only exits fullscreen if Focus turned it on.
  function setFocus(v) {
    focus = v; topReveal = false;
    if (v) { if (!fullscreen) { fsFocusDriven = true; fullscreen = true; applyFullscreen(true); } }
    else if (fsFocusDriven) { fsFocusDriven = false; if (fullscreen) { fullscreen = false; applyFullscreen(false); } }
  }
  function toggleFocus() { setFocus(!focus); }
  // reveal the top bar while the pointer is at the very top edge; hysteresis so it doesn't flicker while
  // the cursor is over the (revealed) bar itself
  function onFocusMouseMove(e) { if (focus) topReveal = e.clientY <= (topReveal ? 60 : 8); }
  // reconcile our flag when fullscreen is toggled outside the app (browser Esc/F11, or the native window)
  $effect(() => {
    const onWebFs = () => { const real = !!document.fullscreenElement; if (real !== fullscreen) { fullscreen = real; if (!real && fsFocusDriven) fsFocusDriven = false; } };
    document.addEventListener('fullscreenchange', onWebFs);
    let un = null, disposed = false;
    if (isTauri) (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        const u = await w.onResized(async () => { try { const real = await w.isFullscreen(); if (real !== fullscreen) { fullscreen = real; if (!real && fsFocusDriven) fsFocusDriven = false; } } catch (e) {} });
        if (disposed) u(); else un = u;   // if the effect was torn down mid-await, unlisten immediately
      } catch (e) {}
    })();
    return () => { disposed = true; document.removeEventListener('fullscreenchange', onWebFs); if (un) un(); };
  });
  function setZoom(z) { zoom = Math.max(70, Math.min(160, z)); }
  function setTheme(tv) { applyTheme(tv); }
  $effect(() => { try { document.documentElement.style.zoom = String(zoom / 100); localStorage.setItem('arf-zoom', zoom); } catch (e) {} });
  // in-app "Reduce transparency" — flips the material tokens to opaque via a documentElement attribute
  $effect(() => { try { document.documentElement.toggleAttribute('data-reduce-transparency', reduceTransparency); localStorage.setItem('arf-reduce-transparency', reduceTransparency ? '1' : '0'); } catch (e) {} });
  // scroll-edge: opening a note (or switching view) starts at the top, so the top-bar shadow resets
  $effect(() => { currentId; view; if (centerEl) centerEl.scrollTop = 0; centerScrolled = false; });
  function onCenterScroll(e) { const on = e.currentTarget.scrollTop > 4; if (on !== centerScrolled) centerScrolled = on; }
  // list-reorder FLIP: sqrt-scaled, capped at --dur-slow; off under reduced motion or above ~400 rows (jank guard).
  // rows also fly in / fade out on add/remove (a move keeps its key, so it's a flip, not add+remove — DnD is unaffected).
  let flipBig = $derived((folderRows?.length || 0) > 400 || (listNotes?.length || 0) > 400);
  const flipMs = (d) => (prefersReducedMotion.current || flipBig ? 0 : Math.min(30 + Math.sqrt(d) * 14, DUR.slow));
  const rowIn = () => (flipBig ? 0 : dur(DUR.base));
  const rowOut = () => (flipBig ? 0 : dur(DUR.fast));
  // --topbar-h tracks the real .top height (it wraps to two rows when narrow), so the graph overlay
  // inset and focus-mode padding stay correct. CSS keeps a 52px fallback for pre-mount frames.
  let topEl = $state(null);
  $effect(() => {
    if (!topEl) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[entries.length - 1]?.borderBoxSize?.[0]?.blockSize ?? topEl.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
    });
    ro.observe(topEl);
    return () => ro.disconnect();
  });
  // --focusmax caps the focus-mode measure at 40em (a specified constant: the design audit's focus-mode cap). It
  // narrows middle only, since tight tops out at 38em; comfy keeps its own wide preset as the explicit escape
  $effect(() => { try {
    const de = document.documentElement.style;
    de.setProperty('--readmax', READ_W[readWidth] || READ_W.middle);
    de.setProperty('--focusmax', readWidth === 'comfy' ? READ_W.comfy : '40em');
    localStorage.setItem('arf-readwidth', readWidth);
  } catch (e) {} });
  // Open the styled connect modal (replaces the native window.prompt). Appends to note A on confirm.
  function linkPair(aId, bId, terms) {
    const a = noteById(aId), b = noteById(bId); if (!a || !b) return;
    connect = { aId, bId, terms: (terms || []).filter((x) => x.length > 3).slice(0, 5), text: suggestRelation(a, b, terms) };
  }
  // Link the note being viewed to a Resonance suggestion on the right rail.
  function linkResonance(bId) {
    if (!currentId) return;
    const a = noteById(currentId), b = noteById(bId); if (!a || !b) return;
    linkPair(currentId, bId, sharedTerms(a, b, 5, vectorizer.idf));
  }
  function confirmConnect() {
    if (!connect) return;
    const { aId, bId, text } = connect; connect = null;
    const a = noteById(aId), b = noteById(bId); if (!a || !b) return;   // write to the live note, never a stale index object
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
    const im = e.target.closest('img[data-imw]');
    if (im) {
      e.preventDefault();
      const imgs = [...e.currentTarget.querySelectorAll('img[data-imw]')];
      const r = im.getBoundingClientRect(), w = im.getAttribute('data-imw');
      const fc = im.closest('figure')?.querySelector('figcaption');
      const cap = fc ? (fc.textContent || '').replace(/^Figure\s+\d+\s+—\s+/, '') : (im.getAttribute('alt') || '');
      imgCtl = { index: imgs.indexOf(im), x: Math.round(r.left), y: Math.round(r.top), w, cap };
      return;
    }
  }
  // --- link preview: a card for a [[wikilink]] in the read view or a note in the rail ---
  // Shown after the pointer rests (or keyboard focus lands) on the link; one card at a time, never
  // focused, positioned in layout px (the root is CSS-zoomed). Leaving the link starts a short grace
  // period so the pointer can reach the card, which opens (or creates) the note on click.
  // backlinks ("Referenced in") already show their context sentence, so only Resonance rows get a card in the rail
  const PV_SEL = '.read a.wl, .rail .ref.ml[data-nid]';
  const PV_DELAY = 350, PV_GRACE = 160, PV_W = 320;   // ms rest before showing; ms to cross to the card; card width (px)
  let preview = $state(null);   // { id?, newTitle?, title, text, out, inn, x, top?, bottom? }
  let pvShown = null, pvPending = null;   // the link whose card is up; the link waiting out the delay
  let pvTimer = 0, pvCloseTimer = 0;
  function pvSchedule(el) {
    if (el === pvShown) { clearTimeout(pvCloseTimer); return; }
    if (el === pvPending) return;
    clearTimeout(pvTimer);
    pvPending = el;
    pvTimer = setTimeout(() => { pvTimer = 0; pvPending = null; pvShow(el); }, PV_DELAY);
  }
  // an overlay or menu took over the screen: no card over it
  const pvBlocked = () => graphFull || paletteOpen || settingsOpen || digestOpen || !!connect || docExport || !!citePick || !!movePick || !!ctxMenu || libOverlay;
  function pvShow(el) {
    if (!el.isConnected || pvBlocked()) return;
    const id = el.getAttribute('data-nav') || el.getAttribute('data-nid');
    let card;
    if (id) {
      const n = noteById(id); if (!n) return;
      card = { id, title: n.title || 'Untitled', text: previewText(n.body), out: (idx.fwd[id] || []).length, inn: (idx.back[id] || []).length };
    } else {
      const t = el.getAttribute('data-newlink'); if (!t) return;
      card = { newTitle: t, title: t };
    }
    const zf = (zoom || 100) / 100, r = el.getBoundingClientRect();
    const vw = window.innerWidth / zf, vh = window.innerHeight / zf;
    const rail = el.closest('.rail');
    if (rail) {
      // a rail row: the card sits left of the rail, level with the row, so it never covers the rail itself
      const rl = rail.getBoundingClientRect().left / zf;
      card.x = Math.round(Math.max(8, rl - PV_W - 8));
      card.top = Math.round(Math.max(8, Math.min(r.top / zf, vh - 220)));
    } else {
      card.x = Math.round(Math.max(8, Math.min(r.left / zf, vw - PV_W - 8)));
      // below the link, or above it when the lower part of the window is too short for a card
      if (r.bottom / zf + 200 > vh && r.top / zf > vh - r.bottom / zf) card.bottom = Math.round(vh - r.top / zf + 6);
      else card.top = Math.round(r.bottom / zf + 6);
    }
    clearTimeout(pvCloseTimer);
    if (pvShown && pvShown !== el) pvShown.removeAttribute('aria-describedby');
    el.setAttribute('aria-describedby', 'arf-lpv');
    pvShown = el; preview = card;
  }
  function pvHide() {
    clearTimeout(pvCloseTimer); pvCloseTimer = 0;
    if (pvShown) pvShown.removeAttribute('aria-describedby');
    pvShown = null; preview = null;
  }
  function pvClose() { clearTimeout(pvTimer); pvTimer = 0; pvPending = null; pvHide(); }
  function pvCloseSoon() { clearTimeout(pvCloseTimer); pvCloseTimer = setTimeout(pvHide, PV_GRACE); }
  function pvOpen() {
    const p = preview; if (!p) return;
    pvClose();
    if (p.id) open(p.id); else createNamed(p.newTitle);
  }
  const pvLinks = (p) => (!p.out && !p.inn ? 'No links yet.'
    : 'Links to ' + p.out + (p.out === 1 ? ' note' : ' notes') + ', linked from ' + p.inn + '.');
  $effect(() => {
    const target = (e) => (e.target && e.target.closest ? e.target.closest(PV_SEL) : null);
    const over = (e) => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      const el = target(e);
      if (el) pvSchedule(el);
      else if (e.target && e.target.closest && e.target.closest('.lpv')) clearTimeout(pvCloseTimer);
    };
    const out = (e) => {
      const el = target(e); if (!el) return;
      const to = e.relatedTarget;
      if (to && to.closest && (to.closest('.lpv') || to.closest(PV_SEL) === el)) return;
      if (el === pvPending) { clearTimeout(pvTimer); pvTimer = 0; pvPending = null; }
      if (el === pvShown) pvCloseSoon();
    };
    const focusIn = (e) => { const el = target(e); if (el && el.matches(':focus-visible')) pvSchedule(el); };
    // deferred: Enter on a link, Ctrl+E and Ctrl+N tear the focused link down, and its focusout fires while Svelte
    // removes the DOM, where writing $state (preview) throws state_unsafe_mutation. Only what still belongs to
    // this link is cleared, so focus moving on to the next link keeps that link's pending card.
    const focusOut = (e) => {
      const el = target(e); if (!el || (el !== pvShown && el !== pvPending)) return;
      queueMicrotask(() => {
        if (el === pvPending) { clearTimeout(pvTimer); pvTimer = 0; pvPending = null; }
        if (el === pvShown) pvHide();
      });
    };
    const down = (e) => { if (!(e.target && e.target.closest && e.target.closest('.lpv'))) pvClose(); };
    const scroll = () => { if (preview || pvTimer) pvClose(); };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerover', over); document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focusIn); document.removeEventListener('focusout', focusOut);
      document.removeEventListener('pointerdown', down, true); window.removeEventListener('scroll', scroll, true);
      pvClose();
    };
  });
  // a note switch, mode or view change takes the anchor away; an overlay or menu covers it
  $effect(() => { currentId; mode; view; pvBlocked(); untrack(pvClose); });   // pvBlocked() is read for its dependencies

  // toggle the i-th rendered task checkbox in the current note (clicked in the read view). tasks.js maps
  // the DOM index to its source line through marked's own tokens, so code fences and the like can't shift it.
  function toggleTaskAt(i) {
    const n = current; if (!n) return;
    const next = toggleTaskBody(n.body || '', i); if (next == null) return;
    n.body = next; n.updated = new Date().toISOString(); markDirty(n.id); persist();
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
  function loadReaderHls(k) { const m = loadReaderHlMap(); return (Array.isArray(m[k]) ? m[k] : []).map(coerceHl); }   // coerce legacy string[] → {text,color}
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
      const k = readerSource?.key; if (k) readerHls = loadReaderHls(k);
    } catch (e) {}
  }
  $effect(() => { const k = readerSource?.key; readerHls = k ? loadReaderHls(k) : []; });
  // load a lazy piece the moment it is needed (the idle prefetch usually got there first)
  $effect(() => { if (mode === 'write') loadEditor(); });
  $effect(() => { if (view === 'library') loadLibrary(); });
  $effect(() => { if (reader) { loadReader(); if (reader.kind === 'note' || reader.kind === 'md') loadMath().catch(() => {}); } });
  // a Markdown reader re-renders once KaTeX arrives (keyed remount; never for pdf/epub/html sources)
  const readerKey = $derived(reader && (reader.kind === 'note' || reader.kind === 'md') ? mathVersion : -1);
  function openReaderNote(id) { if (noteById(id)) { reader = { kind: 'note', id }; view = 'notes'; rightHidden = false; } }
  function closeReader() { reader = null; }
  function addHighlight(text, color) {
    const k = readerSource?.key, t = (text || '').trim(); if (!k || t.replace(/\s/g, '').length < 3) return;
    const c = HL_COLORS.includes(color) ? color : HL_DEFAULT;
    const at = readerHls.findIndex((h) => coerceHl(h).text === t);
    if (at >= 0) readerHls = readerHls.map((h, i) => (i === at ? { text: t, color: c } : h));   // re-highlighting recolours
    else readerHls = [...readerHls, { text: t, color: c }];
    saveReaderHls(k, readerHls);
  }
  function removeHighlight(text) {
    const k = readerSource?.key, t = (text || '').trim(); if (!k) return;
    readerHls = readerHls.filter((h) => coerceHl(h).text !== t);
    saveReaderHls(k, readerHls);
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
  // read-view image controls: rewrite the Nth inline ![alt](src) in the body to set its width hint or
  // caption, so the change shows in the read view and travels into exports (both render from the same
  // Markdown). Fenced/inline code is masked first so image markdown inside a code block is never counted
  // or rewritten — keeping this index aligned with the rendered images the control clicks. (Reference-
  // style ![alt][id] images aren't inline-rewritable and are the one remaining index edge.)
  function rewriteNthImage(imgIndex, fn) {
    const n = current; if (!n) return; let i = -1, changed = false;
    const body = (n.body || '').replace(/(```[\s\S]*?```|`[^`\n]*`)|!\[([^\]]*)\]\(([^)]*)\)/g, (m, code, alt, src) => {
      if (code != null) return code;              // leave code spans/fences untouched and uncounted
      i++; if (i !== imgIndex) return m;
      changed = true; return '![' + fn(alt) + '](' + src + ')';
    });
    if (changed && body !== n.body) { n.body = body; n.updated = new Date().toISOString(); markDirty(n.id); flushSave(); }
  }
  function setImageWidth(imgIndex, w) { rewriteNthImage(imgIndex, (alt) => withSizeHint(alt, w)); if (imgCtl) imgCtl = { ...imgCtl, w: String(w || 'full') }; }
  function setImageCaption(imgIndex, cap) {
    rewriteNthImage(imgIndex, (alt) => { const { w } = parseImageAlt(alt); const c = (cap || '').replace(/[|\]]/g, ' ').trim(); return w ? (c ? c + '|' + w : '|' + w) : c; });
  }
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
    if (_resVzKey !== key) { _resVz = buildVectorizer(others, { evict: false }); _resVzKey = key; }
    const pv = _resVz.vectorize(text);
    let best = null;
    for (const n of others) {
      if (linked.has(n.id) || !_resVz.vecs[n.id] || !n.title || n.title.includes(']')) continue; // must be linkable
      const s = cosine(pv, _resVz.vecs[n.id]);
      if (s >= TFIDF_FLOOR && (!best || s > best.s)) best = { id: n.id, title: n.title, s };
    }
    return best;
  }

  // command palette. Titles are carried on the items from the live `notes` array so the render never
  // reads idx.byId (rebuilt on a 180ms debounce) — a stale index during boot/edits would otherwise
  // throw on .title and brick the palette.
  // id -> { t, tl, b, bl }: lower-cased title/body, recomputed only when that note's source string changes
  let lowerCache = new Map();
  function lowered(n, k) {
    let e = lowerCache.get(n.id); if (!e) { e = { t: null, tl: '', b: null, bl: '' }; lowerCache.set(n.id, e); }
    const src = (k === 't' ? n.title : n.body) || '';
    if (e[k] !== src) { e[k] = src; e[k + 'l'] = src.toLowerCase(); }
    return e[k + 'l'];
  }
  const palItems = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const titleOf = new Map(notes.map((n) => [n.id, n.title || 'Untitled']));
    if (lowerCache.size > titleOf.size + 64) lowerCache = new Map([...lowerCache].filter(([id]) => titleOf.has(id)));   // drop deleted notes
    let lex = notes.map((n) => {
      let score = 0, why = '';
      if (!q) { score = 1; why = ''; }
      else if (lowered(n, 't').includes(q)) { score = 3; why = 'Title'; }
      else if ((idx.noteTags[n.id] || []).some((t) => t.includes(q))) { score = 2; why = 'Tag'; }
      else if (lowered(n, 'b').includes(q)) { score = 1; why = 'Text'; }
      return { id: n.id, title: n.title || 'Untitled', score, why };
    }).filter((x) => x.score).sort((a, b) => b.score - a.score).slice(0, 8);
    let sem = [];
    if (q && lex.length) {
      const anchor = lex[0].id, shown = new Set(lex.map((l) => l.id));
      sem = related(anchor, vecs, notes, { exclude: shown, max: 3 }).map((s) => ({ ...s, title: titleOf.get(s.id) || 'Untitled' }));
    }
    return { lex, sem };
  });
  // keyboard selection in the palette (Notes rows, then Related rows) and the cite picker: ArrowUp/Down move the
  // active row (aria-activedescendant; focus stays in the input), Enter runs it. A new query starts at the top.
  let palActive = $state(0), citeActive = $state(0);
  const palFlat = $derived([...palItems.lex, ...palItems.sem]);
  const palSel = $derived(palFlat.length ? Math.min(palActive, palFlat.length - 1) : -1);
  const citeSel = $derived(citeMatches.length ? Math.min(citeActive, citeMatches.length - 1) : -1);
  $effect(() => { query; palActive = 0; });
  $effect(() => { citeQuery; citeActive = 0; });
  function pickerKey(e, n, cur, set, run) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = navStep(n, cur, e.key); if (i < 0) return;
      set(i);
      queueMicrotask(() => document.querySelector('.palette .prow.active')?.scrollIntoView({ block: 'nearest' }));
    } else if (e.key === 'Enter' && cur >= 0 && cur < n) { e.preventDefault(); run(cur); }
  }
  // the move pickers have no input: arrows move real focus between their rows
  function roveKey(e) { if (rove(e.currentTarget.parentElement, e, '.prow')) e.preventDefault(); }
  // which method scored the Synthesis pairs: model cosine (shown) or TF-IDF word overlap (kept in the title)
  const digestByModel = $derived(mlStatus === 'ready' && !!mlThresholds);
  const digest = $derived.by(() => {
    if (!digestOpen) return [];   // the pairwise scan is O(n²); only run it while the Synthesis panel is open
    let pairs;
    if (digestByModel) {
      pairs = []; const floor = mlThresholds.synthesis;
      for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) {
        const a = notes[i], b = notes[j];
        if (!mlVecs[a.id] || !mlVecs[b.id]) continue;
        if ((idx.fwd[a.id] || []).includes(b.id) || (idx.fwd[b.id] || []).includes(a.id)) continue;
        const s = mlCosine(mlVecs[a.id], mlVecs[b.id]);
        if (s >= floor) pairs.push({ a: a.id, b: b.id, s });
      }
      pairs = pairs.sort((x, y) => y.s - x.s).slice(0, 6);
    } else pairs = digestPairs(notes, vecs, idx, { max: 6 });
    // attach the words each pair shares, so the digest shows *why* they connect
    return pairs.map((p) => ({ ...p, terms: sharedTerms(idx.byId[p.a], idx.byId[p.b], 5, vectorizer.idf) }));
  });

  const editable = (t) => !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || (t.closest && t.closest('.cm-editor'))));
  function onKey(e) {
    if (e.defaultPrevented || !cacheReady) return; // let the editor/inputs claim a key before the global shortcuts run
    // Escape closes the topmost open thing, then stops — one Escape shouldn't both dismiss an overlay
    // AND drop out of focus/fullscreen. Only fall through to focus/fullscreen when nothing was open.
    if (e.key === 'Escape' && (preview || pvTimer)) { pvClose(); return; }   // the link preview first, on its own
    if (e.key === 'Escape') {
      const hadOverlay = paletteOpen || digestOpen || !!connect || graphFull || docExport || settingsOpen || !!movePick || !!citePick || !!imgCtl || !!ctxMenu || libOverlay;
      paletteOpen = false; digestOpen = false; connect = null; graphFull = false; docExport = false; settingsOpen = false; movePick = null; citePick = null; imgCtl = null; closeCtx();
      if (libOverlay) libraryRef?.closeOverlays();
      if (hadOverlay) return;
      if (focus) setFocus(false); else if (fullscreen) { fullscreen = false; applyFullscreen(false); }
      return;
    }
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    // an open overlay owns the keyboard — don't let a global shortcut mutate hidden state behind it
    if (paletteOpen || settingsOpen || digestOpen || connect || graphFull || docExport || movePick || citePick || libOverlay) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey; // ⌘ on macOS, Ctrl elsewhere — leaves Ctrl free for caret shortcuts on Mac
    const inField = editable(e.target); // view/edit chords must not fire while typing a title/body
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen = true; query = ''; }
    else if (mod && e.key.toLowerCase() === 'e') { if (inField) return; e.preventDefault(); if (view === 'notes') mode = mode === 'read' ? 'write' : 'read'; }
    else if (mod && e.key.toLowerCase() === 'g') { if (inField) return; e.preventDefault(); graphFull = !graphFull; }
    else if (mod && e.key.toLowerCase() === 'n') { if (inField) return; e.preventDefault(); if (view === 'library') view = 'notes'; create(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); }
    else if (mod && e.key.toLowerCase() === 'b') { if (inField) return; e.preventDefault(); view = view === 'library' ? 'notes' : 'library'; }
    else if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); flushSave(); syncFromFolder({ full: true }); }
    else if (mod && e.key === 'Backspace' && current && mode === 'read' && !inField) { e.preventDefault(); deleteNote(currentId); }
  }
</script>

<!-- with the OS drag-drop handler off (tauri dragDropEnabled:false, required for HTML5 DnD on Windows),
     an unhandled file drop would otherwise make the webview navigate to file:// and replace the app.
     These bubble-phase guards neutralise every drop; recognised files (notes, zip, references, .arf) import. -->
<svelte:window onkeydown={onKey} bind:innerWidth={winW} onmousemove={onFocusMouseMove} ondragover={(e) => e.preventDefault()} ondrop={onWindowDrop} />

{#if !cacheReady}
  <!-- the note cache is still loading (IndexedDB, a few ms) -->
{:else if needVault}
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
<div class="shell" class:focus={focus} class:reveal-top={topReveal}>
  <header class="top" class:scrolled={centerScrolled && view === 'notes' && !focus} bind:this={topEl}>
    <button class="wm" title="Notes" onclick={() => (view = 'notes')}>Arf<span class="dot">.</span></button>
    <div class="viewtoggle">
      <button class:on={view === 'notes'} title={'Notes (' + MOD + ' B switches)'} onclick={() => (view = 'notes')}>Notes</button>
      <button class:on={view === 'library'} title={'Reference library (' + MOD + ' B switches)'} onclick={() => (view = 'library')}>Library</button>
    </div>
    {#if view === 'notes' && !focus}
      <button class="tbtn iconbtn" class:on={!leftHidden} aria-pressed={!leftHidden} title={leftHidden ? 'Show the notes sidebar' : 'Hide the notes sidebar'} aria-label="Toggle notes sidebar" onclick={toggleLeftPanel}>{@html panelIcon('l', !leftHidden)}</button>
    {/if}
    <span class="sp"></span>
    <button class="searchpill" title={'Search notes, tags and ideas (' + MOD + ' K)'} onclick={() => { paletteOpen = true; query = ''; }}>
      <span class="mag">⌕</span><span class="lbl">Search</span><kbd>{MOD} K</kbd>
    </button>
    <div class="topacts">
      <button class="tbtn" title="Similar notes you have not linked yet" onclick={() => (digestOpen = true)}>Synthesis</button>
      <button class="tbtn" title={'Knowledge graph (' + MOD + ' G)'} onclick={() => (graphFull = true)}>Graph</button>
      <button class="tbtn" class:on={focus} aria-pressed={focus} title="Focus: only the note, full screen (Esc leaves)" onclick={toggleFocus}>Focus</button>
      <button class="tbtn" class:on={fullscreen} aria-pressed={fullscreen} onclick={toggleFullscreen} title="Fullscreen (F11)">Fullscreen</button>
      <button class="tbtn" title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'} onclick={toggleTheme}>Theme</button>
      <button class="tbtn" title="Settings: appearance, connection suggestions, import and export" onclick={() => (settingsOpen = true)}>Settings</button>
      {#if view === 'notes' && !focus && winW > 900}
        <button class="tbtn iconbtn" class:on={!rightHidden} aria-pressed={!rightHidden} title={rightHidden ? 'Show the right panel' : 'Hide the right panel'} aria-label="Toggle right panel" onclick={toggleRightPanel}>{@html panelIcon('r', !rightHidden)}</button>
      {/if}
      <!-- inside the actions group, so a narrow window wraps the actions and New onto the second row together -->
      <button class="newbtn" title={'New note (' + MOD + ' N)'} onclick={create}>＋&nbsp;New</button>
    </div>
  </header>

  {#if saveError}
    <div class="savebanner" out:fade={{ duration: dur(DUR.fast) }}>⚠ Couldn’t save — local storage may be full or blocked. Export this note now to avoid losing it.</div>
  {/if}
  {#if vaultErr}
    <div class="savebanner" out:fade={{ duration: dur(DUR.fast) }}>⚠ A file write to your vault folder failed. Arf keeps retrying; check that the folder exists and is writable.</div>
  {/if}
  {#if vaultCorrupt}
    <div class="savebanner" out:fade={{ duration: dur(DUR.fast) }}>⚠ Your saved notes couldn’t be read and were backed up (<span class="mono">{corruptBackupKey()}</span>). Starting with an empty vault. <button class="bnrbtn" onclick={() => (vaultCorrupt = false)}>Dismiss</button></div>
  {/if}
  {#if exportError}
    <div class="savebanner" out:fade={{ duration: dur(DUR.fast) }}>⚠ {exportError}</div>
  {/if}
  {#if uiMsg}
    <div class="savebanner" out:fade={{ duration: dur(DUR.fast) }}>{uiMsg}</div>
  {/if}

  {#if view === 'library'}
    {#if LibraryC}
    <LibraryC bind:this={libraryRef} bind:overlay={libOverlay} {notes} {idx} onopen={open} bind:refs bind:libFolders jumpTo={refJump} onjumped={() => (refJump = null)} onrefsdelete={() => queueMicrotask(refsToVault)}
      hasVault={!!vaultBackend} onopenreader={openReferenceInReader} onattach={attachLocalFile} onfetchpdf={fetchPdfForRef} ondetach={detachFromRef} onimport={() => pickImport('refs')} />
    {/if}
  {:else}
    <div class="ws" class:lhide={leftHidden} class:rhide={rightHidden} class:hasreader={!!reader} style="--leftw:{appliedLeftW}px; --rightw:{appliedRightW}px">
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
          <input class="nfinput" use:focusLater placeholder={renameFolderPath != null ? 'Rename folder' : (newFolderParent ? 'Subfolder of ' + newFolderParent : 'Folder name')} bind:value={newFolderName}
            onkeydown={(e) => { if (e.key === 'Enter') commitFolderInput(); else if (e.key === 'Escape') { newFolderName = null; renameFolderPath = null; } }} onblur={commitFolderInput} />
        {/if}

        {#if tagFilter}
          <button class="clearfilter" onclick={() => (tagFilter = null)}>← clear #{tagFilter}</button>
          {#each listNotes as n (n.id)}
            <button class="item" class:on={n.id === currentId} data-nid={n.id} draggable="true" animate:flip={{ duration: flipMs, easing: cubicOut }}
              in:fly={{ y: dist(6), duration: rowIn(), easing: quintOut }} out:fade={{ duration: rowOut() }}
              ondragstart={(e) => onDragStart(e, { type: 'note', id: n.id })} ondragend={onDragEnd} onclick={() => open(n.id)}>
              <span class="dot2" class:orphan={invDot(n.id) === '○'}>{invDot(n.id)}</span>
              <span class="txt"><span class="t">{n.title || 'Untitled'}</span></span>
            </button>
          {/each}
        {:else}
          {#each folderRows as r (r.type === 'folder' ? 'f:' + r.path : 'n:' + r.note.id)}
            <div class="rowhost" animate:flip={{ duration: flipMs, easing: cubicOut }} in:fly={{ y: dist(6), duration: rowIn(), easing: quintOut }} out:fade={{ duration: rowOut() }}>
            {#if r.type === 'folder'}
              <button class="frow" class:active={activeFolder === r.path} class:dropon={dropOn === r.path} class:dropbefore={isEdge('folder', r.path, 'before')} class:dropafter={isEdge('folder', r.path, 'after')} class:dragging={dragItem && dragItem.type === 'folder' && dragItem.path === r.path}
                data-folder={r.path} style="padding-left:{6 + r.depth * 12}px" draggable="true"
                ondragstart={(e) => onDragStart(e, { type: 'folder', path: r.path })} ondragend={onDragEnd}
                ondragover={(e) => { if (!folderRowDragOver(e, r.path)) { onDragOver(e, r.path); if (dropEdge && dropEdge.kind === 'folder' && dropEdge.path === r.path) dropEdge = null; } }} ondragleave={() => { if (dropOn === r.path) dropOn = null; if (dropEdge && dropEdge.kind === 'folder' && dropEdge.path === r.path) dropEdge = null; }} ondrop={(e) => onFolderRowDrop(e, r.path)}
                aria-expanded={r.hasChildren ? !r.collapsed : undefined} onkeydown={(e) => folderKey(e, r)}
                onclick={(e) => { if (e.target.closest('.caret')) toggleFolder(r.path); else if (activeFolder === r.path) toggleFolder(r.path); else { activeFolder = r.path; collapsed[r.path] = false; } }}>
                <span class="caret" aria-hidden="true">{r.hasChildren ? (r.collapsed ? '▸' : '▾') : '·'}</span><span class="fn">{r.name}</span>{#if r.count}<span class="fcount">{r.count}</span>{/if}
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
            </div>
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

      <main class="center" bind:this={centerEl} onscroll={onCenterScroll}>
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
              <input class="title" value={current.title} oninput={(e) => editTitle(e.currentTarget.value)} onfocus={() => (titleEditStart = current?.title ?? null)} onblur={commitTitleRename} aria-label="title" />
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
            {#key currentId}<div class="editor">{#if EditorC}<EditorC bind:this={editorRef} value={current.body} onchange={editBody} onmode={(m) => (mode = m)} resemble={resembleParagraph} oncite={openCitePicker} onimage={saveNoteImage} onimport={(list) => importFiles(list)} />{/if}</div>{/key}
          {:else}
            <!-- note switch: opacity-only fade, in-only (never add out: — a dying read view is fine, but the editor key block must never fire onchange for the old note). Keyboard nav stays near-instant at 80ms. -->
            <!-- click delegate for the rendered note: its links, tags, citations and task boxes are native <a>/<input>
                 elements that keep their own keyboard activation, so the delegate needs no key handler or role -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            {#key currentId}<div class="read" onclick={readClick} in:fade={{ duration: dur(DUR.exit) }}>{@html readHTML}{@html bibHTML}</div>{/key}
          {/if}
        {:else}
          <p class="empty">No note selected. Create one with “＋ New”.</p>
        {/if}
      </main>

      {#if reader}
        <aside class="rail readerpane">
          {#if ReaderC}{#key readerKey}<ReaderC source={readerSource} highlights={readerHls} canQuote={!!current} onclose={closeReader} onquote={quoteIntoNote} onhighlight={addHighlight} onunhighlight={removeHighlight} />{/key}{/if}
        </aside>
      {:else}
      <aside class="rail">
        <div class="rh">Referenced in <span>{backlinks.length}</span></div>
        {#if backlinks.length}
          {#each backlinks as b (b.id)}
            {@const c = backContext.get(b.id)}
            <div class="bl"><button class="ref" data-nid={b.id} onclick={() => open(b.id)}>{b.title}</button>{#if c}<p class="bctx">{c.before}<strong>{c.match}</strong>{c.after}</p>{/if}</div>
          {/each}
        {:else}<div class="rempty">No backlinks yet.</div>{/if}

        <div class="rh" style="margin-top:1.3rem" title="Notes similar to this one that are not linked to it yet"><span class="rhname" title={resonanceByModel ? 'Resonance · ' + activeEntry.name : null}>Resonance · {resonanceByModel ? shortModelName(activeEntry) : 'word overlap'}</span>
          {#if mlEnabling}<span class="mlstat">Model {railPct}%</span>
          {:else if mlStatus === 'off'}<button class="mltoggle" title="Connection suggestions: downloads a model once from Hugging Face; your notes stay on this device" onclick={enableML}>Use a model</button>
          {:else if mlStatus === 'loading'}<span class="mlstat">Model {railPct}%</span>
          {:else if mlStatus === 'ready'}{#if mlIndex && mlIndex.total > 3}<span class="mlstat" role="status" title="Embedding notes on this device; suggestions use word overlap until this finishes">Indexing {mlIndex.done} / {mlIndex.total}</span>{/if}<button class="mltoggle" title="Turn connection suggestions off; Resonance falls back to word overlap" onclick={disableML}>Turn off</button>
          {:else}<span class="mlstat" title={mlFiles[mlModel]?.detail || ''}>Model unavailable</span><button class="mltoggle" title="Try loading the model again" onclick={() => { mlStatus = 'off'; }}>Retry</button>{/if}
        </div>
        {#if resonance.length}
          {#each resonance as r}
            <div class="mlrow">
              {#if resonanceByModel}
                <button class="ref ml" data-nid={r.note.id} onclick={() => open(r.note.id)}><span class="sim" title={'Similarity 0–1 (' + activeEntry.name + ')'}>{r.s.toFixed(2)}</span><span class="nm">{r.note.title}</span></button>
              {:else}
                <!-- word-overlap scores are on a different scale from model scores, so they stay out of sight -->
                <button class="ref ml" data-nid={r.note.id} title={'Word overlap ' + r.s.toFixed(2)} onclick={() => open(r.note.id)}><span class="nm">{r.note.title}</span></button>
              {/if}
              <button class="mllink" title={'Link this note to “' + r.note.title + '”'} aria-label={'Link this note to ' + r.note.title} onclick={() => linkResonance(r.note.id)}>+ link</button>
            </div>
          {/each}
        {:else}<div class="rempty">Nothing close enough yet.</div>{/if}

        <div class="rh" style="margin-top:1.3rem">Local graph <button class="expand" title={'Open the full graph (' + MOD + ' G)'} onclick={() => (graphFull = true)}>⤢ Full</button></div>
        <GraphView {notes} {idx} centerId={currentId} mode="ego" onopen={open} suggest={graphSuggest} />
      </aside>
      {/if}
    </div>
  {/if}
</div>
{/if}

{#if graphFull}
  <div class="overlay" out:fade={{ duration: dur(DUR.fast) }} onoutrostart={leaving}>
    <div class="ovhead"><h3>Knowledge graph</h3>
      <span class="sp"></span><button class="ovclose" onclick={() => (graphFull = false)}>✕ Close</button></div>
    <GraphView {notes} {idx} centerId={currentId} mode="full" onopen={open} suggest={graphSuggest} onexport={saveGraphExport} />
  </div>
{/if}

<!-- The scrims below close on a click outside their dialog. That pointer-only path has a keyboard equivalent
     (Escape, handled globally in onKey), so their click handlers need no key handler or role of their own. -->
{#if paletteOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) paletteOpen = false; }} out:fade={{ duration: dur(DUR.exit) }} onoutrostart={leaving}>
    <div class="palette">
      <!-- svelte-ignore a11y_autofocus -->
      <input autofocus placeholder="Search notes, tags, or ideas…" bind:value={query} role="combobox" aria-expanded="true" aria-controls="pal-results" aria-autocomplete="list"
        aria-activedescendant={palSel >= 0 ? 'pal-opt-' + palSel : undefined}
        onkeydown={(e) => pickerKey(e, palFlat.length, palSel, (i) => (palActive = i), (i) => open(palFlat[i].id))} />
      <div class="presults" id="pal-results" role="listbox" aria-label="Notes found">
        <div role="group" aria-labelledby="pal-g-notes">
          <div class="pg" id="pal-g-notes">Notes</div>
          {#each palItems.lex as l, i}<button class="prow" class:active={i === palSel} id={'pal-opt-' + i} role="option" aria-selected={i === palSel} tabindex="-1" onpointermove={() => (palActive = i)} onclick={() => open(l.id)}><span class="pt">{l.title}</span><span class="pm">{l.why}</span></button>{:else}<div class="prow none" role="option" aria-selected="false" aria-disabled="true">No matches</div>{/each}
        </div>
        {#if palItems.sem.length}
          <!-- word-overlap neighbours of the top match; their scores stay in the title (a different scale from model scores) -->
          <div role="group" aria-labelledby="pal-g-sem">
            <div class="pg sem" id="pal-g-sem">Related · word overlap</div>
            {#each palItems.sem as s, j}{@const i = palItems.lex.length + j}<button class="prow" class:active={i === palSel} id={'pal-opt-' + i} role="option" aria-selected={i === palSel} tabindex="-1" title={'Word overlap ' + s.s.toFixed(2)} onpointermove={() => (palActive = i)} onclick={() => open(s.id)}><span class="pt i">{s.title}</span></button>{/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if citePick}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) citePick = false; }} out:fade={{ duration: dur(DUR.exit) }} onoutrostart={leaving}>
    <div class="palette citepicker">
      <!-- svelte-ignore a11y_autofocus -->
      <input autofocus placeholder="Insert citation — filter by author, title, year, or key…" bind:value={citeQuery} role="combobox" aria-expanded="true" aria-controls="cite-results" aria-autocomplete="list"
        aria-activedescendant={citeSel >= 0 ? 'cite-opt-' + citeSel : undefined}
        onkeydown={(e) => { if (e.key === 'Escape') citePick = false; else pickerKey(e, citeMatches.length, citeSel, (i) => (citeActive = i), (i) => insertCite(citeMatches[i])); }} />
      <div class="citemode">
        <button class:on={citeMode === 'both'} onclick={() => (citeMode = 'both')} title="Show the citation in the text and list it at the end of the note">In text + list</button>
        <button class:on={citeMode === 'intext'} onclick={() => (citeMode = 'intext')} title="Show the citation in the text only, without an entry in the reference list">In text only</button>
        <button class:on={citeMode === 'ref'} onclick={() => (citeMode = 'ref')} title="Add the work to the reference list without an in-text marker (like \nocite)">References only</button>
      </div>
      <div class="presults" id="cite-results" role="listbox" aria-labelledby="cite-g">
        <div class="pg" id="cite-g">References</div>
        {#each citeMatches as r, i (r.id)}
          <button class="prow" class:active={i === citeSel} id={'cite-opt-' + i} role="option" aria-selected={i === citeSel} tabindex="-1" onpointermove={() => (citeActive = i)} onclick={() => insertCite(r)}><span class="pt">{(r.authors && r.authors[0] ? r.authors[0].f : r.citekey)}{r.year ? ' ' + r.year : ''} — {r.title || 'Untitled'}</span><span class="pm">[@{r.citekey}]</span></button>
        {:else}
          <div class="prow none" role="option" aria-selected="false" aria-disabled="true">{refs.length ? 'No matching reference' : 'No references yet — add one in the Library first.'}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if movePick}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) movePick = null; }} out:fade={{ duration: dur(DUR.exit) }} onoutrostart={leaving}>
    <div class="palette" role="dialog" aria-modal="true" aria-label={'Move ' + (movePick.kind === 'folder' ? 'folder' : 'note') + ' to'}>
      <div class="pg" style="padding:.7rem .9rem .3rem">Move {movePick.kind === 'folder' ? 'folder' : 'note'} to…</div>
      <div class="presults">
        {#each moveDestinations(movePick.kind === 'folder' ? movePick.src : null) as dest}
          <button class="prow" onkeydown={roveKey} onclick={() => doMovePick(dest)}><span class="pt">{dest === '' ? '↑ Top level' : dest}</span></button>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if docExport}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) docExport = false; }} out:fade={{ duration: dur(DUR.fast) }} onoutrostart={leaving}>
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
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) digestOpen = false; }} out:fade={{ duration: dur(DUR.fast) }} onoutrostart={leaving}>
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
            {#if digestByModel}<span class="psim" title={'Similarity 0–1 (' + (activeEntry?.name || 'model') + ')'}>{p.s.toFixed(2)}</span>{/if}<button class="link" title={digestByModel ? '' : 'Word overlap ' + p.s.toFixed(2)} onclick={() => linkPair(p.a, p.b, p.terms)}>Link</button>
          </div>
        {:else}<div class="rempty" style="padding:1rem 0">Everything similar is already linked. Good week.</div>{/each}
      </div>
    </div>
  </div>
{/if}

{#if connect}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) connect = null; }} out:fade={{ duration: dur(DUR.fast) }} onoutrostart={leaving}>
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
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) settingsOpen = false; }} out:fade={{ duration: dur(DUR.fast) }} onoutrostart={leaving}>
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
      <div class="setrow"><span class="sk">Reading width <span class="sh">Width of the writing and reading column — scales with the side panels. Focus mode narrows Middle; Tight and Comfy keep their width.</span></span>
        <div class="seg"><button class:on={readWidth === 'tight'} onclick={() => setReadWidth('tight')}>Tight</button><button class:on={readWidth === 'middle'} onclick={() => setReadWidth('middle')}>Middle</button><button class:on={readWidth === 'comfy'} onclick={() => setReadWidth('comfy')}>Comfy</button></div>
      </div>
      <div class="setrow"><span class="sk">Reduce transparency <span class="sh">Make menus and the command palette solid instead of frosted glass</span></span>
        <div class="seg"><button class:on={!reduceTransparency} onclick={() => (reduceTransparency = false)}>Off</button><button class:on={reduceTransparency} onclick={() => (reduceTransparency = true)}>On</button></div>
      </div>

      <div class="setlabel">Connection suggestions</div>
      <div class="setrow"><span class="sk">Use a model <span class="sh">Resonance and Synthesis compare notes with a model that runs on this device. Models download from Hugging Face only when you ask; your notes never leave this device. Off: word overlap.</span></span>
        <div class="seg" role="group" aria-label="Connection suggestions"><button class:on={!mlEnabled} aria-pressed={!mlEnabled} onclick={disableML}>Off</button><button class:on={mlEnabled} aria-pressed={mlEnabled} onclick={() => { if (!mlEnabled) enableML(); }}>On</button></div>
      </div>
      <ul class="mlist" aria-label="Models">
        {#each modelList as m (m.id)}
          {@const f = mlFiles[m.id]}
          {@const busy = f?.state === 'downloading' || (m.id === mlModel && mlEnabled && mlStatus === 'loading')}
          {@const inUse = m.id === mlModel && mlEnabled}
          {@const noUse = inUse || busy}
          {@const noRemove = inUse || busy || (!m.custom && f?.state !== 'present')}
          <li class="mrow" data-model={m.id}>
            <span class="mglyph">{@html icon(m.icon, 18)}</span>
            <span class="minfo">
              <span class="mname">{m.name}{#if m.id === RECOMMENDED_ID}<span class="mrec">Recommended</span>{/if}</span>
              <span class="mdesc">{m.description}</span>
              <span class="mmeta">{m.languages}, {modelSize(m)}{#if m.licence}, {m.licence}{/if}</span>
              {#if busy}<span class="mbar" role="progressbar" aria-label={'Downloading ' + m.name} aria-valuemin="0" aria-valuemax="100" aria-valuenow={f?.pct || mlPct}><span style="width:{f?.pct || mlPct}%"></span></span>{/if}
            </span>
            <span class="mstate" title={f?.detail || ''} aria-live="polite">{modelStatus(m)}</span>
            <!-- one Download/Cancel button whose label and icon switch, and aria-disabled instead of disabled, so
                 keyboard focus stays put while a download starts, ends or the model changes state -->
            <span class="mact">
              {#if busy || f?.state !== 'present'}
                <button class="mbtn" data-act="fetch" aria-label={busy ? 'Cancel download of ' + m.name : 'Download ' + m.name} title={busy ? 'Cancel download' : 'Download ' + m.name + ' without using it yet'}
                  onclick={(e) => (busy ? cancelModel(m) : fetchFromButton(m, e.currentTarget))}>{@html icon(busy ? 'close' : 'download')}</button>
              {/if}
              <button class="mbtn" data-act="use" aria-label={'Use ' + m.name} title={inUse ? 'In use' : f?.state === 'present' ? 'Use ' + m.name : 'Download and use ' + m.name} aria-disabled={noUse} onclick={() => { if (!noUse) useModel(m); }}>{@html icon('check')}</button>
              <button class="mbtn" data-act="remove" aria-label={'Remove ' + m.name} title={inUse ? 'Turn suggestions off to remove the model in use' : m.custom ? 'Remove ' + m.name + ' and its files' : 'Delete the downloaded files'} aria-disabled={noRemove} onclick={() => { if (!noRemove) removeModel(m); }}>{@html icon('trash')}</button>
            </span>
          </li>
        {/each}
        <li class="mrow mcustom">
          <span class="mglyph">{@html icon('model-add', 18)}</span>
          <span class="minfo">
            <span class="mname">Other model</span>
            <span class="mdesc">Any Hugging Face repo with onnx/model_quantized.onnx in the Transformers.js layout</span>
            <span class="mcustomrow">
              <input class="mcinput" placeholder="owner/name" aria-label="Hugging Face repo id" spellcheck="false" autocomplete="off" bind:value={customId}
                oninput={() => (customCheck = null)} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); checkCustom(); } }} />
              <button class="setbtn" disabled={!customId.trim() || customCheck?.busy} onclick={checkCustom}>Validate</button>
            </span>
            {#if customCheck?.busy}<span class="mmeta" aria-live="polite">Checking…</span>
            {:else if customCheck && !customCheck.ok}<span class="mmeta" aria-live="polite">{customCheck.error}</span>
            {:else if customCheck?.ok}
              <span class="mmeta" aria-live="polite">Found: {Math.round(customCheck.fileBytes / 1e5) / 10} MB{#if customCheck.dims}, {customCheck.dims}-d{/if}{#if customCheck.licence}, {customCheck.licence}{/if}</span>
              <span class="mcustomrow">
                {#if customCheck.pooling === 'cls'}
                  <span class="mmeta">Pooling</span>
                  <div class="seg" role="group" aria-label="Pooling"><button class:on={customPooling === 'cls'} aria-pressed={customPooling === 'cls'} onclick={() => (customPooling = 'cls')}>CLS</button><button class:on={customPooling === 'mean'} aria-pressed={customPooling === 'mean'} onclick={() => (customPooling = 'mean')}>Mean</button></div>
                {/if}
                <button class="setbtn" onclick={addCustom}>Add to list</button>
              </span>
              <span class="mcustomrow">
                <input class="mcinput" placeholder="Passage prefix, if the model needs one (e.g. passage: )" aria-label="Passage prefix (optional)" spellcheck="false" autocomplete="off" bind:value={customPrefix} />
              </span>
            {/if}
          </span>
        </li>
      </ul>

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

      <div class="setlabel">Import and export</div>
      <div class="setrow"><span class="sk">Import notes <span class="sh">Markdown from Obsidian, Jekyll or any folder; a note with the same id keeps its newer copy, and a file imported again is recognised. Files dropped on the window import too.</span></span>
        <span class="setbtnrow"><button class="setbtn" disabled={importBusy} onclick={() => pickImport('notes')}>Markdown files…</button><button class="setbtn" disabled={importBusy} onclick={() => pickImport('folder')}>Folder…</button><button class="setbtn" disabled={importBusy} onclick={() => pickImport('zip')}>ZIP…</button></span>
      </div>
      <div class="setrow"><span class="sk">Import references <span class="sh">BibTeX, RIS or CSL-JSON; works already in the Library are skipped</span></span>
        <button class="setbtn" disabled={importBusy} onclick={() => pickImport('refs')}>.bib, .ris, .json…</button>
      </div>
      <div class="setrow"><span class="sk">Export vault <span class="sh">every note as a Markdown file in its folder, plus references.bib, references.json and the vault’s images and reference files</span></span>
        <button class="setbtn" onclick={exportVaultZipFile}>Export as ZIP</button>
      </div>
      <div class="setrow"><span class="sk">Workspace backup <span class="sh">one .arf file with every note, folder, and reference</span></span>
        <span class="setbtnrow"><button class="setbtn" onclick={exportWorkspace}>Export .arf</button><button class="setbtn" onclick={() => fileInput.click()}>Import .arf…</button></span>
      </div>
      <!-- reserved below the buttons so nothing moves when a result arrives; the text stays until the next import or export -->
      <p class="importmsg" role="status" aria-live="polite">{importMsg}</p>
      <input type="file" accept=".arf,application/json" bind:this={fileInput} onchange={importWorkspace} style="display:none" />

      <div class="setlabel">About</div>
      <div class="setrow"><span class="sk">Arf {APP_VERSION}</span>
        <span class="setstat"><a href="https://tunabirgun.github.io/arf/" target="_blank" rel="noopener">Docs</a> · <a href="https://github.com/tunabirgun/arf" target="_blank" rel="noopener">Source</a></span>
      </div>
    </div>
  </div>
{/if}

{#if imgCtl}
  <div class="imgctlback" out:fade={{ duration: dur(DUR.exit) }} onoutrostart={leaving} onclick={() => (imgCtl = null)} oncontextmenu={(e) => { e.preventDefault(); imgCtl = null; }} onkeydown={(e) => { if (e.key === 'Escape') imgCtl = null; }} role="button" tabindex="-1" aria-label="Close image controls"></div>
  <div class="imgctl" style="left:{imgCtl.x}px; top:{imgCtl.y}px" out:fade={{ duration: dur(DUR.exit) }} onoutrostart={leaving}>
    <div class="imgctl-row">
      <span class="imgctl-lbl">Size</span>
      <button class:on={imgCtl.w === '240'} onclick={() => setImageWidth(imgCtl.index, 240)}>S</button>
      <button class:on={imgCtl.w === '400'} onclick={() => setImageWidth(imgCtl.index, 400)}>M</button>
      <button class:on={imgCtl.w === '600'} onclick={() => setImageWidth(imgCtl.index, 600)}>L</button>
      <button class:on={imgCtl.w === 'full'} onclick={() => setImageWidth(imgCtl.index, null)}>Full</button>
    </div>
    <!-- svelte-ignore a11y_autofocus -->
    <input class="imgctl-cap" autofocus placeholder="Figure caption (auto-numbered)…" value={imgCtl.cap}
      oninput={(e) => (imgCtl = { ...imgCtl, cap: e.currentTarget.value })}
      onkeydown={(e) => { if (e.key === 'Enter') { setImageCaption(imgCtl.index, imgCtl.cap); imgCtl = null; } else if (e.key === 'Escape') { e.stopPropagation(); imgCtl = null; } }}
      onblur={() => imgCtl && setImageCaption(imgCtl.index, imgCtl.cap)} />
  </div>
{/if}

{#if ctxMenu}
  <div class="ctxback" out:fade={{ duration: dur(DUR.exit) }} onoutrostart={leaving} onclick={closeCtx} oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); closeCtx(); }} onkeydown={(e) => { if (e.key === 'Escape') closeCtx(); }} role="button" tabindex="0" aria-label="Close menu"></div>
  <div class="ctxmenu" style="left:{ctxMenu.x}px; top:{ctxMenu.y}px" oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); }} onkeydown={ctxKey} role="menu" tabindex="-1"
    out:fade={{ duration: dur(DUR.exit) }} onoutrostart={leaving}>
    {#each ctxMenu.items as it}
      {#if it.sep}
        <div class="ctxsep" role="separator"></div>
      {:else}
        <button class="ctxi" class:danger={it.danger} role="menuitem" tabindex="-1" disabled={it.disabled} onclick={() => runCtx(it)}>{it.label}</button>
      {/if}
    {/each}
  </div>
{/if}

{#if preview}
  <!-- the link preview card: never focused (the link it describes keeps focus and is the keyboard path;
       Enter on it opens the note), so its click handler has no key counterpart -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="lpv" id="arf-lpv" role="tooltip" style="left:{preview.x}px; {preview.top != null ? 'top:' + preview.top + 'px' : 'bottom:' + preview.bottom + 'px'}"
    in:fade={{ duration: dur(DUR.fast) }} out:fade={{ duration: dur(DUR.exit) }}
    onpointerenter={() => clearTimeout(pvCloseTimer)} onpointerleave={pvCloseSoon} onmousedown={(e) => e.preventDefault()} onclick={pvOpen}>
    <div class="lpv-t">{preview.title}</div>
    {#if preview.newTitle != null}
      <p class="lpv-x lpv-new">Not created yet; open the link to create it</p>
    {:else}
      {#if preview.text}<p class="lpv-x">{preview.text}</p>{:else}<p class="lpv-x lpv-new">Empty note.</p>{/if}
      <div class="lpv-m">{pvLinks(preview)}</div>
    {/if}
  </div>
{/if}

