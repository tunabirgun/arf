# Arf

Desktop Markdown notebook for scientists and coders. Arf combines linked notes, LaTeX math, code, a reference library, a document reader and optional on-device embeddings for finding related notes.

[Download](https://github.com/tunabirgun/arf/releases/latest) · [Documentation](https://tunabirgun.github.io/arf/) · [Changelog](CHANGELOG.md)

![Arf note, references and graph](screenshot.png)

## Use

Choose a vault folder at first launch. Notes remain Markdown files; `[[wikilinks]]`, backlinks, tags and a graph connect them. The Library supports references and citation export, while the side reader opens PDF, EPUB and article content alongside a note.

Optional local embeddings support related-note suggestions and synthesis. The default model is English; a multilingual option is available in Settings. Export individual notes as Markdown, HTML or PDF, or back up the workspace as an `.arf` file.

## Data and network use

Notes and embedding computation stay on the device. Model downloads, reference searches and open-access document retrieval contact their respective external sources. If you place the vault in a third-party sync folder, that provider handles synchronization under its own terms.

Keep backups of the whole workspace, including attachments. Sync conflicts can produce a separate conflict copy for review; importing a workspace merges by ID without overwriting existing notes. Read [Your data](https://tunabirgun.github.io/arf/data.html) before moving or synchronizing a vault.

## Build from source

Requires Node.js 20+ (the project pins Node 24), Rust and the Tauri platform prerequisites; Windows also needs MSVC C++ build tools.

```bash
npm install
npm run tauri dev
npm run tauri build
npm test
npm run test:e2e
```

Installers are generated under `src-tauri/target/release/bundle/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for development, [SECURITY.md](SECURITY.md) for security reports and [ROADMAP.md](ROADMAP.md) for planned work.

[MIT](LICENSE) © Tuna Birgün.
