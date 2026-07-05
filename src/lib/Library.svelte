<script>
  let { notes, idx, onopen } = $props();

  const TYPELABEL = { 'article-journal': 'Article', 'article-magazine': 'Magazine', book: 'Book', preprint: 'Preprint', dataset: 'Dataset', webpage: 'Web' };
  const FILTERS = [
    { k: 'all', l: 'All' }, { k: 'article-journal', l: 'Articles' }, { k: 'book', l: 'Books' },
    { k: 'article-magazine', l: 'Magazines' }, { k: 'webpage', l: 'Webpages' }, { k: 'preprint', l: 'Preprints' },
  ];

  let refs = $state([
    { id: 'r_zurek2003', type: 'article-journal', citekey: 'zurek2003', title: 'Decoherence, einselection, and the quantum origins of the classical', authors: [{ f: 'Zurek', g: 'Wojciech H.' }], year: 2003, container: 'Reviews of Modern Physics', volume: '75', pages: '715–775', doi: '10.1103/RevModPhys.75.715', abstract: 'Decoherence, einselection, and the existential interpretation are described.', sources: ['Crossref', 'OpenAlex'] },
    { id: 'r_arf1941', type: 'article-journal', citekey: 'arf1941', title: 'Untersuchungen über quadratische Formen in Körpern der Charakteristik 2', authors: [{ f: 'Arf', g: 'Cahit' }], year: 1941, container: 'Journal für die reine und angewandte Mathematik', volume: '183', pages: '148–167', doi: '10.1515/crll.1941.183.148', sources: ['Crossref'] },
    { id: 'r_efron1979', type: 'article-journal', citekey: 'efron1979', title: 'Bootstrap Methods: Another Look at the Jackknife', authors: [{ f: 'Efron', g: 'Bradley' }], year: 1979, container: 'The Annals of Statistics', volume: '7', pages: '1–26', doi: '10.1214/aos/1176344552', sources: ['Crossref', 'OpenAlex'] },
    { id: 'r_deutsch2011', type: 'book', citekey: 'deutsch2011', title: 'The Beginning of Infinity', authors: [{ f: 'Deutsch', g: 'David' }], year: 2011, publisher: 'Viking', isbn: '9780670022755', sources: ['Open Library', 'Google Books'] },
    { id: 'r_ahrens2017', type: 'book', citekey: 'ahrens2017', title: 'How to Take Smart Notes', authors: [{ f: 'Ahrens', g: 'Sönke' }], year: 2017, publisher: 'CreateSpace', isbn: '9781542866507', sources: ['Open Library'] },
    { id: 'r_sep_dec', type: 'webpage', citekey: 'sep2020decoherence', title: 'The Role of Decoherence in Quantum Mechanics', authors: [{ f: 'Bacciagaluppi', g: 'Guido' }], year: 2020, container: 'Stanford Encyclopedia of Philosophy', url: 'https://plato.stanford.edu/entries/qm-decoherence/', accessed: '2026-06-28', archived: 'https://web.archive.org/web/20260601120000/https://plato.stanford.edu/entries/qm-decoherence/', archivedDate: '2026-06-01', sources: ['Wayback Machine', 'Manual'] },
    { id: 'r_quanta', type: 'article-magazine', citekey: 'wolchover2019', title: 'Quantum Darwinism, an Idea to Explain Objective Reality, Passes First Tests', authors: [{ f: 'Wolchover', g: 'Natalie' }], year: 2019, container: 'Quanta Magazine', url: 'https://www.quantamagazine.org/', accessed: '2026-06-20', archived: 'https://web.archive.org/web/20260520090000/https://www.quantamagazine.org/', archivedDate: '2026-05-20', sources: ['Wayback Machine'] },
  ]);
  let filter = $state('all');
  let selId = $state(refs[0].id);
  let exportScope = $state(null); // refId | 'all' | null
  let expFmt = $state('BibTeX');
  let adding = $state(false);
  let addInput = $state('');
  let addResult = $state(undefined);

  const FETCH_DB = {
    '9780262035613': { type: 'book', citekey: 'goodfellow2016', title: 'Deep Learning', authors: [{ f: 'Goodfellow', g: 'Ian' }, { f: 'Bengio', g: 'Yoshua' }, { f: 'Courville', g: 'Aaron' }], year: 2016, publisher: 'MIT Press', isbn: '9780262035613', sources: ['Open Library', 'Google Books'] },
    'arxiv:1706.03762': { type: 'preprint', citekey: 'vaswani2017', title: 'Attention Is All You Need', authors: [{ f: 'Vaswani', g: 'Ashish' }], year: 2017, container: 'arXiv', doi: '10.48550/arXiv.1706.03762', sources: ['arXiv', 'Semantic Scholar'] },
    '10.1103/physrevd.23.347': { type: 'article-journal', citekey: 'guth1981', title: 'Inflationary universe: A possible solution to the horizon and flatness problems', authors: [{ f: 'Guth', g: 'Alan H.' }], year: 1981, container: 'Physical Review D', volume: '23', pages: '347–356', doi: '10.1103/PhysRevD.23.347', sources: ['Crossref', 'OpenAlex'] },
  };

  const filtered = $derived(refs.filter((r) => filter === 'all' || r.type === filter));
  const sel = $derived(refs.find((r) => r.id === selId) ?? null);
  const exportRefs = $derived(exportScope === 'all' ? refs : refs.filter((r) => r.id === exportScope));
  const exportText = $derived.by(() => {
    const list = exportRefs;
    const j = (expFmt === 'CSL-JSON' || expFmt === 'Zenodo') ? ',\n' : '\n\n';
    let t = list.map((r) => exportOne(r, expFmt)).join(j);
    if (expFmt === 'CSL-JSON' || expFmt === 'Zenodo') t = '[\n' + t + '\n]';
    return t;
  });

  function shortAuth(a) { return !a.length ? '' : a.length === 1 ? a[0].f : a.length === 2 ? a[0].f + ' & ' + a[1].f : a[0].f + ' et al.'; }
  function initials(g) { return g.split(/\s+/).map((x) => x[0] + '.').join(' '); }
  function count(k) { return k === 'all' ? refs.length : refs.filter((r) => r.type === k).length; }

  function doFetch() {
    let v = addInput.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/\s+/g, '');
    if (/^arxiv:/.test(v)) v = 'arxiv:' + v.replace(/^arxiv:/, '');
    // strip separators from ISBN-shaped input ("978-0-262-03561-3") but leave DOIs/URLs alone
    if (/^[0-9][0-9-]{8,16}[0-9x]$/.test(v) && !v.includes('/')) v = v.replace(/-/g, '');
    const hit = FETCH_DB[v];
    if (hit) { addResult = { ...hit, id: 'r_' + hit.citekey }; } else { addResult = false; }
  }
  function addFetched() { if (addResult && !refs.find((r) => r.id === addResult.id)) { refs.unshift(addResult); selId = addResult.id; filter = 'all'; } adding = false; addResult = undefined; addInput = ''; }

  // export generators
  function bibType(t) { return t === 'book' ? 'book' : t === 'preprint' ? 'misc' : (t === 'webpage' || t === 'article-magazine') ? 'online' : 'article'; }
  function escBib(s) { return String(s == null ? '' : s).replace(/([%&#_${}])/g, '\\$1').replace(/\^/g, '\\^{}').replace(/~/g, '\\~{}'); }
  function toBibTeX(r) { const f = ['  author = {' + r.authors.map((a) => escBib(a.f) + ', ' + escBib(a.g)).join(' and ') + '}', '  title = {' + escBib(r.title) + '}', '  year = {' + r.year + '}']; if (r.container) f.push('  ' + (r.type === 'book' ? 'publisher' : 'journal') + ' = {' + escBib(r.container) + '}'); if (r.publisher && !r.container) f.push('  publisher = {' + escBib(r.publisher) + '}'); if (r.volume) f.push('  volume = {' + r.volume + '}'); if (r.pages) f.push('  pages = {' + r.pages.replace('–', '--') + '}'); if (r.doi) f.push('  doi = {' + r.doi + '}'); if (r.isbn) f.push('  isbn = {' + r.isbn + '}'); if (r.url) f.push('  url = {' + (r.archived || r.url) + '}'); return '@' + bibType(r.type) + '{' + r.citekey + ',\n' + f.join(',\n') + '\n}'; }
  function risType(t) { return t === 'book' ? 'BOOK' : t === 'webpage' ? 'ELEC' : t === 'article-magazine' ? 'MGZN' : t === 'preprint' ? 'GEN' : 'JOUR'; }
  function toRIS(r) { const L = ['TY  - ' + risType(r.type)]; r.authors.forEach((a) => L.push('AU  - ' + a.f + ', ' + a.g)); L.push('TI  - ' + r.title); L.push('PY  - ' + r.year); if (r.container) L.push((r.type === 'book' ? 'PB  - ' : 'JO  - ') + r.container); if (r.publisher && r.type === 'book') L.push('PB  - ' + r.publisher); if (r.volume) L.push('VL  - ' + r.volume); if (r.pages) { const p = r.pages.split(/[–-]/); L.push('SP  - ' + p[0]); if (p[1]) L.push('EP  - ' + p[1]); } if (r.doi) L.push('DO  - ' + r.doi); if (r.isbn) L.push('SN  - ' + r.isbn); if (r.url) L.push('UR  - ' + (r.archived || r.url)); if (r.accessed) L.push('Y2  - ' + r.accessed); L.push('ER  - '); return L.join('\n'); }
  function toCSL(r) { const o = { id: r.citekey, type: r.type, title: r.title, author: r.authors.map((a) => ({ family: a.f, given: a.g })), issued: { 'date-parts': [[r.year]] } }; if (r.container) o['container-title'] = r.container; if (r.publisher) o.publisher = r.publisher; if (r.volume) o.volume = r.volume; if (r.pages) o.page = r.pages; if (r.doi) o.DOI = r.doi; if (r.isbn) o.ISBN = r.isbn; if (r.url) o.URL = r.archived || r.url; return '  ' + JSON.stringify(o); }
  function apaAuth(as) { const s = as.map((a) => a.f + ', ' + initials(a.g)); return s.length > 1 ? s.slice(0, -1).join(', ') + ', & ' + s[s.length - 1] : s[0]; }
  function toAPA(r) { let s = apaAuth(r.authors) + ' (' + r.year + '). ' + r.title + '.'; if (r.container) s += ' ' + r.container + (r.volume ? ', ' + r.volume : '') + (r.pages ? ', ' + r.pages : '') + '.'; else if (r.publisher) s += ' ' + r.publisher + '.'; if (r.doi) s += ' https://doi.org/' + r.doi; else if (r.url) s += ' Retrieved ' + (r.accessed || '') + ', from ' + (r.archived || r.url); return s; }
  function toNature(r) { const a = r.authors.map((x) => x.f + ', ' + initials(x.g)).join(', '); let s = a + ' ' + r.title + '.'; if (r.container) s += ' ' + r.container + (r.volume ? ' ' + r.volume : '') + (r.pages ? ', ' + r.pages : '') + ' (' + r.year + ').'; else s += ' (' + (r.publisher || '') + ', ' + r.year + ').'; return s; }
  function zenType(t) { return t === 'book' ? 'book' : t === 'preprint' ? 'preprint' : (t === 'webpage' || t === 'article-magazine') ? 'other' : 'article'; }
  function toZenodo(r) { const m = { upload_type: 'publication', publication_type: zenType(r.type), title: r.title, creators: r.authors.map((a) => ({ name: a.f + ', ' + a.g })), publication_date: r.year + '-01-01', description: r.abstract || r.title }; if (r.doi) m.doi = r.doi; if (r.container && r.type !== 'book') m.journal_title = r.container; if (r.publisher || r.type === 'book') m.imprint_publisher = r.publisher || r.container; return '  ' + JSON.stringify(m); }
  function exportOne(r, f) { return ({ 'BibTeX': toBibTeX, 'RIS (EndNote)': toRIS, 'CSL-JSON': toCSL, 'APA': toAPA, 'Nature': toNature, 'Zenodo': toZenodo }[f] || (() => ''))(r); }
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
    <button class="libbtn pri" onclick={() => { adding = true; addResult = undefined; addInput = ''; }}>＋ Add reference</button>
    <button class="libbtn" onclick={() => { exportScope = 'all'; }}>⇩ Export library</button>
  </div>

  <div class="libcol refs">
    {#each filtered as r (r.id)}
      <button class="refrow" class:on={r.id === selId} onclick={() => (selId = r.id)}>
        <div class="rtitle"><span class="rtype">{TYPELABEL[r.type] || r.type}</span>{r.title}</div>
        <div class="rmeta">{shortAuth(r.authors)} · {r.year}{r.container ? ' · ' + r.container : r.publisher ? ' · ' + r.publisher : ''}</div>
        <div class="rsrc">{#each r.sources as s}<span class="sb">{s}</span>{/each}</div>
      </button>
    {/each}
  </div>

  <div class="libcol detail">
    {#if adding}
      <div class="libhead">Add a reference</div>
      <p class="rmeta">Paste a DOI, ISBN, arXiv ID, or URL — Arf fetches from trusted open libraries.</p>
      <input class="expsel" style="width:100%;margin:.4rem 0" placeholder="10.1103/… · 9780262035613 · arXiv:1706.03762" bind:value={addInput} />
      <button class="libbtn pri" onclick={doFetch}>Fetch from open libraries</button>
      {#if addResult === false}<p class="rmeta" style="margin-top:.6rem">No match. You could add it and fill fields by hand.</p>{/if}
      {#if addResult}
        <div class="dfield" style="margin-top:.8rem"><div class="rsrc">{#each addResult.sources as s}<span class="sb">{s}</span>{/each}</div>
          <div style="font-size:16px;color:var(--fg-bright);margin-top:.3rem">{addResult.title}</div>
          <div class="rmeta">{addResult.authors.map((a) => a.g + ' ' + a.f).join(', ')} · {addResult.year}</div>
          <button class="libbtn pri" onclick={addFetched}>Add to Library</button></div>
      {/if}
      <button class="libbtn" onclick={() => (adding = false)}>Cancel</button>
    {:else if sel}
      <div class="libhead">Reference detail</div>
      <div class="dfield"><div class="dl">Title</div><div class="dv" style="font-size:18px;color:var(--fg-bright)">{sel.title}</div></div>
      <div class="dfield"><div class="dl">Authors</div><div class="dv">{sel.authors.map((a) => a.g + ' ' + a.f).join(', ')}</div></div>
      <div class="dfield"><div class="dl">Type · Year</div><div class="dv">{TYPELABEL[sel.type] || sel.type} · {sel.year}</div></div>
      {#if sel.container}<div class="dfield"><div class="dl">{sel.type === 'webpage' || sel.type === 'article-magazine' ? 'Site' : 'Published in'}</div><div class="dv">{sel.container}{sel.volume ? ' ' + sel.volume : ''}{sel.pages ? ', ' + sel.pages : ''}</div></div>{/if}
      {#if sel.publisher}<div class="dfield"><div class="dl">Publisher</div><div class="dv">{sel.publisher}</div></div>{/if}
      {#if sel.doi}<div class="dfield"><div class="dl">DOI</div><div class="dv"><a href={'https://doi.org/' + sel.doi} target="_blank" rel="noopener">{sel.doi}</a></div></div>{/if}
      {#if sel.isbn}<div class="dfield"><div class="dl">ISBN</div><div class="dv">{sel.isbn}</div></div>{/if}
      {#if sel.archived}<div class="dfield"><div class="dl">Archived snapshot · Wayback Machine</div><div class="dv"><a href={sel.archived} target="_blank" rel="noopener">web.archive.org/{sel.archivedDate}</a><br>captured {sel.archivedDate} · accessed {sel.accessed || '—'}</div></div>{/if}
      {#if sel.abstract}<div class="dfield"><div class="dl">Abstract</div><div class="dv" style="font-size:14px;color:var(--fg-muted)">{sel.abstract}</div></div>{/if}
      <div class="dfield"><div class="dl">Fetched from</div><div class="rsrc">{#each sel.sources as s}<span class="sb">{s}</span>{/each}</div></div>
      <button class="libbtn pri" onclick={() => (exportScope = sel.id)}>⇩ Export this reference</button>
    {:else}<div class="rempty">Select a reference.</div>{/if}
  </div>
</div>

{#if exportScope}
  <div class="scrim" onclick={(e) => { if (e.target === e.currentTarget) exportScope = null; }}>
    <div class="modal">
      <button class="mclose" onclick={() => (exportScope = null)}>✕</button>
      <h3>Export references</h3>
      <p class="msub">Every format your tools need — BibTeX, RIS for EndNote, CSL-JSON, formatted styles, Zenodo.</p>
      <div style="display:flex;gap:.6rem;align-items:center">
        <select class="expsel" bind:value={expFmt}>{#each ['BibTeX', 'RIS (EndNote)', 'CSL-JSON', 'APA', 'Nature', 'Zenodo'] as f}<option>{f}</option>{/each}</select>
        <span class="rmeta">{exportRefs.length} reference{exportRefs.length === 1 ? '' : 's'}</span>
        <button class="libbtn" style="width:auto;margin:0 0 0 auto;padding:.35rem .8rem" onclick={copy}>Copy</button>
      </div>
      <textarea class="exparea" readonly>{exportText}</textarea>
    </div>
  </div>
{/if}
