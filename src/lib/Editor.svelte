<script>
  import { onMount, onDestroy } from 'svelte';
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState, Annotation } from '@codemirror/state';
  const syncAnno = Annotation.define(); // marks a programmatic external-value resync
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';

  let { value = '', onchange } = $props();
  let el;
  let view;

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
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(inkHL),
          theme,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => { if (u.docChanged && onchange && !u.transactions.some((tr) => tr.annotation(syncAnno))) onchange(u.state.doc.toString()); }),
        ],
      }),
    });
    view.focus();
  });
  onDestroy(() => view && view.destroy());

  // resync when the note body changes externally (e.g. an auto-added link),
  // guarded so the editor's own edits don't loop
  $effect(() => {
    const v = value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v }, annotations: syncAnno.of(true) });
    }
  });
</script>

<div class="cm-host" bind:this={el}></div>

<style>
  .cm-host { height: 100%; }
  .cm-host :global(.cm-editor) { height: 100%; }
</style>
