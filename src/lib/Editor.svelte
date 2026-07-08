<script>
  import { onMount, onDestroy } from 'svelte';
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState, Annotation } from '@codemirror/state';
  const syncAnno = Annotation.define(); // marks a programmatic external-value resync
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
  import { tags as hlTags } from '@lezer/highlight';

  let { value = '', onchange, resemble = null, oncite = null } = $props();
  // markers this editor treats as interchangeable list/quote prefixes, so a toolbar
  // button converts one into another instead of stacking or half-stripping it
  const LIST_MARKER = /^(- \[[ xX]\] |[-*+] |\d+\. |> )/;
  let el;      // the CodeMirror host
  let wrapEl;  // the positioning context for the margin mark
  let view;
  let hint = $state(null); // { id, title } — the note the current paragraph resembles
  let hintTop = $state(0); // vertical position of the mark, aligned to the cursor line
  let hintTimer;

  // ink-only highlighting: weight and style, never hue
  const inkHL = HighlightStyle.define([
    { tag: [hlTags.heading, hlTags.heading1, hlTags.heading2, hlTags.heading3], fontWeight: '600' },
    { tag: hlTags.strong, fontWeight: '700' },
    { tag: hlTags.emphasis, fontStyle: 'italic' },
    { tag: hlTags.link, textDecoration: 'underline' },
    { tag: hlTags.url, opacity: '0.6' },
    { tag: [hlTags.monospace], fontFamily: 'var(--mono)', fontSize: '0.9em' },
    { tag: [hlTags.comment], opacity: '0.55', fontStyle: 'italic' },
    { tag: hlTags.keyword, fontWeight: '600' },
    { tag: [hlTags.processingInstruction, hlTags.meta], opacity: '0.5' },
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
            { key: 'Enter', run: continueList },
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
    if (!view) return;
    const cur = view.state.doc.toString();
    if (v === cur) return;
    // minimal-diff replace (keep the common prefix/suffix) so an external edit — e.g. an auto-added
    // link appended to the body — doesn't reset the caret to 0 and scroll the editor to the top
    const alen = cur.length, blen = v.length;
    let s = 0; while (s < alen && s < blen && cur.charCodeAt(s) === v.charCodeAt(s)) s++;
    let e = 0; while (e < alen - s && e < blen - s && cur.charCodeAt(alen - 1 - e) === v.charCodeAt(blen - 1 - e)) e++;
    view.dispatch({ changes: { from: s, to: alen - e, insert: v.slice(s, blen - e) }, annotations: syncAnno.of(true) });
  });

  // under prefers-reduced-motion the CSS fade is disabled, so dismiss the faint mark on a timer instead
  const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  $effect(() => {
    if (hint && reduceMotion) { const t = setTimeout(() => (hint = null), 6000); return () => clearTimeout(t); }
  });

  // --- formatting commands: markdown around the selection, with the cursor left where you'd type ---
  // wrap the selection in markers (or, with no selection, drop the markers and put the cursor between them);
  // if the selection is already wrapped, toggle the markers off.
  function wrap(before, after = before) {
    if (!view) return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    const outer = view.state.sliceDoc(Math.max(0, sel.from - before.length), Math.min(view.state.doc.length, sel.to + after.length));
    if (text && outer === before + text + after) {
      view.dispatch({ changes: { from: sel.from - before.length, to: sel.to + after.length, insert: text }, selection: { anchor: sel.from - before.length, head: sel.to - before.length } });
    } else {
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: before + text + after },
        selection: text ? { anchor: sel.from + before.length, head: sel.from + before.length + text.length } : { anchor: sel.from + before.length },
      });
    }
    view.focus();
  }
  // set the current line's heading level (toggle off if it is already that level); cursor lands at the end, ready to type
  function setHeading(hashes) {
    if (!view) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const stripped = line.text.replace(/^#{1,6}\s+/, '');
    const cur = line.text.match(/^(#{1,6})\s/);
    const out = cur && cur[1].length === hashes.length ? stripped : hashes + ' ' + stripped;
    view.dispatch({ changes: { from: line.from, to: line.to, insert: out }, selection: { anchor: line.from + out.length } });
    view.focus();
  }
  // toggle a line prefix (bullet, quote, task) on every selected line; leave the cursor at the line end
  function togglePrefix(p) {
    if (!view) return;
    const doc = view.state.doc, sel = view.state.selection.main;
    const lines = []; for (let n = doc.lineAt(sel.from).number; n <= doc.lineAt(sel.to).number; n++) lines.push(doc.line(n));
    const markerOf = (l) => (l.text.match(LIST_MARKER) || [''])[0];
    // toggle off only when every line's marker is exactly p; otherwise replace whatever
    // sibling marker is there (task↔bullet↔quote) rather than half-stripping or stacking it
    const allHave = lines.every((l) => markerOf(l) === p);
    view.dispatch({ changes: lines.map((l) => { const cur = markerOf(l); return { from: l.from, to: l.from + cur.length, insert: allHave ? '' : p }; }) });
    view.dispatch({ selection: { anchor: view.state.doc.lineAt(view.state.selection.main.head).to } });
    view.focus();
  }
  function orderedList() {
    if (!view) return;
    const doc = view.state.doc, sel = view.state.selection.main;
    const a = doc.lineAt(sel.from).number, b = doc.lineAt(sel.to).number;
    const lines = []; for (let n = a; n <= b; n++) lines.push(doc.line(n));
    const allNum = lines.every((l) => /^\d+\.\s/.test(l.text));
    let i = 1; const changes = lines.map((l) => { const cur = (l.text.match(LIST_MARKER) || [''])[0]; return { from: l.from, to: l.from + cur.length, insert: allNum ? '' : (i++) + '. ' }; });
    view.dispatch({ changes });
    view.dispatch({ selection: { anchor: view.state.doc.lineAt(view.state.selection.main.head).to } });
    view.focus();
  }
  function link() {
    if (!view) return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (text) { const at = sel.from + text.length + 3; view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '[' + text + '](url)' }, selection: { anchor: at, head: at + 3 } }); }
    else view.dispatch({ changes: { from: sel.from, insert: '[](url)' }, selection: { anchor: sel.from + 1 } }); // cursor in the label slot
    view.focus();
  }
  function codeBlock() {
    if (!view) return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '```\n' + text + '\n```' }, selection: { anchor: sel.from + 4 + text.length } });
    view.focus();
  }
  function insertRule() {
    if (!view) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const ins = (line.text.trim() ? '\n\n' : '') + '---\n';
    view.dispatch({ changes: { from: line.to, insert: ins }, selection: { anchor: line.to + ins.length } });
    view.focus();
  }
  // --- imperative API for the right-click menu (operates directly on the CodeMirror view) ---
  export function edHasSelection() { const s = view && view.state.selection.main; return !!s && s.from !== s.to; }
  export function edCopy() { if (!view) return ''; const s = view.state.selection.main; return view.state.sliceDoc(s.from, s.to); }
  export function edCut() { if (!view) return ''; const s = view.state.selection.main; const t = view.state.sliceDoc(s.from, s.to); if (s.from !== s.to) view.dispatch({ changes: { from: s.from, to: s.to, insert: '' }, selection: { anchor: s.from } }); view.focus(); return t; }
  export function edPaste(txt) { if (!view || txt == null) return; const s = view.state.selection.main; view.dispatch({ changes: { from: s.from, to: s.to, insert: txt }, selection: { anchor: s.from + txt.length } }); view.focus(); }
  export function edSelectAll() { if (!view) return; view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); }
  export function edFormat(kind) {
    if (!view) return;
    if (kind === 'bold') wrap('**'); else if (kind === 'italic') wrap('*'); else if (kind === 'strike') wrap('~~');
    else if (kind === 'code') wrap('`'); else if (kind === 'link') link(); else if (kind === 'h1') setHeading('#');
    else if (kind === 'h2') setHeading('##'); else if (kind === 'quote') togglePrefix('> '); else if (kind === 'bullet') togglePrefix('- ');
  }

  // pressing Enter inside a list/quote continues it (empty item exits); makes lists feel like a word processor
  function continueList(v) {
    const sel = v.state.selection.main; if (!sel.empty) return false;
    const line = v.state.doc.lineAt(sel.head);
    const m = line.text.match(/^(\s*)(- \[[ xX]\] |[-*+] |\d+\. |> )(.*)$/);
    if (!m) return false;
    if (!m[3].trim()) { v.dispatch({ changes: { from: line.from, to: line.to, insert: m[1] }, selection: { anchor: line.from + m[1].length } }); return true; } // empty item → exit
    let marker = m[2].replace(/\[[xX]\]/, '[ ]'); // new task starts unchecked
    const num = m[2].match(/^(\d+)\. /); if (num) marker = (parseInt(num[1], 10) + 1) + '. ';
    const ins = '\n' + m[1] + marker;
    v.dispatch({ changes: { from: sel.head, insert: ins }, selection: { anchor: sel.head + ins.length } });
    return true;
  }
</script>

<div class="editorwrap" bind:this={wrapEl}>
  <div class="fmtbar">
    <button type="button" title="Heading 1" onclick={() => setHeading('#')}>H1</button>
    <button type="button" title="Heading 2" onclick={() => setHeading('##')}>H2</button>
    <button type="button" title="Heading 3" onclick={() => setHeading('###')}>H3</button>
    <span class="fsep"></span>
    <button type="button" class="fb" title="Bold  ·  {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+B" onclick={() => wrap('**')}>B</button>
    <button type="button" class="fi" title="Italic  ·  {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+I" onclick={() => wrap('*')}>I</button>
    <button type="button" class="fst" title="Strikethrough" onclick={() => wrap('~~')}>S</button>
    <button type="button" class="fm" title="Inline code" onclick={() => wrap('`')}>{'</>'}</button>
    <span class="fsep"></span>
    <button type="button" title="Link" onclick={link}>Link</button>
    {#if oncite}<button type="button" class="fsym" title="Insert citation" onclick={() => oncite()}>@</button>{/if}
    <span class="fsep"></span>
    <button type="button" class="fsym" title="Bullet list" onclick={() => togglePrefix('- ')}>•</button>
    <button type="button" class="fsym" title="Numbered list" onclick={orderedList}>1.</button>
    <button type="button" class="fsym" title="Task list" onclick={() => togglePrefix('- [ ] ')}>☐</button>
    <button type="button" class="fsym" title="Quote" onclick={() => togglePrefix('> ')}>❝</button>
    <span class="fsep"></span>
    <button type="button" class="fm" title="Code block" onclick={codeBlock}>{'{ }'}</button>
    <button type="button" class="fsym" title="Divider" onclick={insertRule}>―</button>
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
  .fmtbar button.fst { text-decoration: line-through; }
  .fmtbar button.fm { font-family: var(--mono); font-size: 11px; }
  .fmtbar button.fsym { font-size: 13px; min-width: 1.6em; }
  .fsep { width: 1px; height: 15px; background: var(--line); margin: 0 .35rem; }
  .cm-host { flex: 1; min-height: 0; }
  .cm-host :global(.cm-editor) { height: 100%; }
</style>
