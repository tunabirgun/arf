# Arf

A local-first second brain for scientists and coders. Write notes on papers, books, and concepts; link them; and let a private, on-device engine surface the connections you didn't draw.

- **Use it now (web):** https://tunabirgun.github.io/arf-app/ — no install, no account
- **Download for desktop:** https://github.com/tunabirgun/arf/releases/latest — Windows, macOS, Linux
- **Documentation:** https://tunabirgun.github.io/arf-docs/

## What it does

- **Write** in Markdown, with LaTeX math and syntax-highlighted code.
- **Link** notes with `[[wikilinks]]`; backlinks and concept `#tags` build themselves. Links resolve by a stable id, so renaming a note never breaks them.
- **See** your knowledge as a graph — a local view beside each note and a full-window view of the whole vault, with zoom, pan, and multi-select.
- **Discover** with the on-device machine: **Resonance** surfaces notes similar to the one you're reading, and a weekly **Synthesis** digest points out pairs that belong together but were never linked. It runs entirely on your device — your notes never leave it.
- **Cite** from the **Library**: references of every kind, fetched from open sources, exported to BibTeX, RIS, CSL-JSON, formatted styles, and Zenodo.
- **Own your data**: your notes are plain Markdown files in a folder you choose — copy them to a USB stick, sync them through a folder or Git, and open them in any editor. Export any note to Markdown, HTML, or PDF.

## Run it

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dev        # http://localhost:5175
npm run build      # production web build → dist/
npm run preview
```

### Build the desktop app

The desktop app is built with [Tauri](https://tauri.app). You need the [Rust toolchain](https://rustup.rs) and, on Windows, the MSVC C++ build tools.

```bash
npm run tauri build
```

Installers are written to `src-tauri/target/release/bundle/`. Pushing a `v*` tag also builds Windows, macOS, and Linux installers automatically and attaches them to a GitHub Release.

## Built with

Svelte 5 + Vite, CodeMirror 6, KaTeX, marked, MiniSearch, Transformers.js (all-MiniLM-L6-v2), and Tauri 2 for the desktop app.

## License

MIT.
