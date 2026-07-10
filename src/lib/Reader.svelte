<script>
  // Side reader. Two rendering modes share one scroll container (bodyEl):
  //  • PDF  → a real page view: each page is a pdf.js canvas with a selectable text layer over it,
  //    stacked and scrollable, with zoom (fit-width by default, − / + / Ctrl-wheel). Selection drives
  //    Quote; stored highlight snippets are re-applied to the text-layer spans on every render.
  //  • everything else (note / markdown / text / web / EPUB) → sanitized HTML set as innerHTML, with
  //    highlights wrapped in <mark>. EPUB is unzipped to reflowable, selectable chapter HTML.
  // We own bodyEl imperatively (not a reactive {@html}) so highlight DOM mutation can't corrupt it.
  import { renderMarkdown } from './markdown.js';
  import { computeFitScale } from './pdffit.js';
  import { buildMatchIndex, coveredSegments, coveredIntervals, coerceHl, HL_COLORS } from './highlight.js';
  import DOMPurify from 'dompurify';

  let { source = null, highlights = [], canQuote = true, onclose = null, onquote = null, onhighlight = null, onunhighlight = null } = $props();
  let markColor = $state(HL_COLORS[0]);   // colour the next Mark uses; swatches also mark immediately

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
  // Mark stored snippets in the HTML flow. Idempotent: unwrap prior marks and normalize first, so a
  // re-apply (a highlight added/removed) starts from clean text. Matches whitespace-insensitively over
  // ALL text nodes, then wraps each covered node slice in its own <mark> — so a sentence spanning
  // inline elements (a [[wikilink]], a citation, bold) or containing brackets highlights correctly,
  // where the old single-node Range.surroundContents() threw across element boundaries and skipped it.
  function markHighlights(root, snippets) {
    root.querySelectorAll('mark.rhl').forEach((m) => { const t = document.createTextNode(m.textContent); m.replaceWith(t); });
    root.normalize();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    if (!nodes.length) return;
    const index = buildMatchIndex(nodes.map((n) => n.nodeValue));
    const perNode = new Map();   // node index → [{ a, b, color, hi }]
    (snippets || []).forEach((h, hi) => {
      const { text, color } = coerceHl(h);
      for (const iv of coveredIntervals(index, text)) {
        if (!perNode.has(iv.seg)) perNode.set(iv.seg, []);
        perNode.get(iv.seg).push({ a: iv.a, b: iv.b, color, hi });
      }
    });
    for (const [ni, ivs] of perNode) {
      const node = nodes[ni]; if (!node || !node.parentNode) continue;
      const text = node.nodeValue, len = text.length;
      // paint each character with the last interval covering it, so overlapping/contained highlights on
      // one node each keep a visible run and a clickable data-hli (a naive left-to-right pass would clip
      // a fully-contained highlight to zero width).
      const owner = new Array(len).fill(-1);
      for (let k = 0; k < ivs.length; k++) { const iv = ivs[k]; for (let p = Math.max(0, iv.a); p < Math.min(len, iv.b); p++) owner[p] = k; }
      const frag = document.createDocumentFragment();
      let p = 0;
      while (p < len) {
        const o = owner[p]; let q = p; while (q < len && owner[q] === o) q++;
        const slice = text.slice(p, q);
        if (o < 0) frag.appendChild(document.createTextNode(slice));
        else { const iv = ivs[o]; const m = document.createElement('mark'); m.className = 'rhl rhl-' + iv.color; m.dataset.hli = String(iv.hi); m.textContent = slice; frag.appendChild(m); }
        p = q;
      }
      node.replaceWith(frag);
    }
  }

  // ---------------- PDF page viewer (kind === 'pdf') ----------------
  let pdfStatus = $state('');     // '', 'loading', 'error'
  let pdfScale = $state(0);       // CSS-px scale (0 until fit-width is computed)
  let pdfPages = $state(0);
  let fitMode = $state(true);     // true → pages track the panel width; a manual zoom turns it off
  let _pdfDoc = null, _pdfjs = null, _viewerKey = '', _renderSeq = 0, _zoomTimer, _lastFitW = 0;

  $effect(() => {
    const s = source;
    if (!s || s.kind !== 'pdf' || !s.bytes) return;
    if (_viewerKey === s.key) return;
    _viewerKey = s.key;
    loadPdf(s);
  });
  async function loadPdf(s) {
    teardownPdf();
    pdfStatus = 'loading'; pdfScale = 0; pdfPages = 0; fitMode = true; _lastFitW = 0;
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
    // fit-width by default: recompute the scale from the panel's current width on every render so
    // the pages track the reader as it's resized. A manual zoom (fitMode=false) keeps its scale.
    if (fitMode || !pdfScale) { pdfScale = computeFitScale(bodyEl.clientWidth, base.width); _lastFitW = bodyEl.clientWidth; }
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
  function applyZoom(next) { fitMode = false; pdfScale = Math.max(0.3, Math.min(4, next)); clearTimeout(_zoomTimer); _zoomTimer = setTimeout(renderPdf, 140); }
  function zoomIn() { applyZoom((pdfScale || 1) * 1.15); }
  function zoomOut() { applyZoom((pdfScale || 1) / 1.15); }
  function zoomFit() { fitMode = true; clearTimeout(_zoomTimer); _zoomTimer = setTimeout(renderPdf, 60); }
  function onWheel(e) { if (source?.kind !== 'pdf' || !e.ctrlKey) return; e.preventDefault(); applyZoom((pdfScale || 1) * (e.deltaY < 0 ? 1.1 : 0.9)); }

  // highlight the text-layer spans covered by each stored snippet. Whitespace-collapsed char map so a
  // snippet matches regardless of the layout's spacing; marks per span (never wraps across spans).
  // Colour the text-layer spans covered by each stored snippet. Whitespace-insensitive matching means a
  // citation like "(Smith, 2020)" or "[12]" matches even though pdf.js splits its brackets into their
  // own spans. data-hlc carries the colour; data-hli maps a span back to its highlight for click-to-remove.
  function applyPdfHighlights(container, snippets) {
    container.querySelectorAll('span.rhlspan').forEach((s) => { s.classList.remove('rhlspan'); s.removeAttribute('data-hlc'); s.removeAttribute('data-hli'); });
    const spans = [...container.querySelectorAll('span')].filter((s) => s.textContent && s.textContent.trim());
    if (!spans.length) return;
    const index = buildMatchIndex(spans.map((s) => s.textContent));
    (snippets || []).forEach((h, hi) => {
      const { text, color } = coerceHl(h);
      for (const si of coveredSegments(index, text)) { spans[si].classList.add('rhlspan'); spans[si].setAttribute('data-hlc', color); spans[si].setAttribute('data-hli', String(hi)); }
    });
  }
  // re-apply highlights to a live PDF when the highlight set changes (e.g. just added one)
  $effect(() => { highlights; if (source?.kind === 'pdf' && bodyEl) bodyEl.querySelectorAll('.textLayer').forEach((tl) => applyPdfHighlights(tl, highlights)); });
  // Ctrl-wheel zoom (non-passive so preventDefault works), autofit-on-resize, + teardown on unmount
  $effect(() => {
    if (!bodyEl) return;
    bodyEl.addEventListener('wheel', onWheel, { passive: false });
    bodyEl.addEventListener('click', onBodyClick);
    // re-fit the PDF when the panel width actually changes (resize / toggle / window). The scrollbar
    // gutter is reserved in CSS so clientWidth doesn't shift when the scrollbar appears; the zero-width
    // bail ignores a hidden panel (display:none → clientWidth 0), and the >=5px guard skips no-op fires.
    let _rt;
    const ro = new ResizeObserver(() => {
      if (source?.kind !== 'pdf' || !fitMode || !_pdfDoc) return;
      const w = bodyEl.clientWidth;
      if (!w || Math.abs(w - _lastFitW) < 5) return;
      clearTimeout(_rt); _rt = setTimeout(renderPdf, 120);
    });
    ro.observe(bodyEl);
    return () => { bodyEl.removeEventListener('wheel', onWheel); bodyEl.removeEventListener('click', onBodyClick); ro.disconnect(); clearTimeout(_rt); teardownPdf(); clearTimeout(_zoomTimer); };
  });

  function currentSelection() {
    const s = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (!s || s.rangeCount === 0) return '';
    if (bodyEl && !bodyEl.contains(s.anchorNode)) return '';
    return String(s).trim();
  }
  function quoteSel() { const t = currentSelection(); if (t && onquote) onquote(t); }
  // highlight the current selection in a colour (the swatch clicked); remembers it as the active colour
  function mark(color) { markColor = color; const t = currentSelection(); if (t && onhighlight) onhighlight(t, color); }
  // click a highlight (with no active text selection) to remove it — the reader is read-only, so a bare
  // click on a mark has no other meaning. data-hli maps the clicked element back to its stored snippet.
  function onBodyClick(e) {
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && String(sel).trim()) return;   // a drag-select — not a remove
    const el = e.target && e.target.closest ? e.target.closest('[data-hli]') : null;
    if (!el) return;
    const h = highlights[+el.getAttribute('data-hli')];
    if (h != null && onunhighlight) onunhighlight(coerceHl(h).text);
  }

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
        <button class="rbtn zb" class:on={fitMode} title="Fit to panel width" onclick={zoomFit}>{fitMode ? 'Fit' : Math.round(pdfScale * 100) + '%'}</button>
        <button class="rbtn zb" title="Zoom in" aria-label="Zoom in" onclick={zoomIn}>+</button>
      </span>
    {/if}
    <button class="rbtn" disabled={!canQuote} title={canQuote ? 'Quote the selected passage into the open note' : 'Open a note first to quote into it'} onclick={quoteSel}>❞ Quote</button>
    <span class="marks" title="Highlight the selected text — pick a colour (click a highlight to remove it)">
      {#each HL_COLORS as c}
        <button class="swatch sw-{c}" class:on={markColor === c} aria-label={'Highlight in ' + c} onclick={() => mark(c)}></button>
      {/each}
    </span>
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
  .zoom .zb.on { color: var(--accent); border-color: var(--accent-soft); background: var(--accent-soft); }
  .rbtn { font-family: var(--sans); font-size: 11.5px; color: var(--fg-muted); background: none; border: 1px solid transparent; border-radius: 5px; padding: .22rem .45rem; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s, border-color .15s; }
  .rbtn:hover:not(:disabled) { background: var(--accent-soft); color: var(--fg-bright); border-color: var(--line-strong); }
  .rbtn:disabled { opacity: .4; cursor: default; }
  .rbtn.x { border: 0; font-size: 14px; }
  .readerbody { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; padding: 1rem 1.1rem 3rem; font-family: var(--serif); font-size: 15.5px; line-height: 1.6; color: var(--fg); scroll-behavior: smooth; overscroll-behavior: contain; scrollbar-width: thin; }
  /* PDF page view: darker gutter, centered pages, no serif column padding */
  .readerbody.pdfmode { padding: 14px 0 40px; background: color-mix(in srgb, var(--canvas) 30%, #000 6%); }
  .readerbody :global(.pdfpages) { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .readerbody :global(.pdfpage) { position: relative; background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.30); }
  .readerbody :global(.pdfpage canvas) { display: block; }
  /* pdf.js text layer: transparent selectable text positioned over the canvas */
  .readerbody :global(.textLayer) { position: absolute; inset: 0; overflow: clip; opacity: 1; line-height: 1; text-align: initial; transform-origin: 0 0; z-index: 2; forced-color-adjust: none; }
  .readerbody :global(.textLayer span), .readerbody :global(.textLayer br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; }
  .readerbody :global(.textLayer span.rhlspan) { border-radius: 2px; cursor: pointer; }
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
  /* highlighter palette — semi-transparent so both the black PDF text and themed note text read through */
  .readerbody :global(mark.rhl) { color: inherit; border-radius: 2px; padding: 0 .04em; cursor: pointer; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .readerbody :global(mark.rhl-yellow), .readerbody :global(.textLayer span.rhlspan[data-hlc="yellow"]) { background: rgba(240,190,20,.42); }
  .readerbody :global(mark.rhl-green),  .readerbody :global(.textLayer span.rhlspan[data-hlc="green"])  { background: rgba(52,190,110,.40); }
  .readerbody :global(mark.rhl-blue),   .readerbody :global(.textLayer span.rhlspan[data-hlc="blue"])   { background: rgba(58,150,240,.36); }
  .readerbody :global(mark.rhl-pink),   .readerbody :global(.textLayer span.rhlspan[data-hlc="pink"])   { background: rgba(238,90,165,.36); }
  .readerbody :global(mark.rhl-orange), .readerbody :global(.textLayer span.rhlspan[data-hlc="orange"]) { background: rgba(240,135,30,.42); }
  .marks { display: inline-flex; align-items: center; gap: .2rem; margin: 0 .1rem; }
  .swatch { width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--line-strong); cursor: pointer; padding: 0; transition: transform .12s; }
  .swatch:hover { transform: scale(1.15); }
  .swatch.on { outline: 2px solid var(--accent); outline-offset: 1px; }
  .swatch.sw-yellow { background: rgba(240,190,20,.92); }
  .swatch.sw-green  { background: rgba(52,190,110,.92); }
  .swatch.sw-blue   { background: rgba(58,150,240,.92); }
  .swatch.sw-pink   { background: rgba(238,90,165,.92); }
  .swatch.sw-orange { background: rgba(240,135,30,.92); }
  .readerbody :global(.rmuted) { color: var(--fg-faint); font-style: italic; }
  .readerbody :global(::selection) { background: var(--accent-soft); }
</style>
