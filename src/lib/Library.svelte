<script>
  import MiniSearch from 'minisearch';
  import { shortAuth, joinRefs } from './cite.js';
  import { folderList, canonFolder, buildFolderRows, planFolderMove } from './folders.js';
  let { notes, idx, onopen, refs = $bindable([]), libFolders = $bindable([]), jumpTo = null, onjumped = null, onrefsdelete = null,
    hasVault = false, onopenreader = null, onattach = null, onfetchpdf = null, ondetach = null } = $props();

  const TYPELABEL = { 'article-journal': 'Article', 'article-magazine': 'Magazine', book: 'Book', preprint: 'Preprint', dataset: 'Dataset', webpage: 'Web' };
  const FILTERS = [
    { k: 'all', l: 'All' }, { k: 'article-journal', l: 'Articles' }, { k: 'book', l: 'Books' },
    { k: 'article-magazine', l: 'Magazines' }, { k: 'webpage', l: 'Webpages' }, { k: 'preprint', l: 'Preprints' },
  ];

  let filter = $state('all');
  let libQuery = $state('');          // keyword search across every reference field
  let folderFilter = $state(null);   // null = all folders; '' = unfiled; else a folder path (matches it + subfolders)
  let dragRef = $state(null);        // id of the reference row being dragged onto a folder
  let dragFolder = $state(null);     // path of a library folder being dragged to nest under another
  let dropFolder = $state(undefined);// folder currently hovered as a drop target ('' = unfiled)
  // library folder tree management (mirrors the notes sidebar)
  let libCollapsed = $state({});
  let newFolderName = $state(null);   // inline new/rename input (null = hidden)
  let newFolderParent = $state('');
  let renameFolderPath = $state(null);
  let movePick = $state(null);        // { src } — the "Move folder to…" picker
  let uiMsg = $state(''); let uiTimer;
  function notify(m) { uiMsg = m; clearTimeout(uiTimer); uiTimer = setTimeout(() => (uiMsg = ''), 2600); }
  let selId = $state(refs[0]?.id ?? null);
  // jump to a reference when a [@citekey] citation is clicked — one-shot, so a later refs change
  // (e.g. deleting or adding a ref) doesn't keep snapping the selection back to the cited one
  let lastJump;
  $effect(() => {
    if (jumpTo && jumpTo !== lastJump) {
      lastJump = jumpTo;
      const r = refs.find((x) => x.citekey === jumpTo.key); if (r) { selId = r.id; filter = 'all'; }
      onjumped && onjumped();
    }
  });
  function deleteRef() {
    if (!sel) return;
    if (!confirm('Delete the reference “' + (sel.title || sel.citekey) + '”?\n\nCitations to it in your notes will show as unknown until you re-add it.')) return;
    const id = sel.id;
    refs = refs.filter((r) => r.id !== id);
    selId = refs[0]?.id ?? null;
    onrefsdelete && onrefsdelete();   // flush references.json now so the delete can't be resurrected from disk on next launch
  }
  function copyCite(r) { try { navigator.clipboard.writeText('[@' + r.citekey + ']'); } catch (e) {} }
  let exportScope = $state(null); // refId | 'all' | 'selected' | null
  let selected = $state(new Set()); // ids ticked for bulk export
  function toggleSel(id) { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); selected = s; }
  let expFmt = $state('BibTeX');
  let adding = $state(false);
  let attachPrompt = $state(null);   // a just-added reference we're offering to attach a reader file to
  let addInput = $state('');
  let addResult = $state(undefined);
  let addBusy = $state(false);
  let addError = $state('');
  let fetchToken = 0;

  const FETCH_DB = {
    '9780262035613': { type: 'book', citekey: 'goodfellow2016', title: 'Deep Learning', authors: [{ f: 'Goodfellow', g: 'Ian' }, { f: 'Bengio', g: 'Yoshua' }, { f: 'Courville', g: 'Aaron' }], year: 2016, publisher: 'MIT Press', isbn: '9780262035613', sources: ['Open Library', 'Google Books'] },
    'arxiv:1706.03762': { type: 'preprint', citekey: 'vaswani2017', title: 'Attention Is All You Need', authors: [{ f: 'Vaswani', g: 'Ashish' }], year: 2017, container: 'arXiv', doi: '10.48550/arXiv.1706.03762', sources: ['arXiv', 'Semantic Scholar'] },
    '10.1103/physrevd.23.347': { type: 'article-journal', citekey: 'guth1981', title: 'Inflationary universe: A possible solution to the horizon and flatness problems', authors: [{ f: 'Guth', g: 'Alan H.' }], year: 1981, container: 'Physical Review D', volume: '23', pages: '347–356', doi: '10.1103/PhysRevD.23.347', sources: ['Crossref', 'OpenAlex'] },
  };

  const refFolders = $derived(folderList([], refs));   // folder paths implied by the refs' folder fields
  const allLibFolders = $derived(folderList(libFolders, refs));  // persisted + implied, for the move picker
  const hasUnfiled = $derived(refs.some((r) => !canonFolder(r.folder)));
  // nested folder rows for the tree (folder rows only; refs render in the middle column).
  // buildFolderRows treats a ref as a "note" — refs carry id/title/folder, so it just works.
  const folderTree = $derived(buildFolderRows(libFolders, refs, libCollapsed).filter((r) => r.type === 'folder'));
  const inFolder = (r) => { if (folderFilter == null) return true; const f = canonFolder(r.folder); return folderFilter === '' ? !f : (f === folderFilter || f.startsWith(folderFilter + '/')); };
  // Keyword search: a client-side MiniSearch index over every reference field (authors flattened
  // to names). Prefix + light fuzzy so "vasw", "attention", "1706", or a DOI fragment all hit.
  // Rebuilt on any refs change — a personal library is small, so a full reindex is negligible.
  function refDoc(r) {
    return {
      id: r.id, title: r.title || '', citekey: r.citekey || '',
      authors: (r.authors || []).map((a) => (a.g ? a.g + ' ' : '') + a.f).join(', '),
      year: String(r.year || ''), container: r.container || '', publisher: r.publisher || '',
      abstract: r.abstract || '', doi: r.doi || '', isbn: r.isbn || '',
      sources: (r.sources || []).join(' '), folder: r.folder || '',
    };
  }
  const libIndex = $derived.by(() => {
    const ms = new MiniSearch({
      fields: ['title', 'authors', 'year', 'container', 'publisher', 'abstract', 'doi', 'isbn', 'citekey', 'sources', 'folder'],
      searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND', boost: { title: 3, authors: 2, citekey: 2 } },
    });
    ms.addAll(refs.map(refDoc));
    return ms;
  });
  const searchIds = $derived.by(() => {
    const q = libQuery.trim();
    if (!q) return null;                                 // null = search inactive (show all)
    return new Set(libIndex.search(q).map((h) => h.id));
  });
  const filtered = $derived(refs.filter((r) => (filter === 'all' || r.type === filter) && inFolder(r) && (searchIds == null || searchIds.has(r.id))));
  const sel = $derived(refs.find((r) => r.id === selId) ?? null);
  // assign the selected reference to a folder (creates the folder by naming it; '' = unfiled)
  function assignFolder(id, v) {
    const path = canonFolder(v);
    refs = refs.map((r) => r.id === id ? { ...r, folder: path } : r);
  }
  function folderCount(p) { return refs.filter((r) => { const f = canonFolder(r.folder); return f === p || f.startsWith(p + '/'); }).length; }

  // --- library folder tree management (parallels App.svelte's note-folder functions) ---
  function toggleLibFolder(p) { libCollapsed[p] = !libCollapsed[p]; }
  function commitFolderInput() { if (renameFolderPath != null) commitLibRename(); else addLibFolder(); }
  function addLibFolder() {
    const raw = (newFolderName || '').trim(); newFolderName = null;
    if (!raw) return;
    const name = canonFolder(raw.replace(/[\/\\]/g, '-')); if (!name) return;
    const parent = canonFolder(newFolderParent);
    const path = parent ? parent + '/' + name : name;
    if (!libFolders.includes(path)) libFolders = [...libFolders, path];
    if (parent) libCollapsed[parent] = false;
    folderFilter = path;
  }
  function libCollision(src, newPath, leaf) {
    if (libFolders.some((p) => (p === newPath || p.startsWith(newPath + '/')) && !(p === src || p.startsWith(src + '/'))) ||
        refs.some((r) => { const f = canonFolder(r.folder); return (f === newPath || f.startsWith(newPath + '/')) && !(f === src || f.startsWith(src + '/')); })) {
      notify('A folder named “' + leaf + '” already exists there.'); return true;
    }
    return false;
  }
  function commitLibRename() {
    const raw = (newFolderName || '').trim(); const src = canonFolder(renameFolderPath); newFolderName = null; renameFolderPath = null;
    if (!raw || !src) return;
    const name = canonFolder(raw.replace(/[\/\\]/g, '-')); if (!name) return;
    const parent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
    const newPath = parent ? parent + '/' + name : name;
    if (newPath === src || libCollision(src, newPath, name)) return;
    const re = (p) => p === src ? newPath : (p.startsWith(src + '/') ? newPath + p.slice(src.length) : p);
    libFolders = [...new Set(libFolders.map(re))];
    refs = refs.map((r) => { const f = canonFolder(r.folder); return (f === src || f.startsWith(src + '/')) ? { ...r, folder: re(f) } : r; });
    if (libCollapsed[src] != null) { libCollapsed[newPath] = libCollapsed[src]; delete libCollapsed[src]; }
    if (folderFilter === src || (folderFilter && folderFilter.startsWith(src + '/'))) folderFilter = re(folderFilter);
  }
  function deleteLibFolder(path) {
    path = canonFolder(path); if (!path) return;
    if (!confirm('Delete the library folder “' + path.slice(path.lastIndexOf('/') + 1) + '”?\n\nReferences inside move up to the parent — none are deleted.')) return;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const reDesc = (p) => { const suf = p.slice(path.length + 1); return parent ? parent + '/' + suf : suf; };
    libFolders = [...new Set(libFolders.flatMap((p) => p === path ? [] : (p.startsWith(path + '/') ? [reDesc(p)] : [p])))];
    refs = refs.map((r) => { const f = canonFolder(r.folder); if (f === path) return { ...r, folder: parent }; if (f.startsWith(path + '/')) return { ...r, folder: reDesc(f) }; return r; });
    if (folderFilter === path) folderFilter = parent || null; else if (folderFilter && folderFilter.startsWith(path + '/')) folderFilter = reDesc(folderFilter);
    if (libCollapsed[path] != null) delete libCollapsed[path];
  }
  function moveLibFolder(src, destParent) {
    const plan = planFolderMove(src, destParent, libFolders, refs);
    if (!plan.ok) { if (plan.reason === 'collision') notify('A folder named “' + plan.leaf + '” already exists there.'); return; }
    libFolders = plan.newFolders;
    const moves = new Map(plan.noteMoves.map((m) => [m.id, m.to]));
    refs = refs.map((r) => moves.has(r.id) ? { ...r, folder: moves.get(r.id) } : r);
    if (libCollapsed[plan.src] != null) { libCollapsed[plan.newPath] = libCollapsed[plan.src]; delete libCollapsed[plan.src]; }
    if (folderFilter === plan.src || (folderFilter && folderFilter.startsWith(plan.src + '/'))) folderFilter = plan.reparent(folderFilter);
  }
  function moveDestinations(src) { return [''].concat(allLibFolders.filter((f) => f !== src && !f.startsWith(src + '/'))); }
  function doMovePick(dest) { const p = movePick; movePick = null; if (p) moveLibFolder(p.src, dest); }
  // library folder drag & drop: nest a folder, or drop a reference into a folder
  function folderDragAllowed(target) {
    if (dragFolder) { const s = canonFolder(dragFolder), t = canonFolder(target); return !(t === s || t.startsWith(s + '/')); }
    return !!dragRef;
  }
  function onFolderDrop(target) {
    if (dragFolder) { if (folderDragAllowed(target)) moveLibFolder(dragFolder, target); }
    else if (dragRef) assignFolder(dragRef, target);
    dragRef = null; dragFolder = null; dropFolder = undefined;
  }
  // methods the global right-click menu (App.svelte) drives via bind:this
  export function ctxNewFolder() { newFolderParent = ''; renameFolderPath = null; newFolderName = ''; }
  export function ctxNewSubfolder(path) { newFolderParent = path; renameFolderPath = null; newFolderName = ''; libCollapsed[path] = false; }
  export function ctxRenameFolder(path) { renameFolderPath = path; newFolderName = path.slice(path.lastIndexOf('/') + 1); }
  export function ctxDeleteFolder(path) { deleteLibFolder(path); }
  export function ctxMoveFolder(path) { movePick = { src: canonFolder(path) }; }
  export function ctxSelectFolder(path) { folderFilter = path; libCollapsed[path] = false; }
  export function ctxNewRef() { adding = true; addResult = undefined; addInput = ''; addError = ''; addBusy = false; fetchToken++; }
  export function ctxFolderCollapsed(path) { return !!libCollapsed[path]; }
  const exportRefs = $derived(exportScope === 'all' ? refs : exportScope === 'selected' ? refs.filter((r) => selected.has(r.id)) : refs.filter((r) => r.id === exportScope));
  const exportText = $derived(joinRefs(exportRefs, expFmt));

  function count(k) { return k === 'all' ? refs.length : refs.filter((r) => r.type === k).length; }

  function mkCitekey(authors, year) {
    // citekeys are conventionally ASCII: fold diacritics (Şahin→sahin, Müller→muller) rather than
    // dropping the accented letters outright (which would eat the first letter of the name)
    const raw = (authors && authors[0] && authors[0].f ? authors[0].f : 'ref');
    const base = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'ref';
    return base + (year || '');
  }
  async function fetchDOI(doi) {
    const r = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const m = (await r.json()).message; if (!m) return null;
    const authors = (m.author || []).map((a) => ({ f: a.family || a.name || '', g: a.given || '' })).filter((a) => a.f);
    const dp = (m.issued && m.issued['date-parts'] && m.issued['date-parts'][0]) || (m.published && m.published['date-parts'] && m.published['date-parts'][0]) || [];
    const type = /book|monograph/.test(m.type || '') ? 'book' : m.type === 'posted-content' ? 'preprint' : 'article-journal';
    const title = (Array.isArray(m.title) ? m.title[0] : m.title) || 'Untitled';
    const container = (Array.isArray(m['container-title']) ? m['container-title'][0] : m['container-title']) || '';
    const citekey = mkCitekey(authors, dp[0] || '');
    return { id: 'r_' + citekey, citekey, type, title, authors, year: dp[0] || '', container, volume: m.volume || '', pages: m.page || '', doi: m.DOI || doi, publisher: m.publisher || '', url: m.URL || '', sources: ['Crossref'] };
  }
  async function fetchISBN(isbn) {
    const r = await fetch('https://openlibrary.org/api/books?bibkeys=ISBN:' + isbn + '&format=json&jscmd=data', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const b = (await r.json())['ISBN:' + isbn]; if (!b) return null;
    const authors = (b.authors || []).map((a) => { const p = (a.name || '').trim().split(/\s+/); const f = p.pop() || (a.name || ''); return { f, g: p.join(' ') }; });
    const year = ((b.publish_date || '').match(/\d{4}/) || [''])[0];
    const publisher = (b.publishers && b.publishers[0] && b.publishers[0].name) || '';
    const citekey = mkCitekey(authors, year);
    return { id: 'r_' + citekey, citekey, type: 'book', title: b.title || 'Untitled', authors, year, publisher, isbn, url: b.url || '', sources: ['Open Library'] };
  }
  async function fetchArxiv(arxivId) {
    // arXiv DOIs are registered with DataCite, not Crossref
    const doi = '10.48550/arXiv.' + arxivId;
    const r = await fetch('https://api.datacite.org/dois/' + encodeURIComponent(doi), { headers: { Accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const at = (await r.json()).data?.attributes; if (!at) return null;
    const title = (at.titles && at.titles[0] && at.titles[0].title) || 'Untitled';
    const authors = (at.creators || []).map((c) => ({ f: c.familyName || (c.name || '').split(',')[0].trim() || c.name || '', g: c.givenName || '' })).filter((a) => a.f);
    const year = at.publicationYear || '';
    const citekey = mkCitekey(authors, year);
    return { id: 'r_' + citekey, citekey, type: 'preprint', title, authors, year, container: 'arXiv', doi, url: 'https://arxiv.org/abs/' + arxivId, sources: ['arXiv', 'DataCite'] };
  }
  async function doFetch() {
    const rawInput = addInput.trim(); if (!rawInput) return;
    const token = ++fetchToken;                 // supersede any in-flight/cancelled request
    addResult = undefined; addBusy = true; addError = '';
    try {
      let v = rawInput.toLowerCase()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
        .replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//, 'arxiv:')
        .replace(/\.pdf$/, '')
        .replace(/\s+/g, '');
      let isbn = v; if (/^[0-9][0-9-]{8,16}[0-9x]$/.test(v) && !v.includes('/')) isbn = v.replace(/-/g, '');
      let arxivId = /^arxiv:/.test(v) ? v.replace(/^arxiv:/, '') : (/^\d{4}\.\d{4,5}(v\d+)?$/.test(v) ? v : null);
      if (arxivId) arxivId = arxivId.replace(/v\d+$/, ''); // drop version so it matches the offline set and DataCite
      // 1) instant local set first (works offline, no request)
      const hit = FETCH_DB[v] || FETCH_DB[isbn] || (arxivId && FETCH_DB['arxiv:' + arxivId]);
      if (hit) { if (token === fetchToken) addResult = { ...hit, id: 'r_' + hit.citekey }; return; }
      // 2) live lookup from open libraries (CORS-friendly; arXiv resolved via its Crossref DOI)
      let ref = null;
      if (arxivId) ref = await fetchArxiv(arxivId);
      else if (/^10\.\d{4,}\//.test(v)) ref = await fetchDOI(v);
      else if (/^(97[89])?[0-9]{9}[0-9x]$/.test(isbn)) ref = await fetchISBN(isbn);
      if (token !== fetchToken) return;         // a newer request or a cancel won
      addResult = ref || false;
      if (!ref) addError = 'No match found.';
    } catch (e) {
      if (token !== fetchToken) return;
      addResult = false;
      addError = e && e.name === 'TimeoutError' ? 'Lookup timed out — check your connection and try again.' : 'Lookup failed — try again, or add it by hand.';
    } finally { if (token === fetchToken) addBusy = false; }
  }
  function addFetched() {
    if (!addResult) { adding = false; return; }
    const dup = refs.find((r) => r.id === addResult.id);
    if (dup) {
      const same = (dup.doi && dup.doi === addResult.doi) || (dup.isbn && dup.isbn === addResult.isbn) || dup.title === addResult.title;
      if (same) { selId = dup.id; filter = 'all'; adding = false; addResult = undefined; addInput = ''; addError = ''; return; } // truly already here
      let sfx = 'b'; while (refs.find((r) => r.id === addResult.id + sfx)) sfx = String.fromCharCode(sfx.charCodeAt(0) + 1); // different work, same citekey
      addResult = { ...addResult, id: addResult.id + sfx, citekey: addResult.citekey + sfx };
    }
    const added = addResult;
    refs.unshift(added); selId = added.id; filter = 'all';
    adding = false; addResult = undefined; addInput = ''; addError = '';
    attachPrompt = added;   // offer to attach a PDF/EPUB, fetch one, or skip
  }

  function copy() { try { navigator.clipboard.writeText(exportText); } catch (e) {} }
</script>

<div class="libview">
  <div class="libcol filters">
    <div class="libhead">Library · {refs.length} references</div>
    {#each FILTERS as f}
      {#if f.k === 'all' || count(f.k)}
        <button class="libfilter" class:on={filter === f.k} onclick={() => (filter = f.k)}><span>{f.l}</span><span class="ct">{count(f.k)}</span></button>
      {/if}
    {/each}
    <div class="lhrow" style="margin-top:.9rem" class:dropon={dropFolder === '__root__'}
      ondragover={(e) => { if (folderDragAllowed('')) { e.preventDefault(); dropFolder = '__root__'; } }} ondragleave={() => { if (dropFolder === '__root__') dropFolder = undefined; }}
      ondrop={() => { if (dropFolder === '__root__') onFolderDrop(''); }} role="group">
      <span class="lh" style="margin:0">{dropFolder === '__root__' ? 'Move to top level' : 'Folders'}</span>
      <button class="mini" title="New library folder" onclick={ctxNewFolder}>+ Folder</button>
    </div>
    {#if newFolderName !== null}
      <!-- svelte-ignore a11y_autofocus -->
      <input class="nfinput" autofocus placeholder={renameFolderPath != null ? 'Rename folder' : (newFolderParent ? 'Subfolder of ' + newFolderParent : 'Folder name')} bind:value={newFolderName}
        onkeydown={(e) => { if (e.key === 'Enter') commitFolderInput(); else if (e.key === 'Escape') { newFolderName = null; renameFolderPath = null; } }} onblur={commitFolderInput} />
    {/if}
    <button class="libfilter" class:on={folderFilter === null} onclick={() => (folderFilter = null)}><span>All folders</span><span class="ct">{refs.length}</span></button>
    {#each folderTree as r}
      <button class="frow" data-libfolder={r.path} class:active={folderFilter === r.path} class:dropon={dropFolder === r.path} class:dragging={dragFolder === r.path}
        style="padding-left:{6 + r.depth * 12}px" draggable="true"
        ondragstart={() => (dragFolder = r.path)} ondragend={() => { dragFolder = null; dropFolder = undefined; }}
        ondragover={(e) => { if (folderDragAllowed(r.path)) { e.preventDefault(); dropFolder = r.path; } }} ondragleave={() => { if (dropFolder === r.path) dropFolder = undefined; }}
        ondrop={() => { if (dropFolder === r.path) onFolderDrop(r.path); }}
        onclick={() => { if (folderFilter === r.path) toggleLibFolder(r.path); else { folderFilter = r.path; libCollapsed[r.path] = false; } }}>
        <span class="caret" role="button" tabindex="-1" onclick={(e) => { e.stopPropagation(); toggleLibFolder(r.path); }}>{r.hasChildren ? (r.collapsed ? '▸' : '▾') : '·'}</span><span class="fn">{r.name}</span><span class="fcount">{folderCount(r.path)}</span>
      </button>
    {/each}
    {#if hasUnfiled || dragRef}
      <button class="libfilter" class:on={folderFilter === ''} class:dropon={dropFolder === '__unfiled__'}
        ondragover={(e) => { if (dragRef) { e.preventDefault(); dropFolder = '__unfiled__'; } }} ondragleave={() => { if (dropFolder === '__unfiled__') dropFolder = undefined; }}
        ondrop={() => { if (dragRef) { assignFolder(dragRef, ''); dragRef = null; dropFolder = undefined; } }}
        onclick={() => (folderFilter = '')}><span>Unfiled</span></button>
    {/if}
    {#if uiMsg}<div class="libnote">{uiMsg}</div>{/if}
    <button class="libbtn pri" style="margin-top:.9rem" onclick={ctxNewRef}>＋ Add reference</button>
    <button class="libbtn" onclick={() => { exportScope = 'all'; }}>⇩ Export library</button>
    {#if selected.size}
      <button class="libbtn pri" onclick={() => { exportScope = 'selected'; }}>⇩ Export selected ({selected.size})</button>
      <button class="libbtn" onclick={() => (selected = new Set())}>Clear selection</button>
    {/if}
  </div>

  <div class="libcol refs">
    <div class="libsearch">
      <span class="lmag">⌕</span>
      <input placeholder="Search title, author, year, DOI, keyword…" bind:value={libQuery}
        onkeydown={(e) => { if (e.key === 'Escape') { libQuery = ''; e.currentTarget.blur(); } }} />
      {#if libQuery}<button class="libsearchx" title="Clear search" aria-label="Clear search" onclick={() => (libQuery = '')}>✕</button>{/if}
    </div>
    {#if libQuery.trim()}<div class="libsearchmeta">{filtered.length} {filtered.length === 1 ? 'match' : 'matches'}{filter !== 'all' || folderFilter != null ? ' in filter' : ''}</div>{/if}
    {#each filtered as r (r.id)}
      <button class="refrow" class:on={r.id === selId} class:sel={selected.has(r.id)} data-ref={r.id} draggable="true"
        ondragstart={() => (dragRef = r.id)} ondragend={() => { dragRef = null; dropFolder = undefined; }} onclick={() => (selId = r.id)}>
        <span class="refsel" role="checkbox" tabindex="-1" aria-checked={selected.has(r.id)} title="Select for bulk export"
          onclick={(e) => { e.stopPropagation(); toggleSel(r.id); }}>{selected.has(r.id) ? '☑' : '☐'}</span>
        <div class="rtitle"><span class="rtype">{TYPELABEL[r.type] || r.type}</span>{r.title}{#if r.attachment}<span class="attclip" title="Has a reader file">▤</span>{/if}</div>
        <div class="rmeta">{shortAuth(r.authors)} · {r.year}{r.container ? ' · ' + r.container : r.publisher ? ' · ' + r.publisher : ''}</div>
        <div class="rsrc">{#each r.sources || [] as s}<span class="sb">{s}</span>{/each}</div>
      </button>
    {:else}
      <div class="rempty" style="padding:1.2rem .2rem">{libQuery.trim() ? 'No reference matches “' + libQuery + '”.' : (refs.length ? 'No references in this view.' : 'Your library is empty — add a reference to begin.')}</div>
    {/each}
  </div>

  <div class="libcol detail">
    {#if adding}
      <div class="libhead">Add reference</div>
      <p class="rmeta">Paste a DOI, ISBN, or arXiv ID (a DOI or arXiv link works too) — Arf fetches from open libraries.</p>
      <input class="expsel" style="width:100%;margin:.4rem 0" placeholder="10.1103/… · 9780262035613 · arXiv:1706.03762" bind:value={addInput} />
      <button class="libbtn pri" onclick={doFetch} disabled={addBusy}>{addBusy ? 'Looking up…' : 'Fetch from open libraries'}</button>
      <p class="rmeta" style="margin-top:.4rem;opacity:.7">Queries Crossref (DOI · arXiv) and Open Library (ISBN).</p>
      {#if addError}<p class="rmeta" style="margin-top:.6rem">{addError} You can still add it and fill the fields by hand.</p>{/if}
      {#if addResult}
        <div class="dfield" style="margin-top:.8rem"><div class="rsrc">{#each addResult.sources as s}<span class="sb">{s}</span>{/each}</div>
          <div style="font-size:16px;color:var(--fg-bright);margin-top:.3rem">{addResult.title}</div>
          <div class="rmeta">{(addResult.authors || []).map((a) => a.g + ' ' + a.f).join(', ')} · {addResult.year}</div>
          <button class="libbtn pri" onclick={addFetched}>Add to Library</button></div>
      {/if}
      <button class="libbtn" onclick={() => { adding = false; addBusy = false; addError = ''; fetchToken++; }}>Cancel</button>
    {:else if sel}
      <div class="libhead">Reference detail</div>
      {#if attachPrompt && attachPrompt.id === sel.id && !sel.attachment}
        <div class="attachprompt">
          <div class="dl">Add a reader copy of this reference?</div>
          <p class="rmeta" style="margin:.2rem 0 .5rem">Attach a PDF / EPUB (or another reader format) to read and quote it inside Arf — or try fetching an open-access copy.</p>
          <button class="libbtn pri" onclick={() => { onattach && onattach(sel); attachPrompt = null; }}>＋ Attach a file…</button>
          <button class="libbtn" onclick={() => { onfetchpdf && onfetchpdf(sel); attachPrompt = null; }}>⇩ Fetch from open access</button>
          <button class="libbtn" onclick={() => (attachPrompt = null)}>Don't add a file</button>
        </div>
      {/if}
      <div class="dfield"><div class="dl">Title</div><div class="dv" style="font-size:18px;color:var(--fg-bright)">{sel.title}</div></div>
      <div class="dfield"><div class="dl">Authors</div><div class="dv">{(sel.authors || []).map((a) => a.g + ' ' + a.f).join(', ')}</div></div>
      <div class="dfield"><div class="dl">Type · Year</div><div class="dv">{TYPELABEL[sel.type] || sel.type} · {sel.year}</div></div>
      <div class="dfield"><div class="dl">Folder</div><div class="dv">
        <input class="expsel" style="width:100%" list="reffolders" placeholder="Unfiled — type a name, e.g. Physics/Quantum" value={sel.folder || ''} onchange={(e) => assignFolder(sel.id, e.currentTarget.value)} />
        <datalist id="reffolders">{#each refFolders as fp}<option value={fp}></option>{/each}</datalist>
      </div></div>
      {#if sel.container}<div class="dfield"><div class="dl">{sel.type === 'webpage' || sel.type === 'article-magazine' ? 'Site' : 'Published in'}</div><div class="dv">{sel.container}{sel.volume ? ' ' + sel.volume : ''}{sel.pages ? ', ' + sel.pages : ''}</div></div>{/if}
      {#if sel.publisher}<div class="dfield"><div class="dl">Publisher</div><div class="dv">{sel.publisher}</div></div>{/if}
      {#if sel.doi}<div class="dfield"><div class="dl">DOI</div><div class="dv"><a href={'https://doi.org/' + sel.doi} target="_blank" rel="noopener">{sel.doi}</a></div></div>{/if}
      {#if sel.isbn}<div class="dfield"><div class="dl">ISBN</div><div class="dv">{sel.isbn}</div></div>{/if}
      {#if sel.archived}<div class="dfield"><div class="dl">Archived snapshot · Wayback Machine</div><div class="dv"><a href={sel.archived} target="_blank" rel="noopener">web.archive.org/{sel.archivedDate}</a><br>captured {sel.archivedDate} · accessed {sel.accessed || '—'}</div></div>{/if}
      {#if sel.abstract}<div class="dfield"><div class="dl">Abstract</div><div class="dv" style="font-size:14px;color:var(--fg-muted)">{sel.abstract}</div></div>{/if}
      <div class="dfield"><div class="dl">Fetched from</div><div class="rsrc">{#each sel.sources || [] as s}<span class="sb">{s}</span>{/each}</div></div>
      <div class="dfield"><div class="dl">Reader copy</div><div class="dv">
        {#if sel.attachment}
          <div class="rsrc" style="margin:0 0 .4rem"><span class="sb">{(sel.attachment.kind || 'file').toUpperCase()}</span> {sel.attachment.name}</div>
          <button class="libbtn" style="width:auto;padding:.35rem .8rem" onclick={() => onopenreader && onopenreader(sel)}>▤ Open in reader</button>
          <button class="libbtn" style="margin-top:.4rem" onclick={() => ondetach && ondetach(sel)}>Remove attachment</button>
        {:else}
          <button class="libbtn" onclick={() => onattach && onattach(sel)}>＋ Attach PDF / EPUB…</button>
          <button class="libbtn" onclick={() => onfetchpdf && onfetchpdf(sel)}>⇩ Fetch open-access PDF</button>
          {#if sel.abstract}<button class="libbtn" onclick={() => onopenreader && onopenreader(sel)}>▤ Read abstract</button>{/if}
          {#if !hasVault}<p class="rmeta" style="margin-top:.3rem;opacity:.7">Files are saved in your vault folder — open one in the desktop app to attach.</p>{/if}
        {/if}
      </div></div>
      <div class="dfield"><div class="dl">Cite in a note</div><div class="dv"><button class="libbtn" style="width:auto;padding:.35rem .8rem" onclick={() => copyCite(sel)}>Copy [@{sel.citekey}]</button></div></div>
      <button class="libbtn pri" onclick={() => (exportScope = sel.id)}>⇩ Export this reference</button>
      <button class="libbtn" style="margin-top:.5rem;color:var(--danger,#c0392b)" onclick={deleteRef}>Delete reference</button>
    {:else}<div class="rempty">Select a reference.</div>{/if}
  </div>
</div>

{#if exportScope}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) exportScope = null; }}>
    <div class="modal">
      <button class="dlg-x" onclick={() => (exportScope = null)}>✕</button>
      <h3>Export references</h3>
      <p class="msub">Every format your tools need — BibTeX, RIS for EndNote, CSL-JSON, formatted styles, Zenodo.</p>
      <div style="display:flex;gap:.6rem;align-items:center">
        <select class="expsel" bind:value={expFmt}>{#each ['BibTeX', 'RIS (EndNote)', 'CSL-JSON', 'APA', 'Nature', 'Zenodo'] as f}<option>{f}</option>{/each}</select>
        <span class="rmeta">{exportRefs.length} {exportRefs.length === 1 ? 'reference' : 'references'}</span>
        <button class="libbtn" style="width:auto;margin:0 0 0 auto;padding:.35rem .8rem" onclick={copy}>Copy</button>
      </div>
      <textarea class="exparea" readonly>{exportText}</textarea>
    </div>
  </div>
{/if}

{#if movePick}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) movePick = null; }}>
    <div class="palette">
      <div class="pg" style="padding:.7rem .9rem .3rem">Move folder to…</div>
      <div class="presults">
        {#each moveDestinations(movePick.src) as dest}
          <button class="prow" onclick={() => doMovePick(dest)}><span class="pt">{dest === '' ? '↑ Top level' : dest}</span></button>
        {/each}
      </div>
    </div>
  </div>
{/if}
