<script>
  import { shortAuth, joinRefs } from './cite.js';
  import { folderList, canonFolder } from './folders.js';
  let { notes, idx, onopen, refs = $bindable([]), jumpTo = null, onjumped = null, onrefsdelete = null } = $props();

  const TYPELABEL = { 'article-journal': 'Article', 'article-magazine': 'Magazine', book: 'Book', preprint: 'Preprint', dataset: 'Dataset', webpage: 'Web' };
  const FILTERS = [
    { k: 'all', l: 'All' }, { k: 'article-journal', l: 'Articles' }, { k: 'book', l: 'Books' },
    { k: 'article-magazine', l: 'Magazines' }, { k: 'webpage', l: 'Webpages' }, { k: 'preprint', l: 'Preprints' },
  ];

  let filter = $state('all');
  let folderFilter = $state(null);   // null = all folders; '' = unfiled; else a folder path (matches it + subfolders)
  let dragRef = $state(null);        // id of the reference row being dragged onto a folder
  let dropFolder = $state(undefined);// folder currently hovered as a drop target ('' = unfiled)
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
  let exportScope = $state(null); // refId | 'all' | null
  let expFmt = $state('BibTeX');
  let adding = $state(false);
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
  const hasUnfiled = $derived(refs.some((r) => !canonFolder(r.folder)));
  const inFolder = (r) => { if (folderFilter == null) return true; const f = canonFolder(r.folder); return folderFilter === '' ? !f : (f === folderFilter || f.startsWith(folderFilter + '/')); };
  const filtered = $derived(refs.filter((r) => (filter === 'all' || r.type === filter) && inFolder(r)));
  const sel = $derived(refs.find((r) => r.id === selId) ?? null);
  // assign the selected reference to a folder (creates the folder by naming it; '' = unfiled)
  function assignFolder(id, v) {
    const path = canonFolder(v);
    refs = refs.map((r) => r.id === id ? { ...r, folder: path } : r);
  }
  function folderCount(p) { return refs.filter((r) => { const f = canonFolder(r.folder); return f === p || f.startsWith(p + '/'); }).length; }
  const exportRefs = $derived(exportScope === 'all' ? refs : refs.filter((r) => r.id === exportScope));
  const exportText = $derived(joinRefs(exportRefs, expFmt));

  function count(k) { return k === 'all' ? refs.length : refs.filter((r) => r.type === k).length; }

  function mkCitekey(authors, year) {
    const base = (authors && authors[0] && authors[0].f ? authors[0].f : 'ref').toLowerCase().replace(/[^a-z0-9]/g, '') || 'ref';
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
    refs.unshift(addResult); selId = addResult.id; filter = 'all';
    adding = false; addResult = undefined; addInput = ''; addError = '';
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
    {#if refFolders.length || hasUnfiled || dragRef}
      <div class="libhead" style="margin-top:.9rem">Folders</div>
      <button class="libfilter" class:on={folderFilter === null} onclick={() => (folderFilter = null)}><span>All folders</span></button>
      {#each refFolders as fp}
        <button class="libfilter" class:on={folderFilter === fp} class:dropon={dropFolder === fp}
          ondragover={(e) => { if (dragRef) { e.preventDefault(); dropFolder = fp; } }} ondragleave={() => { if (dropFolder === fp) dropFolder = undefined; }}
          ondrop={() => { if (dragRef) { assignFolder(dragRef, fp); dragRef = null; dropFolder = undefined; } }}
          onclick={() => (folderFilter = fp)}><span>{fp}</span><span class="ct">{folderCount(fp)}</span></button>
      {/each}
      <button class="libfilter" class:on={folderFilter === ''} class:dropon={dropFolder === ''}
        ondragover={(e) => { if (dragRef) { e.preventDefault(); dropFolder = ''; } }} ondragleave={() => { if (dropFolder === '') dropFolder = undefined; }}
        ondrop={() => { if (dragRef) { assignFolder(dragRef, ''); dragRef = null; dropFolder = undefined; } }}
        onclick={() => (folderFilter = '')}><span>Unfiled</span></button>
    {/if}
    <button class="libbtn pri" style="margin-top:.9rem" onclick={() => { adding = true; addResult = undefined; addInput = ''; addError = ''; addBusy = false; fetchToken++; }}>＋ Add reference</button>
    <button class="libbtn" onclick={() => { exportScope = 'all'; }}>⇩ Export library</button>
  </div>

  <div class="libcol refs">
    {#each filtered as r (r.id)}
      <button class="refrow" class:on={r.id === selId} data-ref={r.id} draggable="true"
        ondragstart={() => (dragRef = r.id)} ondragend={() => { dragRef = null; dropFolder = undefined; }} onclick={() => (selId = r.id)}>
        <div class="rtitle"><span class="rtype">{TYPELABEL[r.type] || r.type}</span>{r.title}</div>
        <div class="rmeta">{shortAuth(r.authors)} · {r.year}{r.container ? ' · ' + r.container : r.publisher ? ' · ' + r.publisher : ''}</div>
        <div class="rsrc">{#each r.sources || [] as s}<span class="sb">{s}</span>{/each}</div>
      </button>
    {/each}
  </div>

  <div class="libcol detail">
    {#if adding}
      <div class="libhead">Add reference</div>
      <p class="rmeta">Paste a DOI, ISBN, arXiv ID, or URL — Arf fetches from open libraries.</p>
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
