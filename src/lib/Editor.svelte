<script>
  import { onMount, onDestroy } from 'svelte';
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState, Annotation } from '@codemirror/state';
  const syncAnno = Annotation.define(); // marks a programmatic external-value resync
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';

  let { value = '', onchange, resemble = null } = $props();
  let el;      // the CodeMirror host
  let wrapEl;  // the positioning context for the margin mark
  let view;
  let hint = $state(null); // { id, title } — the note the current paragraph resembles
  let hintTop = $state(0); // vertical position of the mark, aligned to the cursor line
  let hintTimer;

  // ink-only highlighting: weight and style, never hue
  const inkHL = HighlightStyle.define([
    { tag: [t.heading, t.heading1, t.heading2, t.heading3], fontWeight: '600' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.link, textDecoration: 'underline' },
    { tag: t.url, opacity: '0.6' },
    { tag: [t.monospace], fontFamily: 'var(--mono)', fontSize: '0.9em' },
    { tag: [t.comment], opacity: '0.55', fontStyle: 'italic' },
    { tag: t.keyword, fontWeight: '600' },
    { tag: [t.processingInstruction, t.meta], opacity: '0.5' },
  ]);

  const theme = EditorView.theme({
    '&': { backgroundColor: 'transparent', color: 'var(--fg)', height: '100%' },
    '.cm-content': { fontFamily: 'var(--serif)', fontSize: '18px', lineHeight: '1.62', caretColor: 'var(--accent)', maxWidth: '42em', padding: '0 0 40vh 0' },
    '.cm-scroller': { fontFamily: 'var(--serif)', lineHeight: '1.62' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
    '.cm-gutters': { display: 'none' },
  });

  onMount(() => {
    view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            { key: 'Mod-b', run: () => { wrap('**'); return true; } },
            { key: 'Mod-i', run: () => { wrap('*'); return true; } },
            ...defaultKeymap, ...historyKeymap,
          ]),
          markdown(),
          syntaxHighlighting(inkHL),
          theme,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged && onchange && !u.transactions.some((tr) => tr.annotation(syncAnno))) onchange(u.state.doc.toString());
            if (resemble && (u.docChanged || u.selectionSet)) { clearTimeout(hintTimer); hintTimer = setTimeout(checkResemble, 500); }
          }),
          EditorView.domEventHandlers({ scroll() { if (hint) hint = null; return false; } }), // don't let the mark drift from its paragraph
        ],
      }),
    });
    view.focus();
  });
  onDestroy(() => { clearTimeout(hintTimer); if (view) view.destroy(); });

  // the "faint mark": if the current paragraph resembles another note, show a margin mark
  function checkResemble() {
    if (!view || !resemble) { hint = null; return; }
    const doc = view.state.doc;
    const head = view.state.selection.main.head;
    let a = doc.lineAt(head).number, b = a;
    while (a > 1 && doc.line(a - 1).text.trim()) a--;
    while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
    let para = ''; for (let n = a; n <= b; n++) para += doc.line(n).text + '\n';
    const m = resemble(para);
    if (m) {
      const coords = view.coordsAtPos(head);
      if (!coords) { hint = null; return; }   // can't align the mark this cycle — don't show it stale
      const host = (wrapEl || el).getBoundingClientRect();
      hintTop = Math.max(2, coords.top - host.top);
      hint = m;
    } else hint = null;
  }
  function placeLink() {
    if (!view || !hint || !hint.title || hint.title.includes(']')) { hint = null; return; } // unlinkable title
    const at = view.state.selection.main.to;  // append at the caret — never delete a live selection
    const ins = '[[' + hint.title + ']]';
    view.dispatch({ changes: { from: at, insert: ins }, selection: { anchor: at + ins.length } });
    view.focus(); hint = null;
  }

  // resync when the note body changes externally (e.g. an auto-added link),
  // guarded so the editor's own edits don't loop
  $effect(() => {
    const v = value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v }, annotations: syncAnno.of(true) });
    }
  });

  // --- formatting commands: insert Markdown around the selection or the current lines ---
  function wrap(before, after = before) {
    if (!view) return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: before + text + after },
      selection: text ? { anchor: sel.from + before.length, head: sel.from + before.length + text.length } : { anchor: sel.from + before.length },
    });
    view.focus();
  }
  function eachLine(fn) {
    if (!view) return;
    const sel = view.state.selection.main;
    const a = view.state.doc.lineAt(sel.from).number, b = view.state.doc.lineAt(sel.to).number;
    const changes = [];
    for (let n = a; n <= b; n++) { const line = view.state.doc.line(n); const c = fn(line); if (c) changes.push(c); }
    view.dispatch({ changes });
    view.focus();
  }
  function heading(hashes) {
    eachLine((line) => {
      const stripped = line.text.replace(/^#{1,6}\s+/, '');
      const cur = line.text.match(/^(#{1,6})\s/);
      const insert = cur && cur[1].length === hashes.length ? stripped : hashes + ' ' + stripped; // toggle same level off
      return { from: line.from, to: line.to, insert };
    });
  }
  function prefix(p) {
    eachLine((line) => (line.text.startsWith(p) ? { from: line.from, to: line.from + p.length, insert: '' } : { from: line.from, insert: p }));
  }
  function link() {
    if (!view) return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to) || 'text';
    const urlAt = sel.from + text.length + 3;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '[' + text + '](url)' }, selection: { anchor: urlAt, head: urlAt + 3 } });
    view.focus();
  }
</script>

<div class="editorwrap" bind:this={wrapEl}>
  <div class="fmtbar">
    <button type="button" title="Heading 1" onclick={() => heading('#')}>H1</button>
    <button type="button" title="Heading 2" onclick={() => heading('##')}>H2</button>
    <button type="button" title="Heading 3" onclick={() => heading('###')}>H3</button>
    <span class="fsep"></span>
    <button type="button" class="fb" title="Bold ({navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+B)" onclick={() => wrap('**')}>B</button>
    <button type="button" class="fi" title="Italic ({navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+I)" onclick={() => wrap('*')}>I</button>
    <button type="button" class="fm" title="Inline code" onclick={() => wrap('`')}>{'</>'}</button>
    <span class="fsep"></span>
    <button type="button" title="Link" onclick={link}>Link</button>
    <button type="button" title="Bullet list" onclick={() => prefix('- ')}>List</button>
    <button type="button" title="Quote" onclick={() => prefix('> ')}>Quote</button>
  </div>
  <div class="cm-host" bind:this={el}></div>
  {#if hint}
    {#key hint.id}
      <button class="resemble" style="top:{hintTop}px" title="This paragraph resembles “{hint.title}”. Click to link it." onclick={placeLink} onanimationend={() => (hint = null)}>
        <span class="rdot"></span><span class="rlabel">≈ {hint.title}</span>
      </button>
    {/key}
  {/if}
</div>

<style>
  .editorwrap { height: 100%; display: flex; flex-direction: column; position: relative; }
  .resemble { position: absolute; right: 0; z-index: 3; display: flex; align-items: center; gap: .35rem; background: none; border: 0; padding: .1rem; cursor: pointer; animation: resfade 5.5s ease-out forwards; }
  .resemble:hover { animation-play-state: paused; }
  .resemble .rdot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .resemble .rlabel { font-family: var(--sans); font-size: 11px; color: var(--fg-faint); opacity: 0; transition: opacity .15s; white-space: nowrap; max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
  .resemble:hover .rlabel { opacity: 1; }
  @keyframes resfade { 0% { opacity: 0; } 8% { opacity: .9; } 65% { opacity: .8; } 100% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .resemble { animation: none; opacity: .7; } }
  .fmtbar { flex: none; display: flex; align-items: center; gap: 1px; flex-wrap: wrap; padding: 0 0 .5rem 0; margin-bottom: .5rem; border-bottom: 1px solid var(--line); }
  .fmtbar button { font-family: var(--sans); font-size: 12px; color: var(--fg-muted); background: none; border: 0; border-radius: 5px; padding: .28rem .5rem; cursor: pointer; line-height: 1; }
  .fmtbar button:hover { background: var(--accent-soft); color: var(--fg-bright); }
  .fmtbar button.fb { font-weight: 700; }
  .fmtbar button.fi { font-style: italic; }
  .fmtbar button.fm { font-family: var(--mono); font-size: 11px; }
  .fsep { width: 1px; height: 15px; background: var(--line); margin: 0 .35rem; }
  .cm-host { flex: 1; min-height: 0; }
  .cm-host :global(.cm-editor) { height: 100%; }
</style>
