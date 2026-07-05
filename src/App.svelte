<script>
  import { loadNotes, saveNotes, newNote, toMarkdown, loadFolders, saveFolders } from './lib/vault.js';
  import { buildFolderRows, folderList } from './lib/folders.js';
  import { buildIndex, buildVectors, related, hasLinks, digestPairs } from './lib/graphindex.js';
  import { renderMarkdown, setLinkResolver } from './lib/markdown.js';
  import { initEmbedder, embedNotes, cosine as mlCosine } from './lib/ml.js';
  import Editor from './lib/Editor.svelte';
  import GraphView from './lib/GraphView.svelte';
  import Library from './lib/Library.svelte';

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
  const MOD = IS_MAC ? '⌘' : 'Ctrl';

  let notes = $state(loadNotes());
  let currentId = $state(notes[0]?.id ?? null);
  let mode = $state('read');            // 'read' | 'write'
  let theme = $state(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  let view = $state('notes');           // 'notes' | 'library'
  let tagFilter = $state(null);
  let vecs = $state({});          // TF-IDF fallback vectors (instant)
  let mlEnabled = $state((() => { try { return localStorage.getItem('arf-ml') === '1'; } catch (e) { return false; } })());
  let mlStatus = $state('off');   // off | loading | ready | error
  let mlPct = $state(0);
  let mlVecs = $state({});         // MiniLM embeddings (id -> 384-dim), when ready
  let saved = $state(false);
  let paletteOpen = $state(false);
  let digestOpen = $state(false);
  let graphFull = $state(false);
  let focus = $state(false);
  let drawer = $state(false); // (legacy, unused on mobile now)
  let isMobile = $state(typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches);
  let mtab = $state('notes');     // mobile bottom tab: notes | search | graph | library
  let mNoteOpen = $state(false);  // mobile: viewing a note vs the list
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

  // track viewport so we render the mobile app vs the desktop panes
  $effect(() => {
    const mq = matchMedia('(max-width: 760px)');
    const u = () => (isMobile = mq.matches);
    u(); mq.addEventListener('change', u);
    return () => mq.removeEventListener('change', u);
  });

  const idx = $derived(buildIndex(notes));
  const current = $derived(notes.find((n) => n.id === currentId) ?? null);
  const backlinks = $derived((idx.back[currentId] || []).map((id) => idx.byId[id]).filter(Boolean));
  const readHTML = $derived.by(() => {
    const byTitle = idx.byTitle;                 // depend on the title index
    setLinkResolver((t) => byTitle[t] || null);  // resolve wikilinks before parsing
    return current ? renderMarkdown(current.body) : '';
  });
  const allTags = $derived(Object.keys(idx.tagIndex).sort());
  const listNotes = $derived(tagFilter ? notes.filter((n) => (idx.noteTags[n.id] || []).includes(tagFilter)) : notes);
  const folderRows = $derived(buildFolderRows(folders, notes, collapsed));
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
    vecTimer = setTimeout(() => { vecs = buildVectors(notes); }, 350);
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
    });
  }
  function enableML() { mlEnabled = true; try { localStorage.setItem('arf-ml', '1'); } catch (e) {} startML(); }
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
  let flashTimer, saveTimer;
  function writeNow() {
    const ok = saveNotes(notes);
    saveError = !ok;
    if (ok) { saved = true; clearTimeout(flashTimer); flashTimer = setTimeout(() => (saved = false), 800); }
  }
  function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 400); }
  function flushSave() { clearTimeout(saveTimer); writeNow(); }
  // converge across tabs: pick up another tab's writes instead of clobbering them
  $effect(() => {
    const h = (e) => { if (e.key === 'arf-vault-v0' && e.newValue) { try { notes = JSON.parse(e.newValue); } catch (x) {} } };
    window.addEventListener('storage', h);
    window.addEventListener('beforeunload', flushSave);
    return () => { window.removeEventListener('storage', h); window.removeEventListener('beforeunload', flushSave); };
  });
  function editBody(v) { const n = notes.find((x) => x.id === currentId); if (!n) return; n.body = v; n.updated = new Date().toISOString(); persist(); }
  function editTitle(v) { const n = notes.find((x) => x.id === currentId); if (!n) return; n.title = v; n.updated = new Date().toISOString(); persist(); }
  function create() { const n = newNote(activeFolder); notes.unshift(n); currentId = n.id; mode = 'write'; view = 'notes'; persist(); if (isMobile) { mtab = 'notes'; mNoteOpen = true; } }
  function addFolder() {
    const raw = (newFolderName || '').trim(); newFolderName = null;
    if (!raw) return;
    const name = raw.replace(/\//g, '-');
    const path = activeFolder ? activeFolder + '/' + name : name;
    if (!folders.includes(path)) folders.push(path);
    saveFolders(folders); collapsed[activeFolder] = false;
  }
  function toggleFolder(path) { collapsed[path] = !collapsed[path]; }
  function moveNote(id, folder) { const n = notes.find((x) => x.id === id); if (n) { n.folder = folder; n.updated = new Date().toISOString(); persist(); } }

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
  function download(name, mime, text) { const a = document.createElement('a'); a.href = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(text); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function doExport() {
    const n = current; if (!n) return;
    const slug = (n.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'note';
    if (deFmt === 'Markdown') download(slug + '.md', 'text/markdown', toMarkdown(n));
    else if (deFmt === 'HTML') download(slug + '.html', 'text/html', exportHTML(n));
    else { const w = window.open('', '_blank'); if (w) { w.document.write(exportHTML(n)); w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 350); } }
    docExport = false;
  }
  function open(id) { if (!idx.byId[id]) return; flushSave(); currentId = id; mode = 'read'; view = 'notes'; paletteOpen = false; graphFull = false; drawer = false; if (isMobile) { mtab = 'notes'; mNoteOpen = true; } }
  function firstLine(b) { const l = (b || '').split('\n').find((x) => x.trim()); return l ? l.replace(/[#>*`\[\]]/g, '').slice(0, 52) : 'Empty note'; }
  function invDot(id) { return hasLinks(id, idx) ? '●' : '○'; }
  function dotTitle(id) { return hasLinks(id, idx) ? 'Linked to other notes' : 'Orphan — not linked to any note yet'; }

  function toggleTheme() { theme = theme === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', theme); try { localStorage.setItem('arf-theme', theme); } catch (e) {} }
  function linkPair(aId, bId) {
    const a = idx.byId[aId], b = idx.byId[bId]; if (!a || !b) return;
    const s = window.prompt('Write the sentence that connects “' + a.title + '” and “' + b.title + '”:', '');
    if (s === null) return; // cancelled — do not fake the connection
    const line = s.trim() ? s.trim().replace(/\.?$/, '') + ' — see [[' + b.title + ']].' : 'Related to [[' + b.title + ']].';
    a.body = (a.body || '').trimEnd() + '\n\n' + line; a.updated = new Date().toISOString(); flushSave();
  }

  // read-view delegation
  function readClick(e) {
    const nav = e.target.closest('[data-nav]'); if (nav) { e.preventDefault(); open(nav.getAttribute('data-nav')); return; }
    const tg = e.target.closest('[data-tag]'); if (tg) { e.preventDefault(); tagFilter = tg.getAttribute('data-tag'); return; }
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
    if (mlStatus === 'ready' && Object.keys(mlVecs).length) {
      const pairs = [];
      for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) {
        const a = notes[i], b = notes[j];
        if (!mlVecs[a.id] || !mlVecs[b.id]) continue;
        if ((idx.fwd[a.id] || []).includes(b.id) || (idx.fwd[b.id] || []).includes(a.id)) continue;
        const s = mlCosine(mlVecs[a.id], mlVecs[b.id]);
        if (s >= 0.45) pairs.push({ a: a.id, b: b.id, s });
      }
      return pairs.sort((x, y) => y.s - x.s).slice(0, 6);
    }
    return digestPairs(notes, vecs, idx, { max: 6 });
  });

  function onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen = true; query = ''; }
    else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); if (view === 'notes') mode = mode === 'read' ? 'write' : 'read'; }
    else if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); graphFull = !graphFull; }
    else if (e.key === 'Escape') { paletteOpen = false; digestOpen = false; graphFull = false; focus = false; }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if isMobile}
  <div class="mapp">
    <header class="mtop">
      {#if mtab === 'notes' && mNoteOpen && current}
        <button class="micon back" aria-label="Back to notes" onclick={() => (mNoteOpen = false)}>‹</button>
        <div class="mseg">
          <button class:on={mode === 'read'} onclick={() => (mode = 'read')}>Read</button>
          <button class:on={mode === 'write'} onclick={() => (mode = 'write')}>Write</button>
        </div>
        <span class="msp"></span>
        <button class="micon" aria-label="Export note" onclick={() => (docExport = true)}>⇩</button>
      {:else if mtab === 'search'}
        <span class="mmag">⌕</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="msearchin" autofocus placeholder="Search notes, tags, ideas…" bind:value={query} />
        {#if query}<button class="micon" aria-label="Clear" onclick={() => (query = '')}>✕</button>{/if}
      {:else}
        <span class="mwm">{mtab === 'graph' ? 'Graph' : mtab === 'library' ? 'Library' : 'Arf'}{#if mtab === 'notes'}<span class="dot">.</span>{/if}</span>
        <span class="msp"></span>
        {#if mtab === 'notes'}<button class="micon" aria-label="Weekly synthesis" onclick={() => (digestOpen = true)}>◇</button>{/if}
        <button class="micon" aria-label="Light / dark" onclick={toggleTheme}>◑</button>
      {/if}
    </header>

    {#if saveError}<div class="savebanner">⚠ Couldn’t save — storage may be full. Export this note now.</div>{/if}

    <main class="mbody" class:nopad={mtab === 'graph'}>
      {#if mtab === 'notes' && mNoteOpen && current}
        <div class="mnote">
          <div class="mcrumbs">
            <select class="fmove" value={current.folder || ''} onchange={(e) => moveNote(current.id, e.currentTarget.value)}>
              <option value="">(root)</option>{#each allFolders as f}<option value={f}>{f}</option>{/each}
            </select>
            {#if (current.tags || []).length}<span class="ctags"> · #{current.tags.join('  #')}</span>{/if}
            {#if saved}<span class="saved">saved</span>{/if}
          </div>
          {#if mode === 'write'}
            <input class="mtitle" value={current.title} oninput={(e) => editTitle(e.currentTarget.value)} aria-label="title" />
            {#key currentId}<div class="meditor"><Editor value={current.body} onchange={editBody} /></div>{/key}
          {:else}
            <h1 class="mtitle ro">{current.title}<span class="inv" class:orphan={invDot(current.id) === '○'}>{invDot(current.id)}</span></h1>
            <div class="read mread" onclick={readClick}>{@html readHTML}</div>
            <div class="mconn">
              <div class="rh">Referenced in <span>{backlinks.length}</span></div>
              {#if backlinks.length}{#each backlinks as b}<button class="ref" onclick={() => open(b.id)}>{b.title}</button>{/each}{:else}<div class="rempty">No backlinks yet.</div>{/if}
              <div class="rh" style="margin-top:1.1rem">Resonance · {mlStatus === 'ready' ? 'MiniLM' : 'on-device'}
                {#if mlStatus === 'off'}<button class="mltoggle" onclick={enableML}>enable AI</button>
                {:else if mlStatus === 'loading'}<span class="mlstat">↓ {mlPct}%</span>
                {:else if mlStatus === 'ready'}<span class="mlstat ok">✓</span>{/if}
              </div>
              {#if resonance.length}{#each resonance as r}<button class="ref ml" onclick={() => open(r.note.id)}><span class="sim">{r.s.toFixed(2)}</span><span class="nm">{r.note.title}</span></button>{/each}{:else}<div class="rempty">Nothing close enough yet.</div>{/if}
              <button class="mconnbtn" onclick={() => (mtab = 'graph')}>✧&nbsp; See this note in the graph</button>
            </div>
          {/if}
        </div>
      {:else if mtab === 'notes'}
        <div class="mlist">
          <div class="lhrow"><span class="lh">Vault · {notes.length}</span>
            <button class="mini" onclick={() => (newFolderName = '')}>＋ Folder</button></div>
          {#if newFolderName !== null}
            <!-- svelte-ignore a11y_autofocus -->
            <input class="nfinput" autofocus placeholder={activeFolder ? 'Subfolder of ' + activeFolder : 'Folder name'} bind:value={newFolderName}
              onkeydown={(e) => { if (e.key === 'Enter') addFolder(); else if (e.key === 'Escape') newFolderName = null; }} onblur={addFolder} />
          {/if}
          {#if tagFilter}
            <button class="clearfilter" onclick={() => (tagFilter = null)}>← clear #{tagFilter}</button>
            {#each listNotes as n (n.id)}
              <button class="mitem" onclick={() => open(n.id)}><span class="dot2" class:orphan={invDot(n.id) === '○'}>{invDot(n.id)}</span><span class="t">{n.title || 'Untitled'}</span></button>
            {/each}
          {:else}
            {#each folderRows as r}
              {#if r.type === 'folder'}
                <button class="mfrow" style="padding-left:{8 + r.depth * 14}px" onclick={() => { toggleFolder(r.path); activeFolder = r.path; }}>
                  <span class="caret">{r.hasChildren ? (r.collapsed ? '▸' : '▾') : '·'}</span><span class="fn">{r.name}</span>{#if r.count}<span class="fcount">{r.count}</span>{/if}
                </button>
              {:else}
                <button class="mitem" style="padding-left:{8 + r.depth * 14}px" onclick={() => open(r.note.id)}><span class="dot2" class:orphan={invDot(r.note.id) === '○'}>{invDot(r.note.id)}</span><span class="t">{r.note.title || 'Untitled'}</span></button>
              {/if}
            {/each}
          {/if}
          {#if allTags.length}
            <div class="lh" style="margin-top:1.1rem">Tags</div>
            <div class="tags">{#each allTags as t}<button class="tag" class:on={tagFilter === t} onclick={() => (tagFilter = tagFilter === t ? null : t)}>#{t}</button>{/each}</div>
          {/if}
        </div>
        <button class="fab" aria-label="New note" onclick={create}>＋</button>
      {:else if mtab === 'search'}
        <div class="msearch">
          {#each palItems.lex as l}
            <button class="mitem" onclick={() => open(l.id)}><span class="dot2" class:orphan={invDot(l.id) === '○'}>{invDot(l.id)}</span><span class="txt"><span class="t">{idx.byId[l.id].title}</span>{#if l.why}<span class="s">{l.why}</span>{/if}</span></button>
          {:else}<div class="rempty" style="padding:2.5rem 1rem;text-align:center">{query ? 'No matches.' : 'Search your vault by title, tag, or text.'}</div>{/each}
          {#if palItems.sem.length}
            <div class="lh" style="padding:.7rem 1rem .3rem">Related · on-device</div>
            {#each palItems.sem as s}<button class="mitem" onclick={() => open(s.id)}><span class="dot2 sem">◈</span><span class="txt"><span class="t i">{idx.byId[s.id].title}</span><span class="s">{s.s.toFixed(2)}</span></span></button>{/each}
          {/if}
        </div>
      {:else if mtab === 'graph'}
        <div class="mgraphwrap"><GraphView {notes} {idx} centerId={currentId} mode="full" onopen={open} /></div>
      {:else if mtab === 'library'}
        <Library {notes} {idx} onopen={open} />
      {/if}
    </main>

    <nav class="mnav">
      <button class="mnavt" class:on={mtab === 'notes'} onclick={() => { mtab = 'notes'; mNoteOpen = false; }}><span class="ic">☰</span>Notes</button>
      <button class="mnavt" class:on={mtab === 'search'} onclick={() => { mtab = 'search'; query = ''; }}><span class="ic">⌕</span>Search</button>
      <button class="mnavt" class:on={mtab === 'graph'} onclick={() => (mtab = 'graph')}><span class="ic">✧</span>Graph</button>
      <button class="mnavt" class:on={mtab === 'library'} onclick={() => (mtab = 'library')}><span class="ic">▤</span>Library</button>
    </nav>
  </div>
{:else}
<div class="shell" class:focus={focus} class:drawer={drawer}>
  <header class="top">
    <button class="menubtn" aria-label="Menu" onclick={() => (drawer = !drawer)}>☰</button>
    <button class="wm" onclick={() => (view = 'notes')}>Arf<span class="dot">.</span></button>
    <div class="viewtoggle">
      <button class:on={view === 'notes'} onclick={() => (view = 'notes')}>Notes</button>
      <button class:on={view === 'library'} onclick={() => (view = 'library')}>Library</button>
    </div>
    <span class="sp"></span>
    <button class="searchpill" onclick={() => { paletteOpen = true; query = ''; }}>
      <span class="mag">⌕</span><span class="lbl">Search</span><kbd>{MOD} K</kbd>
    </button>
    <div class="iconbar">
      <button class="ic" title="Weekly synthesis" aria-label="Synthesis" onclick={() => (digestOpen = true)}>◇</button>
      <button class="ic" title="Knowledge graph" aria-label="Graph" onclick={() => (graphFull = true)}>✧</button>
      <button class="ic" class:on={focus} title="Focus mode" aria-label="Focus" onclick={() => (focus = !focus)}>◎</button>
      <button class="ic" title="Light / dark" aria-label="Theme" onclick={toggleTheme}>◑</button>
    </div>
    <button class="newbtn" onclick={create}>＋&nbsp;New</button>
  </header>

  {#if saveError}
    <div class="savebanner">⚠ Couldn’t save — your browser storage may be full or blocked. Export this note now to avoid losing it.</div>
  {/if}

  <button class="drawerback" aria-label="Close menu" onclick={() => (drawer = false)}></button>

  {#if view === 'library'}
    <Library {notes} {idx} onopen={open} />
  {:else}
    <div class="ws">
      <aside class="list">
        <div class="mobileacts">
          <button class:on={view === 'notes'} onclick={() => { view = 'notes'; drawer = false; }}>Notes</button>
          <button class:on={view === 'library'} onclick={() => { view = 'library'; drawer = false; }}>Library</button>
          <span class="mspacer"></span>
          <button aria-label="Synthesis" onclick={() => { digestOpen = true; drawer = false; }}>◇</button>
          <button aria-label="Graph" onclick={() => { graphFull = true; drawer = false; }}>✧</button>
          <button aria-label="Focus" class:on={focus} onclick={() => { focus = !focus; drawer = false; }}>◎</button>
          <button aria-label="Theme" onclick={toggleTheme}>◑</button>
        </div>
        <div class="lhrow"><span class="lh">Vault · {notes.length}</span>
          <button class="mini" title="New folder" onclick={() => (newFolderName = '')}>＋ Folder</button></div>
        {#if newFolderName !== null}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="nfinput" autofocus placeholder={activeFolder ? 'Subfolder of ' + activeFolder : 'Folder name'} bind:value={newFolderName}
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
            {#each allTags as t}
              <button class="tag" class:on={tagFilter === t} onclick={() => (tagFilter = tagFilter === t ? null : t)}>#{t}</button>
            {/each}
          </div>
        {/if}
      </aside>

      <main class="center">
        {#if current}
          <div class="crumbs">
            <select class="fmove" value={current.folder || ''} onchange={(e) => moveNote(current.id, e.currentTarget.value)} title="Move to folder">
              <option value="">(root)</option>
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
            <div class="seg">
              <button class:on={mode === 'read'} onclick={() => (mode = 'read')}>Read</button>
              <button class:on={mode === 'write'} onclick={() => (mode = 'write')}>Write</button>
            </div>
            <button class="expbtn" title="Export this note" aria-label="Export" onclick={() => (docExport = true)}>⇩</button>
          </div>
          {#if mode === 'write'}
            {#key currentId}<div class="editor"><Editor value={current.body} onchange={editBody} /></div>{/key}
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

{#if graphFull && !isMobile}
  <div class="overlay">
    <div class="ovhead"><h3>Knowledge graph</h3><span class="hint">scroll = zoom · drag background = pan · drag node = move · click = open · {MOD}+right-click = select</span><span class="sp"></span><button class="ovclose" onclick={() => (graphFull = false)}>✕ Close</button></div>
    <GraphView {notes} {idx} centerId={currentId} mode="full" onopen={open} />
  </div>
{/if}

{#if paletteOpen && !isMobile}
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
      <div class="optrow"><label for="de-margin">Margins</label><select id="de-margin" class="expsel" bind:value={deMargin}><option>Narrow</option><option>Normal</option><option>Wide</option></select></div>
      <div class="optrow"><label for="de-t">Include title heading</label><input id="de-t" type="checkbox" bind:checked={deOpts.title} /></div>
      <div class="optrow"><label for="de-n">Number section headings</label><input id="de-n" type="checkbox" bind:checked={deOpts.numberHeadings} /></div>
      <div class="optrow"><label for="de-k">Keep headings with their text (no orphans)</label><input id="de-k" type="checkbox" bind:checked={deOpts.keepHeadings} /></div>
      <div class="optrow"><label for="de-i">Fit images &amp; code to the page (no out-scaling)</label><input id="de-i" type="checkbox" bind:checked={deOpts.fitImages} /></div>
      <button class="libbtn pri" onclick={doExport}>Export as {deFmt}</button>
    </div>
  </div>
{/if}

{#if digestOpen}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) digestOpen = false; }}>
    <div class="modal">
      <button class="mclose" onclick={() => (digestOpen = false)}>✕</button>
      <h3>This week's synthesis</h3>
      <p class="msub">Pairs of notes that resemble each other but you've never linked. Write the sentence that connects them.</p>
      <div class="mbody">
        {#each digest as p}
          <div class="pair"><span class="txt"><button class="a" onclick={() => open(p.a)}>{idx.byId[p.a].title}</button> <span class="mid">might connect to</span> <button class="a" onclick={() => open(p.b)}>{idx.byId[p.b].title}</button></span><span class="psim">{p.s.toFixed(2)}</span><button class="link" onclick={() => linkPair(p.a, p.b)}>Link</button></div>
        {:else}<div class="rempty" style="padding:1rem 0">Everything similar is already linked. Good week.</div>{/each}
      </div>
    </div>
  </div>
{/if}

