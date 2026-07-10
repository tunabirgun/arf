# Changelog

All notable changes to Arf are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Arf uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each released version
below matches a `v*` git tag and a GitHub Release; the release notes are generated
from the matching section of this file.

## [1.8.0] - 2026-07-10

### Added
- **Show or hide either side panel.** A button in the top bar collapses the notes sidebar, and another collapses the right panel (backlinks, Resonance, and the local graph — or the reader when a document is open). Each choice is remembered between sessions, and opening something in the reader brings the right panel back on its own.

### Changed
- **The side panels resize much wider.** The old fixed width limit is gone. A panel now grows until the note column reaches a readable minimum, so a PDF or a reference can take most of the window when you want to read it. The note column never collapses: a width saved on a larger window, or set while the other panel was hidden, is reined back within the current window when the window shrinks or the panel returns.
- **A PDF fits the reader's width as you resize it.** The page rescales to the panel on every drag and stays fit-width by default. A manual zoom (− / +, Ctrl-scroll, or the percentage) pins the scale until you press Fit again; a newly opened PDF starts fit-width.

## [1.7.0] - 2026-07-10

### Added
- **A page-view PDF reader.** An attached or fetched PDF now opens as rendered pages in the side reader — scrollable, zoomable (fit-width, − / +, or Ctrl-scroll), with a selectable text layer — instead of a plain text column. Quote and highlight work directly on the page.
- **EPUB reading.** Attach or fetch an EPUB and read it in the side reader as clean, reflowable text with its images inlined; chapters follow the book's own reading order.
- **Project Gutenberg as a reference source.** Search the Add-reference box for literary and philosophical texts (Kant, Shelley, and the rest of the public domain) and fetch a public-domain EPUB copy to read inside Arf.
- **Highlights that travel with your vault.** Reader highlights are written to a `reader-highlights.json` sidecar and carried in the `.arf` bundle, so they sync alongside your notes and references and re-appear on another device. Highlighting works in both the PDF viewer and the EPUB reader.
- **A mark on exported pages.** Exported PDF and HTML carry a small, transparent Arf mark in the top-right corner — and nothing else in the header or footer.

### Fixed
- **Fetching an open-access PDF now works for publisher-hosted papers, not only arXiv.** The download runs through a native HTTP client that isn't bound by the web view's cross-origin rules, so a paper hosted on PLoS, Nature, MDPI, and other open-access sites downloads correctly. Discovery queries Unpaywall, OpenAlex, Semantic Scholar, arXiv, and Europe PMC, prefers a repository copy over a bot-walled publisher copy, and verifies every download is a real PDF before saving it.
- **The side reader no longer opens a PDF to a blank panel.** Applying highlights had corrupted the reader's content region on a later update, which blanked PDFs whose text arrives after extraction.

### Changed
- Reference search now also covers Project Gutenberg, alongside Crossref and Open Library.
- Reader scrolling is smoothed.

## [1.6.1] - 2026-07-10

### Fixed
- **Drag and drop now works in the desktop app.** Moving notes into folders, nesting folders, reordering notes and folders, and dragging references onto Library folders were silently broken in the packaged app because the window's OS-level drag-drop handler intercepted the events. It is now disabled so in-app HTML5 drag and drop works — and dropping an image file into the editor works too.
- **PDF export works on macOS and Linux.** Export now prints the document itself rather than a hidden frame, which the macOS/Linux system webviews silently ignored.
- **Note images render wherever your vault lives.** Images are inlined directly in the reading view instead of through a scoped file protocol, so they show correctly for a vault on any drive or folder, including after a restart.
- **Copy and paste from the right-click menu** now use the system clipboard reliably on macOS and Linux.
- **Turkish author names make correct citekeys.** A dotless ı (Kılıç, Yıldız, Işık) is folded to i rather than dropped.
- **The end-of-note reference list is always readable prose.** Its style is limited to APA and Nature (the machine formats — BibTeX, RIS, CSL-JSON, Zenodo — stay in the Library export where they belong), and same-author/same-year entries carry the a/b suffix that matches the in-text citation.
- The on-device model's status and Disable control in Settings are vertically aligned.

### Added
- **Search online databases to add a reference.** Alongside pasting a DOI/ISBN/arXiv ID, you can now search Crossref and Open Library by title, author, or keyword and pick a result to add.
- **Choose where a citation appears.** For each `[@key]`, pick in-text + reference list (the default), in-text only, or reference-list only (like `\nocite`) — from the citation picker, no syntax to learn.
- **Click a dangling `[[wikilink]]`** in the reading view to create that note.
- **The sidebar auto-scrolls while dragging** near its top or bottom edge, so an off-screen folder is reachable without releasing the drag.
- Keyboard focus rings on text fields, dialog focus containment (the background is inert while a dialog is open), and focus returns to its origin on close.

### Changed
- Faster at scale: the weekly Synthesis no longer computes while closed, the folder sync skips its re-read while the window is hidden, the link index is rebuilt on a short debounce instead of on every keystroke, and the Rust core is compiled for speed.

## [1.6.0] - 2026-07-10

### Added
- **Side reader.** Open another note, or a reference's attached PDF, EPUB, or article, in a panel beside the editor and write from it. Select a passage and quote it into the open note as an attributed blockquote, or highlight the sentences that matter — from the reader's right-click menu or its header.
- **Reference attachments.** Attach a PDF, EPUB, or other reader file from your disk, or fetch an open-access copy where one exists, and read it in the side reader. Files are organized under an `attachments/` folder in the vault and travel in the `.arf` bundle.
- **Library keyword search** across every field — author, title, year, venue, DOI, ISBN, abstract — with prefix and light fuzzy matching, and a **nested folder tree** for references that matches the notes sidebar, including empty folders you make ahead of time.
- **Drag to reorder** notes and folders in the sidebar; the order is remembered in a sidecar file and travels with the vault.
- **Specialized right-click menus** for the knowledge graph (nodes and background), the Library (folders and background), and the reader, alongside the existing note, folder, tag, link, citation, editor, and reading-view menus.
- **Insert images** from the editor toolbar or its right-click menu. In the desktop app images are stored as organized files under `attachments/images/` and shown in the reading view; images export centered and fit to the page, keeping their proportions.
- A control to turn the **on-device model off** again, not only on.
- Each note's header now records both **local time** (with the system's UTC offset) and **UTC**, so timestamps read correctly wherever a note was written.

### Changed
- The **Export dialog** shows only the options that fit the chosen format — Markdown offers a keep-frontmatter toggle; PDF offers page size and margins — instead of PDF page settings for every format.
- Interface transitions were smoothed throughout and honor the operating system's reduced-motion setting.
- The `.arf` workspace bundle now carries the Library's folder tree and inlines note images, so the file stays self-contained.

### Fixed
- A Markdown, text, or HTML file attached to a reference is no longer mistaken for a note.
- Moving or deleting a note or folder no longer leaves a stale manual-order rank behind.
- The reader's quote and highlight actions stay reachable even when a link or citation sits under the pointer in the reading text.

## [1.5.1] - 2026-07-09

### Fixed
- Dialog windows that are taller than the screen — Settings in particular — now scroll, so their lower rows stay reachable on short windows, zoomed-in views, and small screens. Previously the bottom of a long dialog could run off the edge with no way to reach it.

## [1.5.0] - 2026-07-09

### Added
- Automated test suite: unit tests (Vitest) for vault parsing, wikilinks and tags, the folder tree and folder-move planning, citation formatting in every style, the `.arf` bundle, and the sync-merge/conflict logic; plus a Playwright end-to-end smoke test that creates a note, links and renames it, adds a citation, exports Markdown and HTML, and reloads to confirm nothing is lost.
- Continuous integration: builds and runs the test suite on every push and pull request.
- Open-source project files: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `ROADMAP.md`, `CODE_OF_CONDUCT.md`, and GitHub issue and pull-request templates.
- A concrete data-safety section (README and the docs "Your data" page) describing exactly what happens on rename, folder move, sync conflict, backup, and export failure.

### Changed
- The sync-merge, conflict-copy, `.arf` bundle, and folder-move logic were pulled out of the main component into small, separately tested modules. Behaviour is unchanged.
- Release notes are now generated from this changelog, so the release title and body always match the tag.

### Fixed
- The documentation site's top navigation no longer crowds on narrow/mobile screens.

## [1.4.1] - 2026-07-08

### Fixed
- Handle Turkish and other non-Latin characters correctly in note titles, filenames, tags, search, and suggestions.

## [1.4.0] - 2026-07-08

### Added
- Multilingual connection suggestions with an optional on-device multilingual model.
- The reference Library, `[@citekey]` citations, an optional end-of-note bibliography, and reference folders; two works by the same author in one year are disambiguated.
- Multi-select bulk export.
- Tickable task checkboxes in the reading view, and inline images.

## [1.3.1] - 2026-07-08

### Fixed
- Stop phantom "(conflict copy)" notes from appearing while editing a note whose file was being re-flushed. The conflict check now requires the remote copy to be strictly newer.

## [1.3.0] - 2026-07-08

### Added
- Drag and drop in the sidebar: file a note into a folder, nest one folder inside another, or drop onto the vault to move something back to the top level. Circular moves are refused.

## [1.2.0] - 2026-07-08

### Fixed
- Reliability fixes from a codebase-wide bug audit across parsing, sync, and the UI.

## [1.1.0] - 2026-07-07

### Added
- The connect-notes modal and the documentation gallery.

### Fixed
- Math rendering in the reading view.

## [1.0.0] - 2026-07-06

### Added
- First public release: a local-first Markdown vault, `[[wikilinks]]` and backlinks, concept tags, a knowledge graph, on-device similarity (Resonance and the weekly Synthesis digest), continuous two-way folder sync, and document export.

[1.7.0]: https://github.com/tunabirgun/arf/releases/tag/v1.7.0
[1.6.1]: https://github.com/tunabirgun/arf/releases/tag/v1.6.1
[1.6.0]: https://github.com/tunabirgun/arf/releases/tag/v1.6.0
[1.5.1]: https://github.com/tunabirgun/arf/releases/tag/v1.5.1
[1.5.0]: https://github.com/tunabirgun/arf/releases/tag/v1.5.0
[1.4.1]: https://github.com/tunabirgun/arf/releases/tag/v1.4.1
[1.4.0]: https://github.com/tunabirgun/arf/releases/tag/v1.4.0
[1.3.1]: https://github.com/tunabirgun/arf/releases/tag/v1.3.1
[1.3.0]: https://github.com/tunabirgun/arf/releases/tag/v1.3.0
[1.2.0]: https://github.com/tunabirgun/arf/releases/tag/v1.2.0
[1.1.0]: https://github.com/tunabirgun/arf/releases/tag/v1.1.0
[1.0.0]: https://github.com/tunabirgun/arf/releases/tag/v1.0.0
