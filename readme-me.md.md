---
id: Arf/app/README.md
title: "README"
tags: []
created: 2026-07-06T09:32:49.307Z
updated: 2026-07-06T09:32:49.307Z
---

# Arf

A local-first second brain for scientists and coders. Write notes on papers, books, and concepts; link them; and let a private, on-device model surface the connections you didn't draw. Your notes are plain Markdown files you own, and nothing leaves your device.

[![Latest release](https://img.shields.io/github/v/release/tunabirgun/arf?label=release&color=2c4a6e)](https://github.com/tunabirgun/arf/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-2c4a6e.svg)](LICENSE)
![Desktop: Windows · macOS · Linux](https://img.shields.io/badge/desktop-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-555)
![On-device ML](https://img.shields.io/badge/ML-on--device-555)

- **Download:** <https://github.com/tunabirgun/arf/releases/latest> — Windows, macOS, Linux
- **Documentation:** <https://tunabirgun.github.io/arf/>

![Arf — a note with rendered math, wikilinks, a citation, backlinks, resonance, and the local graph](screenshot.png)

## Why Arf

Note collections rarely fail because capture was too hard. They fail because notes pile up faster than anyone connects them, and the insight that was supposed to emerge stays buried. Arf is built to fight that: it keeps your writing in plain files you control, and runs a small model on your own machine that notices when two of your thoughts belong together.

It is named after the mathematician Cahit Arf, whose Arf invariant reduces a complicated object to a single bit — connected, or not. Every note in Arf carries that mark: a filled dot when it has links, a hollow one while it is still an orphan.

## Features

- **Write** in Markdown, with LaTeX math and syntax-highlighted code. The formatting toolbar inserts real Markdown — headings, bold, italic, strikethrough, inline code, links, bullet/numbered/task lists, quotes, code blocks, and dividers — and lists continue when you press Enter.
- **Link** notes with `[[wikilinks]]`; backlinks and concept `#tags` build themselves. Links resolve by a stable id, so renaming a note never breaks them.
- **See** your knowledge as a graph: a local view beside each note and a full-window view of the whole vault, with scroll-to-zoom, drag-to-pan, and Ctrl-click multi-select. It reads in ink — node size grows with links, filled circles have connections, hollow ones are orphans, dashed edges are the model's suggestions.
- **Discover** with the on-device model. **Resonance** surfaces notes similar to the one you are reading; the weekly **Synthesis** digest points out pairs that belong together but were never linked, and shows the concepts they share so you can see the connection at a glance. A **faint mark** appears in the margin while you write when a paragraph resembles an older note.
- **Read your language.** The default embedding model reads English; Settings offers a multilingual model (~120 MB) that understands 50+ languages, including Turkish, so suggestions work whatever language you think in.
- **Cite** from the **Library**. References are fetched live from Crossref and Open Library by DOI, ISBN, or arXiv ID, cited in notes with `[@citekey]` that jump to the reference, and exported to BibTeX, RIS, CSL-JSON, formatted styles (APA, Nature), and Zenodo.
- **Own your data.** Your notes are plain Markdown files in a folder you choose at first launch. Keep that folder in Dropbox, iCloud, OneDrive, Syncthing, or a Git repo and Arf keeps it in step continuously, both ways. Back up the whole workspace as one `.arf` file, and export any note to Markdown, HTML, or PDF.
- **Make it yours.** Light and dark themes on a warm ink-on-paper palette, an adjustable view zoom, a distraction-free Focus mode, resizable sidebars, and a `Ctrl/⌘+K` command palette.

## Private by construction

The model runs on your device — through the GPU where there is one, the CPU otherwise. Your notes are never uploaded, there is no account, and there is no server that could read them. Only the public model file (~23 MB, or ~120 MB for the multilingual option) is fetched once and cached. Privacy here is not a policy you have to trust; it is the architecture.

## Build from source

Arf is a [Tauri 2](https://tauri.app) desktop app. You need [Node.js](https://nodejs.org) 18+, the [Rust toolchain](https://rustup.rs), and, on Windows, the MSVC C++ build tools.

```bash
npm install
npm run tauri dev      # run the desktop app against the Vite dev server
npm run tauri build    # installers → src-tauri/target/release/bundle/
```

Pushing a `v*` tag builds Windows, macOS, and Linux installers automatically and attaches them to a GitHub Release.

## Built with

Svelte 5 + Vite, CodeMirror 6, KaTeX, marked, DOMPurify, MiniSearch, [Transformers.js](https://github.com/huggingface/transformers.js) (all-MiniLM-L6-v2 and paraphrase-multilingual-MiniLM-L12-v2), and Tauri 2 for the desktop app.

## License

[MIT](LICENSE) © Tuna Birgün
