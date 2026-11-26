# Changelog

All notable changes to Arf are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Arf uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each released version
below matches a `v*` git tag and a GitHub Release; the release notes are generated
from the matching section of this file.

## [3.0.0] - 2026-11-26

### Added
- **A rebuilt knowledge graph.** The local and full-window graphs are now drawn on a canvas with a d3-force simulation. Drag a note and its linked notes are pulled along; release with Shift held, or double-click, to pin it in place (pins are remembered; "Unpin all" clears them). Zoom with the wheel or a pinch, pan with inertia, and fit the view with one button.
- **Graph tools.** The full-window graph has a search box that zooms to the matching note, a depth control (1, 2 or 3 links from the open note, or the whole vault), tag and folder filters, a switch to hide orphans, a Forces panel (repulsion, link distance, link strength, centring), and PNG and SVG export of the current view.
- **Suggested links in the graph.** The notes Resonance lists for the open note appear as dashed edges, so unlinked but similar notes are visible next to the real links. They can be hidden with one switch.
- **Keyboard and reduced motion in the graph.** Arrow keys move between linked notes, Enter opens one, P pins or unpins it, `+`, `-` and `0` zoom and fit, and Escape clears the selection. With reduced motion the layout is computed before it is shown, and nothing animates.
- **Import of Markdown notes.** Settings → Import and export imports single Markdown files, a whole folder (including an Obsidian or Jekyll vault) or a ZIP archive. Folders are kept, images referenced by notes in an imported folder or ZIP are copied into the vault, and Obsidian image embeds (`![[image.png]]`) become standard Markdown images. A note whose id is already in the vault keeps the newer copy.
- **Import of references.** BibTeX, RIS and CSL-JSON files add their entries to the Library; a work already there (same DOI, or same title, first author and year) is skipped.
- **Drag and drop to import.** Markdown files, ZIP archives, reference files and `.arf` bundles dropped on the window are imported.
- **Vault export as ZIP.** Settings → Export as ZIP writes every note as a Markdown file in its folder, the Library as `references.bib` and `references.json`, and, in the desktop app, the vault's images and reference files under `attachments/`. The archive can be imported again.
- **Link previews.** Resting the pointer on a `[[wikilink]]` in the reading view, or on a Resonance entry in the side panel, shows the linked note's title, the start of its text and its link counts. Keyboard focus shows the same card.
- **Backlink context.** Each entry under "Referenced in" shows the sentence in which the other note links to this one.
- **A model picker.** Settings → Connection suggestions lists the embedding models Arf can use, with their size and licence, and downloads, switches or removes them. It includes Arf's own models, ArfLLM and ArfLLM_Multi (see Models below), the two models earlier versions used, and any Hugging Face repository in the Transformers.js layout entered by id.

### Changed
- **No model ships with the app.** Connection suggestions are off until you turn them on, and every model is downloaded from Hugging Face only when you ask. The onnxruntime-web runtime is fetched from jsDelivr on first use and checked against SHA-384 hashes recorded at build time before it runs. Note text is never sent anywhere.
- **Smaller download and faster start.** The Windows installer is about 5.8 MB instead of about 9.8 MB, because the machine-learning runtime is no longer bundled. The script loaded at startup is about 0.4 MB instead of 1.1 MB; the editor, Library, reader, KaTeX and importers load when first needed.
- **Models run on the CPU, with visible progress.** Connection-suggestion models now always use the WebAssembly backend, so they work on machines without a usable GPU, and the first indexing of a vault shows "Indexing n / N" in the side panel. In the desktop app with a 304-note test vault this took about 0.3 s per note with ArfLLM and 0.5 s per note with ArfLLM_Multi; later edits re-embed only the notes that changed.
- **Faster vault sync.** The desktop app lists the vault folder with one native call and re-reads only the files whose size or modification time changed.
- **The local cache moved to IndexedDB.** Notes are cached per note instead of as one localStorage value, so large vaults (above about 1,500 notes in testing) no longer hit the browser storage limit or show a false "Couldn't save" banner. An existing cache is migrated on first launch.
- **Command palette.** Arrow keys move through the results and Enter opens the highlighted one; the list carries listbox roles for screen readers.
- **Design and accessibility.** Text that fell below WCAG AA contrast was darkened in both themes; buttons that rendered in the browser's default font now use Arf's fonts; controls that lacked a visible focus ring now have one; dialogs and menus have proper roles and keep focus inside while open; the context menu works from the keyboard (Shift+F10); closing panels fades out instead of vanishing; and the Read/Write controls no longer shift between modes.

### Fixed
- **Files without a frontmatter header no longer churn.** Such a file is dated by its modification time, so it is not treated as changed on every sync tick.
- **Edits made outside Arf update links and tags.** An external edit that kept the note's `updated` time now refreshes the index, the graph and the suggestions.
- **Deleted notes stay deleted.** A note deleted in Arf or on disk no longer reappears at the next launch.
- **Delete confirmations work in the desktop app.** Deleting a note, deleting a reference and removing a model ask for confirmation again; in earlier desktop builds the confirmation was bypassed and the action ran immediately.
- **Ticking a task checks the right line.** A task-like line inside a code block no longer shifts which checkbox a click in the reading view changes.
- **Folder names can be typed at once.** The name field for a new or renamed folder receives keyboard focus.
- **Folder collapse state is remembered** across launches.
- **Turkish file names.** Titles with a dotted capital İ produce correct file names, and existing files named by the earlier rule are not renamed while their title is unchanged.
- Actions on a note created moments earlier (delete, duplicate, copy as Markdown or wikilink, rename) no longer fail during the first fraction of a second.

### Models
- [ArfLLM](https://huggingface.co/tunabirgun/ArfLLM) contains the unmodified weights of all-MiniLM-L6-v2 in an int8 ONNX export prepared for Arf (inputs truncated at 256 tokens). No quality gain over the base model is claimed: the fine-tuned English candidates did not pass the acceptance rule fixed before training.
- [ArfLLM_Multi](https://huggingface.co/tunabirgun/ArfLLM_Multi) is a fine-tuned paraphrase-multilingual-MiniLM-L12-v2. On SCIDOCS (nDCG@10) it scores 1.3 points above its base model at the base's default settings (95% CI +0.6 to +2.0); compared with Arf 2.0's multilingual option it scores 5.3 points higher on SCIDOCS and 12.5 points higher on NFCorpus. No improvement is claimed for non-English scientific text.
- Each listed model has its own Resonance and Synthesis thresholds. A custom model's thresholds are derived from your own vault and need at least 29 notes; until then Arf uses word overlap.

## [2.0.0] - 2026-07-15

### Changed
- **A redesigned interface.** Arf's surfaces have been reworked while the ink-on-paper palette, EB Garamond, and the single iron-gall accent stay exactly as they were. The command palette and right-click menus now rest on a soft frosted glass; hairlines, shadows, and corners were retuned so every panel reads the same way; and chrome buttons press in like letterpress. Motion is deliberate throughout — notes cross-fade as you move between them, the sidebar animates when you reorder notes and folders, the segmented toggles slide, and a theme change fades instead of snapping. All of it honors your reduced-motion setting.

### Added
- **Reduce transparency.** A setting in Settings → Appearance makes the frosted menus and command palette solid, for anyone who prefers opaque surfaces. Arf also applies it on its own under Windows High Contrast and the system "reduce transparency" preference.

### Fixed
- **Renaming a note keeps its links.** When you change a note's title, every `[[link]]` in your other notes that pointed to it is rewritten to the new title, so an in-app rename no longer leaves those links dangling. Aliased links (`[[Title|shown as]]`) keep their display text, and links written inside code stay untouched. (Renaming or moving the file on disk was already safe.)
- **The command palette opens reliably right after launch.** Summoning it with `Ctrl/⌘+K` or the search box in the first moment after the app started could leave it blank; it now opens with your notes every time.
- **The right-click menu on a note is correct right after launch.** In that same first moment, right-clicking a note could show the general menu instead of the note's own actions; it now shows the right one.
- **Frosted surfaces stay solid in High Contrast mode.** Under Windows High Contrast the glass menus and palette now render opaque, so nothing shows through the text.

## [1.9.1] - 2026-07-14

### Added
- **Signed release manifests.** Every release now ships a `SHA256SUMS.txt` covering all assets, with a detached GPG signature made by the Arf release key (`RELEASE_SIGNING_KEY.asc` in the repository). Verification steps are in SECURITY.md.

### Changed
- The macOS first-launch instruction in the release notes now matches macOS 15 and later (*System Settings → Privacy & Security → Open Anyway*).

## [1.9.0] - 2026-07-11

### Added
- **Highlighter colours.** Mark a passage in the reader in one of five colours from the swatch row; click a highlight to remove it. Highlights travel with your vault and sync as before, and old single-colour highlights are kept.
- **Figures with automatic numbering.** A standalone image with a caption becomes a numbered figure — *Figure 1*, *Figure 2*, … — in the reading view and in exported PDF and HTML. Click any image to set its caption.
- **Image sizing.** Click an image in the reading view and choose Small, Medium, Large, or Full; the size is written into the note (`![caption|width](…)`) so it holds in the reader and in exports. You can also type the width by hand.
- **Fullscreen.** A Fullscreen control in the top bar (and F11) fills the screen. Focus mode now also goes fullscreen, and the two can be turned off independently.
- **A reading-width setting.** Choose Tight, Middle, or Comfy for the writing and reading column; each scales with the side panels, so the text uses the room it has without the lines ever running too long.

### Fixed
- **Highlighting a sentence with brackets or a link now works.** The reader matches text without being thrown off by parentheses, square brackets, or a citation or wikilink inside the passage — cases that previously left no mark.

### Changed
- **Focus mode shows only your writing.** It hides everything but the read/write column and the open reader; the top bar stays out of the way and slides in when you move the pointer to the top edge.

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

[3.0.0]: https://github.com/tunabirgun/arf/releases/tag/v3.0.0
[2.0.0]: https://github.com/tunabirgun/arf/releases/tag/v2.0.0
[1.9.1]: https://github.com/tunabirgun/arf/releases/tag/v1.9.1
[1.9.0]: https://github.com/tunabirgun/arf/releases/tag/v1.9.0
[1.8.0]: https://github.com/tunabirgun/arf/releases/tag/v1.8.0
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
