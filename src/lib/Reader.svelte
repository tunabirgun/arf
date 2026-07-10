<script>
  // Side reader. Two rendering modes share one scroll container (bodyEl):
  //  • PDF  → a real page view: each page is a pdf.js canvas with a selectable text layer over it,
  //    stacked and scrollable, with zoom (fit-width by default, − / + / Ctrl-wheel). Selection drives
  //    Quote; stored highlight snippets are re-applied to the text-layer spans on every render.
  //  • everything else (note / markdown / text / web / EPUB) → sanitized HTML set as innerHTML, with
  //    highlights wrapped in <mark>. EPUB is unzipped to reflowable, selectable chapter HTML.
  // We own bodyEl imperatively (not a reactive {@html}) so highlight DOM mutation can't corrupt it.
  import { renderMarkdown } from './markdown.js';
  import DOMPurify from 'dompurify';

  let { source = null, highlights = [], canQuote = true, onclose = null, onquote = null, onhighlight = null } = $props();

  let bodyEl;
  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function textToHTML(t) { return (t || '').split(/\n{2,}/).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join(''); }

  // ---------------- EPUB extraction (kind === 'epub') ----------------
  let epubHtml = $state(''); let epubStatus = $state(''); let _epubKey = '';
  $effect(() => {
    const s = source;
    if (!s || s.kind !== 'epub' || !s.bytes) return;
    if (_epubKey === s.key) return;
    _epubKey = s.key; epubHtml = ''; epubStatus = 'loading';
    (async () => {
      try { const { extractEpub } = await import('./epub.js'); const out = extractEpub(s.bytes.slice()); if (_epubKey === s.key) { epubHtml = out; epubStatus = ''; } }
      catch (e) { if (_epubKey === s.key) epubStatus = 'error'; }
    })();
  });

  // ---------------- HTML-flow content (everything except PDF) ----------------
  const html = $derived.by(() => {
    const s = source; if (!s || s.kind === 'pdf') return '';
    if (s.kind === 'note' || s.kind === 'md') return renderMarkdown(s.body || '');
    if (s.kind === 'html') return DOMPurify.sanitize(s.html || '');
    if (s.kind === 'text') return textToHTML(s.body || '');
    if (s.kind === 'epub') return epubStatus === 'loading' ? '<p class="rmuted">Opening the book…</p>' : epubStatus === 'error' ? '<p class="rmuted">Couldn’t open this EPUB.</p>' : (epubHtml || '<p class="rmuted">This EPUB has no readable text.</p>');
    if (s.kind === 'other') return '<p class="rmuted">Preview isn’t available for this format yet — open it in your system reader.</p>';
    return '';
  });
  // render the HTML flow into bodyEl and mark highlights on it. Skipped for PDF, whose viewer owns bodyEl.
  $effect(() => {
    const h = html, hls = highlights, s = source;
    if (!bodyEl || (s && s.kind === 'pdf')) return;
    if (_viewerKey) { teardownPdf(); _viewerKey = ''; }   // left the PDF viewer: destroy it so returning to the same PDF re-renders
    bodyEl.innerHTML = s ? h : '<p class="rmuted">Nothing open. Right-click a note or a reference to read it here.</p>';
    if (s) markHighlights(bodyEl, hls);
  });
  function markHighlights(root, snippets) {
    root.querySelectorAll('mark.rhl').forEach((m) => { const t = document.createTextNode(m.textContent); m.replaceWith(t); });
    root.normalize();
    for (const snip of (snippets || [])) {
      const needle = (snip || '').trim(); if (needle.length < 3) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      const hits = [];
      while (walker.nextNode()) { const node = walker.currentNode; const i = node.nodeValue.indexOf(needle); if (i >= 0) hits.push({ node, i }); }
      for (const { node, i } of hits) {
        try { const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + needle.length); const mark = document.createElement('mark'); mark.className = 'rhl'; range.surroundContents(mark); }
        catch (e) { /* snippet spans element boundaries — skip */ }
      }
    }
  }

  // ---------------- PDF page viewer (kind === 'pdf') ----------------
  let pdfStatus = $state('');     // '', 'loading', 'error'
  let pdfScale = $state(0);       // CSS-px scale (0 until fit-width is computed)
  let pdfPages = $state(0);
  let _pdfDoc = null, _pdfjs = null, _viewerKey = '', _renderSeq = 0, _zoomTimer;

  $effect(() => {
    const s = source;
    if (!s || s.kind !== 'pdf' || !s.bytes) return;
    if (_viewerKey === s.key) return;
    _viewerKey = s.key;
    loadPdf(s);
  });
  async function loadPdf(s) {
    teardownPdf();
    pdfStatus = 'loading'; pdfScale = 0; pdfPages = 0;
    if (bodyEl) bodyEl.innerHTML = '<p class="rmuted" style="padding:1rem 1.1rem">Opening the document…</p>';
    try {
      const pdfjs = await import('pdfjs-dist');
      try { pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString(); } catch (e) {}
      const doc = await pdfjs.getDocument({ data: s.bytes.slice() }).promise;
      if (_viewerKey !== s.key) { try { doc.destroy(); } catch (e) {} return; }
      _pdfjs = pdfjs; _pdfDoc = doc; pdfPages = doc.numPages;
      await renderPdf();
      if (_viewerKey === s.key) pdfStatus = '';
    } catch (e) { if (_viewerKey === s.key) { pdfStatus = 'error'; if (bodyEl) bodyEl.innerHTML = '<p class="rmuted" style="padding:1rem 1.1rem">Couldn’t open this PDF.</p>'; } }
  }
  function teardownPdf() {
    _renderSeq++;
    if (_pdfDoc) { try { _pdfDoc.destroy(); } catch (e) {} _pdfDoc = null; }
    if (bodyEl) bodyEl.innerHTML = '';
  }
  async function renderPdf() {
    const doc = _pdfDoc, pdfjs = _pdfjs; if (!doc || !pdfjs || !bodyEl) return;
    const seq = ++_renderSeq;
    const prevRatio = bodyEl.scrollHeight ? bodyEl.scrollTop / bodyEl.scrollHeight : 0;
    const page1 = await doc.getPage(1);
    const base = page1.getViewport({ scale: 1 });
    if (!pdfScale) { const avail = (bodyEl.clientWidth || 620) - 30; pdfScale = Math.max(0.25, Math.min(3, avail / base.width)); }
    const dpr = window.devicePixelRatio || 1;
    const wrap = document.createElement('div'); wrap.className = 'pdfpages';
    for (let p = 1; p <= doc.numPages; p++) {
      if (seq !== _renderSeq) return;
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: pdfScale });
      const pageDiv = document.createElement('div'); pageDiv.className = 'pdfpage';
      const w = Math.floor(vp.width), h = Math.floor(vp.height);
      pageDiv.style.width = w + 'px'; pageDiv.style.height = h + 'px';
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      pageDiv.appendChild(canvas);
      const textDiv = document.createElement('div'); textDiv.className = 'textLayer'; textDiv.style.setProperty('--scale-factor', String(pdfScale));
      pageDiv.appendChild(textDiv);
      wrap.appendChild(pageDiv);
      if (p === 1) { bodyEl.innerHTML = ''; bodyEl.appendChild(wrap); }   // show the first page fast
      const ctx = canvas.getContext('2d');
      const rp = { canvasContext: ctx, viewport: vp }; if (dpr !== 1) rp.transform = [dpr, 0, 0, dpr, 0, 0];
      try { await page.render(rp).promise; } catch (e) { if (seq !== _renderSeq) return; }
      if (seq !== _renderSeq) return;
      try {
        const tc = await page.getTextContent();
        const tl = new pdfjs.TextLayer({ textContentSource: tc, container: textDiv, viewport: vp });
        await tl.render();
        applyPdfHighlights(textDiv, highlights);
      } catch (e) { /* a page without a text layer is still readable as an image */ }
    }
    if (seq !== _renderSeq) return;
    bodyEl.scrollTop = prevRatio * bodyEl.scrollHeight;
  }
  function applyZoom(next) { pdfScale = Math.max(0.3, Math.min(4, next)); clearTimeout(_zoomTimer); _zoomTimer = setTimeout(renderPdf, 140); }
  function zoomIn() { applyZoom((pdfScale || 1) * 1.15); }
  function zoomOut() { applyZoom((pdfScale || 1) / 1.15); }
  function zoomFit() { pdfScale = 0; clearTimeout(_zoomTimer); _zoomTimer = setTimeout(renderPdf, 60); }
  function onWheel(e) { if (source?.kind !== 'pdf' || !e.ctrlKey) return; e.preventDefault(); applyZoom((pdfScale || 1) * (e.deltaY < 0 ? 1.1 : 0.9)); }

  // highlight the text-layer spans covered by each stored snippet. Whitespace-collapsed char map so a
  // snippet matches regardless of the layout's spacing; marks per span (never wraps across spans).
  function applyPdfHighlights(container, snippets) {
    container.querySelectorAll('span.rhlspan').forEach((s) => s.classList.remove('rhlspan'));
    const spans = [...container.querySelectorAll('span')].filter((s) => s.textContent && s.textContent.trim());
    if (!spans.length) return;
    let norm = ''; const owner = []; let prevWs = true;
    for (let si = 0; si < spans.length; si++) {
      const t = spans[si].textContent;
      for (let c = 0; c < t.length; c++) { const ch = t[c]; if (/\s/.test(ch)) { if (!prevWs) { norm += ' '; owner.push(si); prevWs = true; } } else { norm += ch.toLowerCase(); owner.push(si); prevWs = false; } }
      if (!prevWs) { norm += ' '; owner.push(si); prevWs = true; }
    }
    for (const snip of (snippets || [])) {
      const needle = (snip || '').replace(/\s+/g, ' ').trim().toLowerCase(); if (needle.length < 3) continue;
      let from = 0, idx;
      while ((idx = norm.indexOf(needle, from)) >= 0) { for (let i = idx; i < idx + needle.length; i++) { const si = owner[i]; if (si != null) spans[si].classList.add('rhlspan'); } from = idx + needle.length; }
    }
  }
  // re-apply highlights to a live PDF when the highlight set changes (e.g. just added one)
  $effect(() => { highlights; if (source?.kind === 'pdf' && bodyEl) bodyEl.querySelectorAll('.textLayer').forEach((tl) => applyPdfHighlights(tl, highlights)); });
  // Ctrl-wheel zoom (non-passive so preventDefault works) + teardown on unmount
  $effect(() => {
    if (!bodyEl) return;
    bodyEl.addEventListener('wheel', onWheel, { passive: false });
    return () => { bodyEl.removeEventListener('wheel', onWheel); teardownPdf(); clearTimeout(_zoomTimer); };
  });

  function currentSelection() {
    const s = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (!s || s.rangeCount === 0) return '';
    if (bodyEl && !bodyEl.contains(s.anchorNode)) return '';
    return String(s).trim();
  }
  function quoteSel() { const t = currentSelection(); if (t && onquote) onquote(t); }
  function highlightSel() { const t = currentSelection(); if (t && onhighlight) onhighlight(t); }

  const sourceLabel = $derived(source ? (source.kind === 'note' ? 'Note' : source.kind === 'pdf' ? 'PDF' : source.kind === 'html' ? 'Web' : source.kind === 'epub' ? 'EPUB' : source.kind === 'md' ? 'Markdown' : 'Text') : '');
  const isPdf = $derived(source?.kind === 'pdf');
</script>

<div class="reader">
  <div class="rhead">
    <span class="rkind">{sourceLabel}</span>
    <span class="rtitle" title={source?.title || ''}>{source?.title || 'Reader'}</span>
    <span class="rsp"></span>
    {#if isPdf && pdfStatus !== 'error'}
      <span class="zoom">
        <button class="rbtn zb" title="Zoom out" aria-label="Zoom out" onclick={zoomOut}>−</button>
        <button class="rbtn zb" title="Fit width" onclick={zoomFit}>{pdfScale ? Math.round(pdfScale * 100) + '%' : 'Fit'}</button>
        <button class="rbtn zb" title="Zoom in" aria-label="Zoom in" onclick={zoomIn}>+</button>
      </span>
    {/if}
    <button class="rbtn" disabled={!canQuote} title={canQuote ? 'Quote the selected passage into the open note' : 'Open a note first to quote into it'} onclick={quoteSel}>❞ Quote</button>
    <button class="rbtn" title="Highlight the selected sentence" onclick={highlightSel}>✎ Mark</button>
    <button class="rbtn x" title="Close reader" aria-label="Close reader" onclick={() => onclose && onclose()}>✕</button>
  </div>
  <!-- bodyEl is managed imperatively (innerHTML / canvas pages), never with Svelte child blocks -->
  <div class="readerbody" class:pdfmode={isPdf} bind:this={bodyEl}></div>
</div>

<style>
  .reader { display: flex; flex-direction: column; height: 100%; min-height: 0; background: color-mix(in srgb, var(--canvas) 55%, var(--surface)); }
  .rhead { flex: none; display: flex; align-items: center; gap: .4rem; padding: .5rem .7rem; border-bottom: 1px solid var(--line); }
  .rkind { font-family: var(--mono); font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--accent-soft); border-radius: 3px; padding: 0 .3rem; flex: none; }
  .rtitle { font-family: var(--serif); font-size: 14px; color: var(--fg-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rsp { flex: 1; }
  .zoom { display: inline-flex; align-items: center; gap: .1rem; margin-right: .2rem; }
  .zoom .zb { min-width: 1.6rem; text-align: center; padding: .22rem .3rem; }
  .rbtn { font-family: var(--sans); font-size: 11.5px; color: var(--fg-muted); background: none; border: 1px solid transparent; border-radius: 5px; padding: .22rem .45rem; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s, border-color .15s; }
  .rbtn:hover:not(:disabled) { background: var(--accent-soft); color: var(--fg-bright); border-color: var(--line-strong); }
  .rbtn:disabled { opacity: .4; cursor: default; }
  .rbtn.x { border: 0; font-size: 14px; }
  .readerbody { flex: 1; min-height: 0; overflow-y: auto; padding: 1rem 1.1rem 3rem; font-family: var(--serif); font-size: 15.5px; line-height: 1.6; color: var(--fg); scroll-behavior: smooth; overscroll-behavior: contain; scrollbar-width: thin; }
  /* PDF page view: darker gutter, centered pages, no serif column padding */
  .readerbody.pdfmode { padding: 14px 0 40px; background: color-mix(in srgb, var(--canvas) 30%, #000 6%); }
  .readerbody :global(.pdfpages) { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .readerbody :global(.pdfpage) { position: relative; background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.30); }
  .readerbody :global(.pdfpage canvas) { display: block; }
  /* pdf.js text layer: transparent selectable text positioned over the canvas */
  .readerbody :global(.textLayer) { position: absolute; inset: 0; overflow: clip; opacity: 1; line-height: 1; text-align: initial; transform-origin: 0 0; z-index: 2; forced-color-adjust: none; }
  .readerbody :global(.textLayer span), .readerbody :global(.textLayer br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; }
  .readerbody :global(.textLayer span.rhlspan) { background: color-mix(in srgb, var(--accent) 34%, transparent); border-radius: 2px; }
  .readerbody :global(.textLayer ::selection) { background: color-mix(in srgb, var(--accent) 42%, transparent); }
  .readerbody :global(hr.epub-sep) { border: 0; border-top: 1px solid var(--line); margin: 1.8rem 0; }
  .readerbody :global(ul), .readerbody :global(ol) { margin: 0 0 .7rem; padding-left: 1.4rem; }
  .readerbody :global(li) { margin: .2rem 0; }
  .readerbody :global(h1), .readerbody :global(h2), .readerbody :global(h3) { color: var(--fg-bright); font-weight: 600; line-height: 1.2; margin: 1.1rem 0 .4rem; }
  .readerbody :global(h1) { font-size: 20px; } .readerbody :global(h2) { font-size: 17px; } .readerbody :global(h3) { font-size: 15.5px; }
  .readerbody :global(p) { margin: 0 0 .7rem; }
  .readerbody :global(a) { color: var(--accent); }
  .readerbody :global(pre) { background: color-mix(in srgb, var(--canvas) 45%, var(--surface)); border: 1px solid var(--line); border-radius: 6px; padding: .6rem .8rem; overflow-x: auto; font-family: var(--mono); font-size: 12.5px; }
  .readerbody :global(blockquote) { margin: .8rem 0; padding-left: 1rem; border-left: 2px solid var(--line-strong); color: var(--fg-muted); font-style: italic; }
  .readerbody :global(img) { max-width: 100%; height: auto; }
  .readerbody :global(mark.rhl) { background: color-mix(in srgb, var(--accent) 26%, transparent); color: inherit; border-radius: 2px; padding: 0 .05em; }
  .readerbody :global(.rmuted) { color: var(--fg-faint); font-style: italic; }
  .readerbody :global(::selection) { background: var(--accent-soft); }
</style>
