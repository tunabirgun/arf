# Arf — the app

The real Arf application: a local-first second brain for scientists and coders,
built with **Svelte 5 (runes) + Vite** as an installable, offline **PWA**. This is
the web target of the plan in `../ARF-IMPLEMENTATION-PLAN.md`; the Tauri v2 desktop
shell (for a real plain-file vault) is the remaining platform piece.

## Run it

```bash
cd app
npm install
npm run dev      # http://localhost:5175
npm run build    # production build to app/dist (also emits a service worker + manifest)
npm run preview
```

Requires Node (tested on v24). No other toolchain for the web build.

## What's implemented (and verified by rendering)

- **Vault** — notes with a stable ULID id, title, tags, timestamps, Markdown body;
  autosave. `lib/vault.js` also emits the real on-disk Markdown + YAML-frontmatter
  form via `toMarkdown()`. (Storage here is `localStorage` as the browser stand-in
  for the real plain-file vault — the note *shape* is the shipping one.)
- **Editor** — Write mode is a real **CodeMirror 6** Markdown editor (ink-only
  highlighting); Read mode renders Markdown with **KaTeX** math, resolved
  `[[wikilinks]]`, clickable `#tags`, blockquotes, code, lists, and tables.
- **Links & tags** — `[[wikilinks]]` resolve by title to a stable id; backlinks are
  computed ("Referenced in N"); a tag cloud filters the note list.
- **Search** — a Cmd/Ctrl+K palette with a lexical tier and an on-device "Related" tier.
- **Graph** — a rail ego-graph and a full-window force-directed vault graph with
  wheel zoom, pan, hover-highlight, node drag, click-to-open, and Ctrl+right-click
  multi-select.
- **On-device machine** — real TF-IDF cosine similarity (private, no download;
  debounced so typing never triggers a full rescan) drives **Resonance** and the
  weekly **Synthesis digest**. `lib/graphindex.js` is the seam where the shipping
  app swaps in MiniLM embeddings (Transformers.js).
- **Library** — references of every type (articles, books, magazines, preprints,
  archived webpages) with type filters, a detail panel with provenance, a
  multi-source "Add reference" fetch, and export to BibTeX, RIS, CSL-JSON, APA,
  Nature, and Zenodo.
- **Focus mode**, universal keyboard shortcuts (Ctrl on Win/Linux, ⌘ on Mac),
  light/dark, and PWA install + offline.

## What's next (per the plan)

- **Tauri v2 desktop shell** + the real plain-file vault (File System Access / OPFS
  adapters) — needs the Rust toolchain, not present in the build environment used here.
- **Editor Phase 2** — Typora-style live-preview, a selection bubble toolbar, and a
  `/` slash menu; then the opt-in Milkdown rich-text mode
  (see `../research/wysiwyg-editor-recommendation.md`).
- **MiniLM embeddings** in place of TF-IDF; real DOI network fetch in place of the
  small mock lookup; incremental indexing and code-splitting for large vaults.

## Files

`src/App.svelte` (shell), `src/lib/vault.js`, `src/lib/graphindex.js`,
`src/lib/markdown.js`, `src/lib/Editor.svelte`, `src/lib/GraphView.svelte`,
`src/lib/Library.svelte`, `src/appshell.css`, `src/app.css`.
