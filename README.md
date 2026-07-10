<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="banner-dark.png">
    <img src="banner.png" alt="Arf" width="680">
  </picture>
</p>

<p align="center">
  A local-first second brain for scientists and coders.<br>
  Write notes, link them, and let a private on-device model surface the connections you didn't draw.
</p>

<p align="center">
  <a href="https://github.com/tunabirgun/arf/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/tunabirgun/arf?label=release&color=2c4a6e"></a>
  <a href="https://github.com/tunabirgun/arf/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/tunabirgun/arf/test.yml?branch=master&label=tests&color=2c4a6e"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2c4a6e.svg"></a>
  <img alt="Desktop: Windows, macOS, Linux" src="https://img.shields.io/badge/desktop-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-555">
  <a href="https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2"><img alt="AI assist: MiniLM, on-device" src="https://img.shields.io/badge/AI%20assist-MiniLM%20(on--device)-555"></a>
</p>

<p align="center">
  <a href="https://github.com/tunabirgun/arf/releases/latest"><b>Download</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://tunabirgun.github.io/arf/"><b>Documentation</b></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://youtu.be/0ClY352euog"><b>Teaser</b></a>
</p>

<p align="center">
  <img src="screenshot.png" alt="Arf — a note with rendered math, wikilinks, a citation, backlinks, resonance, and the local graph" width="900">
</p>

Your notes are plain Markdown files you own, and nothing leaves your device.

## Why Arf

Note collections rarely fail because capture was too hard. They fail because notes pile up faster than anyone connects them, and the insight that was supposed to emerge stays buried. Arf is built to fight that: it keeps your writing in plain files you control, and runs a small model on your own machine that notices when two of your thoughts belong together.

It is named after the mathematician Cahit Arf, whose Arf invariant reduces a complicated object to a single bit — connected, or not. Every note in Arf carries that mark: a filled dot when it has links, a hollow one while it is still an orphan.

## A look inside

<table>
<tr>
<td width="50%"><img src="docs/assets/gallery/plain-files.png" alt="A vault of plain Markdown files"><br><sub><b>Plain files.</b> A folder on your disk — copy it, sync it, open it in any editor.</sub></td>
<td width="50%"><img src="docs/assets/gallery/note.png" alt="A note with prose, typeset math, and code"><br><sub><b>One note.</b> Prose, typeset math, and code in one plain-text file.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/gallery/graph.png" alt="The knowledge graph"><br><sub><b>The graph.</b> Every <code>[[wikilink]]</code> is an edge; orphans stand alone.</sub></td>
<td width="50%"><img src="docs/assets/gallery/resonance.png" alt="Resonance — on-device similarity"><br><sub><b>Resonance.</b> On-device embeddings surface related notes you never linked.</sub></td>
</tr>
</table>

<p align="center"><a href="https://tunabirgun.github.io/arf/"><b>Take the tour →</b></a></p>

## Features

- **Write** in Markdown, with LaTeX math and syntax-highlighted code. The formatting toolbar inserts real Markdown — headings, bold, italic, strikethrough, inline code, links, bullet/numbered/task lists, quotes, code blocks, dividers, and images — and lists continue when you press Enter. Tick task checkboxes right in the reading view, insert an image from the toolbar or by paste/drop, and edit a note's tags above its title. Images render in the reading view and export centered, fit to the page.
- **Link** notes with `[[wikilinks]]`; backlinks and concept `#tags` build themselves. Links resolve by a stable id, so renaming a note never breaks them.
- **Organize** by dragging. Nest folders, move notes between them, and drag notes and folders into exactly the order you want — the arrangement is remembered and travels with the vault. Every surface has a context-aware right-click menu: a note, a folder, a link, a tag, a citation, the editor, the reading view, the reader, and a graph node each open the actions that fit.
- **See** your knowledge as a graph: a local view beside each note and a full-window view of the whole vault, with scroll-to-zoom, drag-to-pan, and Ctrl-click multi-select. It reads in ink — node size grows with links, filled circles have connections, hollow ones are orphans, dashed edges are the model's suggestions.
- **Discover** with the on-device model. **Resonance** surfaces notes similar to the one you are reading; the weekly **Synthesis** digest points out pairs that belong together but were never linked, and shows the concepts they share so you can see the connection at a glance. Turn the model on — or off — whenever you like; a fast light method fills in meanwhile.
- **Read your language.** The default embedding model reads English; Settings offers a multilingual model (~120 MB) that understands 50+ languages, including Turkish. A suggested connection is written in the note's own language — native phrasing for English, Turkish, German, French, Spanish, and Italian.
- **Read alongside.** Open another note, or a reference's PDF, EPUB, or article, in a side reader and write from it at the same time. PDFs open as rendered pages — scroll and zoom (fit-width, − / +, or Ctrl-scroll) — and EPUBs as clean, reflowable text. Select a passage and quote it straight into the open note as an attributed blockquote, or highlight the sentences that matter; highlights are saved beside your vault and travel with it, so they re-appear on another device.
- **Cite** from the **Library**. Add a reference by searching Crossref, Open Library, and Project Gutenberg (literary and philosophical texts) by title, author, or keyword and picking a result — or by pasting a DOI, ISBN, or arXiv ID. Cite it in a note with `[@citekey]` that jumps to the reference, and export to BibTeX, RIS, CSL-JSON, formatted styles (APA, Nature), and Zenodo. Insert a citation from the editor with the `@` picker — choosing whether it appears in the text, in the reference list only (like `\nocite`), or both — search your library by keyword, organize references into a nested folder tree, and attach a reader copy: a PDF or EPUB from your disk, or fetched from an open-access source. The open-access fetch searches Unpaywall, OpenAlex, Semantic Scholar, arXiv, and Europe PMC and downloads the copy through a native HTTP path, so publisher-hosted open-access PDFs (PLoS, Nature, and the like) come down correctly, not only arXiv preprints — and a public-domain book from Project Gutenberg arrives as an EPUB you can read inside Arf. Optionally append an end-of-note bibliography in APA or Nature style. Two works by the same author in one year are disambiguated automatically (Author 1981a / 1981b), in the text and the list.
- **Own your data.** Your notes are plain Markdown files in a folder you choose at first launch, with your uploaded PDFs and images organized in an `attachments/` folder beside them. Keep that folder in Dropbox, iCloud, OneDrive, Syncthing, or a Git repo and Arf keeps it in step continuously, both ways. Each note's header records both your local time and UTC, so timestamps read right wherever you are. Back up the whole workspace — notes, folders, references, and images — as one portable `.arf` file, and export any note to Markdown, HTML, or PDF, each with its own options.
- **Make it yours.** Light and dark themes on a warm ink-on-paper palette, an adjustable view zoom, a distraction-free Focus mode, resizable sidebars, smooth motion that honors your reduced-motion setting, and a `Ctrl/⌘+K` command palette.

## Open, by principle

Arf is free and MIT-licensed, and its privacy is not a promise — it is something you can check. The model runs on your machine because the code that loads it is in this repository; your notes stay yours because there is no server in the tree to send them to. Nothing here phones home, and you can read every line that proves it. Fork it, audit it, file an issue, or build your own from it.

## Private by construction

The model runs on your device — through the GPU where there is one, the CPU otherwise. Your notes are never uploaded, there is no account, and there is no server that could read them. Only the public model file (~23 MB, or ~120 MB for the multilingual option) is fetched once and cached. Privacy here is not a policy you have to trust; it is the architecture.

## Data safety

Your notes are the thing you cannot afford to lose, so every operation that touches a file is written to be safe rather than fast.

- **Rename or move a note.** Arf writes the new file first and removes the old one only after the write succeeds, so a note can never end up on neither path. If the write fails — a sync client holds the file, a reserved name, a path too long — the note stays where it was and Arf retries on the next sync tick. Each note is identified by a stable id in its frontmatter, not by its filename, so renaming or moving the `.md` file yourself never loses the note.
- **Move a folder.** Moving a folder rewrites the paths of its notes and subfolders in one step. A circular move (into its own descendant) and a move onto a name another subtree already owns are both refused, so two folders can never be silently merged into one.
- **Sync conflict.** When the vault folder is kept in Dropbox, iCloud, OneDrive, Syncthing, or Git, Arf reconciles by keeping the newer copy of each note. If the note you are editing also changed on another device, the remote version is kept beside yours as a `(conflict copy)` rather than overwritten — you choose which to keep. A note deleted on another device is tombstoned so it is not resurrected, and a delete that could not complete is retried.
- **Back up.** Export the whole workspace — every note, folder, and reference — as one portable `.arf` file. Import merges by id and never overwrites a note you already have; imported notes are written into your current vault, not tied back to the file they came from.
- **Export a note.** Exporting to Markdown, HTML, or PDF writes a separate file and never touches the note in your vault. If the save is cancelled or the target is not writable, Arf tells you and leaves everything as it was.

If the local cache ever becomes unreadable, Arf backs it up under a separate key instead of overwriting it, then rebuilds from the files on disk. The full account is on the [Your data](https://tunabirgun.github.io/arf/data.html) page.

## Build from source

Arf is a [Tauri 2](https://tauri.app) desktop app. You need [Node.js](https://nodejs.org) 18+, the [Rust toolchain](https://rustup.rs), and, on Windows, the MSVC C++ build tools.

```bash
npm install
npm run tauri dev      # run the desktop app against the Vite dev server
npm run tauri build    # installers → src-tauri/target/release/bundle/

npm test               # unit tests (Vitest)
npm run test:e2e       # end-to-end smoke test (Playwright)
```

Pushing a `v*` tag builds Windows, macOS, and Linux installers automatically and attaches them to a GitHub Release, with notes taken from [`CHANGELOG.md`](CHANGELOG.md). Every push and pull request runs the build and the test suite in CI.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup and how to run the tests, [SECURITY.md](SECURITY.md) to report a vulnerability, and [ROADMAP.md](ROADMAP.md) for where Arf is going. Release history is in [CHANGELOG.md](CHANGELOG.md).

## Built with

Svelte 5 + Vite, CodeMirror 6, KaTeX, marked, DOMPurify, MiniSearch, [pdf.js](https://mozilla.github.io/pdf.js/) and [fflate](https://github.com/101arrowz/fflate) (the PDF and EPUB reader), [Transformers.js](https://github.com/huggingface/transformers.js) (all-MiniLM-L6-v2 and paraphrase-multilingual-MiniLM-L12-v2), and Tauri 2 for the desktop app.

## License

[MIT](LICENSE) © Tuna Birgün
