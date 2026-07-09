<script>
  // Side reader: read a source (another note, a reference's attachment, or pasted text/HTML)
  // while writing. The content is rendered into the DOM so window.getSelection() works, which
  // is what lets the right-click menu quote a passage into the open note or highlight a sentence.
  // PDFs are rendered as extracted, selectable text (pdf.js getTextContent — stable and gives real
  // selection); visual layout is dropped in favour of a clean, quotable reading column.
  import { renderMarkdown } from './markdown.js';
  import DOMPurify from 'dompurify';

  let { source = null, highlights = [], canQuote = true, onclose = null, onquote = null, onhighlight = null } = $props();

  let bodyEl;
  let pdfText = $state('');       // extracted PDF text (kind === 'pdf')
  let pdfStatus = $state('');     // '', 'loading', 'error'
  let _pdfKey = '';               // guard so we extract each pdf source once

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // extract PDF text off the render path; re-runs only when the source key changes
  $effect(() => {
    const s = source;
    if (!s || s.kind !== 'pdf' || !s.bytes) { return; }
    if (_pdfKey === s.key) return;
    _pdfKey = s.key; pdfText = ''; pdfStatus = 'loading';
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        try { pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString(); } catch (e) {}
        const doc = await pdfjs.getDocument({ data: s.bytes.slice() }).promise;
        let out = '';
        for (let p = 1; p <= doc.numPages; p++) {
          const page = await doc.getPage(p);
          const tc = await page.getTextContent();
          out += tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim() + '\n\n';
        }
        if (_pdfKey === s.key) { pdfText = out.trim(); pdfStatus = ''; }
      } catch (e) { if (_pdfKey === s.key) pdfStatus = 'error'; }
    })();
  });

  const html = $derived.by(() => {
    const s = source; if (!s) return '';
    if (s.kind === 'note' || s.kind === 'md') return renderMarkdown(s.body || '');
    if (s.kind === 'html') return DOMPurify.sanitize(s.html || '');
    if (s.kind === 'text') return textToHTML(s.body || '');
    if (s.kind === 'pdf') return pdfStatus === 'loading' ? '<p class="rmuted">Reading PDF…</p>' : pdfStatus === 'error' ? '<p class="rmuted">Couldn’t read this PDF.</p>' : textToHTML(pdfText);
    if (s.kind === 'epub' || s.kind === 'other') return '<p class="rmuted">Preview isn’t available for this format yet — open it in your system reader.</p>';
    return '';
  });
  function textToHTML(t) { return (t || '').split(/\n{2,}/).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join(''); }

  // apply persisted highlights by wrapping each stored snippet's occurrences in <mark>. Runs after
  // every render so it survives source/highlight changes; robust across PDFs and re-renders.
  $effect(() => {
    html; highlights;
    if (!bodyEl) return;
    queueMicrotask(() => { if (bodyEl) markHighlights(bodyEl, highlights); });
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
        try {
          const range = document.createRange();
          range.setStart(node, i); range.setEnd(node, i + needle.length);
          const mark = document.createElement('mark'); mark.className = 'rhl';
          range.surroundContents(mark);
        } catch (e) { /* snippet spans element boundaries — skip marking it */ }
      }
    }
  }

  function currentSelection() {
    const s = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (!s || s.rangeCount === 0) return '';
    if (bodyEl && !bodyEl.contains(s.anchorNode)) return '';   // only selections inside the reader
    return String(s).trim();
  }
  function quoteSel() { const t = currentSelection(); if (t && onquote) onquote(t); }
  function highlightSel() { const t = currentSelection(); if (t && onhighlight) onhighlight(t); }

  const sourceLabel = $derived(source ? (source.kind === 'note' ? 'Note' : source.kind === 'pdf' ? 'PDF' : source.kind === 'html' ? 'Web' : source.kind === 'epub' ? 'EPUB' : source.kind === 'md' ? 'Markdown' : 'Text') : '');
</script>

<div class="reader">
  <div class="rhead">
    <span class="rkind">{sourceLabel}</span>
    <span class="rtitle" title={source?.title || ''}>{source?.title || 'Reader'}</span>
    <span class="rsp"></span>
    <button class="rbtn" disabled={!canQuote} title={canQuote ? 'Quote the selected passage into the open note' : 'Open a note first to quote into it'} onclick={quoteSel}>❞ Quote</button>
    <button class="rbtn" title="Highlight the selected sentence" onclick={highlightSel}>✎ Mark</button>
    <button class="rbtn x" title="Close reader" aria-label="Close reader" onclick={() => onclose && onclose()}>✕</button>
  </div>
  <div class="readerbody" bind:this={bodyEl}>
    {#if source}
      {@html html}
    {:else}
      <p class="rmuted">Nothing open. Right-click a note or a reference to read it here.</p>
    {/if}
  </div>
</div>

<style>
  .reader { display: flex; flex-direction: column; height: 100%; min-height: 0; background: color-mix(in srgb, var(--canvas) 55%, var(--surface)); }
  .rhead { flex: none; display: flex; align-items: center; gap: .4rem; padding: .5rem .7rem; border-bottom: 1px solid var(--line); }
  .rkind { font-family: var(--mono); font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--accent); border: 1px solid var(--accent-soft); border-radius: 3px; padding: 0 .3rem; flex: none; }
  .rtitle { font-family: var(--serif); font-size: 14px; color: var(--fg-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rsp { flex: 1; }
  .rbtn { font-family: var(--sans); font-size: 11.5px; color: var(--fg-muted); background: none; border: 1px solid transparent; border-radius: 5px; padding: .22rem .45rem; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s, border-color .15s; }
  .rbtn:hover:not(:disabled) { background: var(--accent-soft); color: var(--fg-bright); border-color: var(--line-strong); }
  .rbtn:disabled { opacity: .4; cursor: default; }
  .rbtn.x { border: 0; font-size: 14px; }
  .readerbody { flex: 1; min-height: 0; overflow-y: auto; padding: 1rem 1.1rem 3rem; font-family: var(--serif); font-size: 15.5px; line-height: 1.6; color: var(--fg); }
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
