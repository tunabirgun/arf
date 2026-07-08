# Changelog

All notable changes to Arf are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Arf uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each released version
below matches a `v*` git tag and a GitHub Release; the release notes are generated
from the matching section of this file.

## [1.5.0] - 2026-07-09

### Added
- Automated test suite: unit tests (Vitest) for vault parsing, wikilinks and tags,
  the folder tree and folder-move planning, citation formatting in every style,
  the `.arf` bundle, and the sync-merge/conflict logic; plus a Playwright end-to-end
  smoke test that creates a note, links and renames it, adds a citation, exports
  Markdown and HTML, and reloads to confirm nothing is lost.
- Continuous integration: builds and runs the test suite on every push and pull request.
- Open-source project files: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`,
  `ROADMAP.md`, `CODE_OF_CONDUCT.md`, and GitHub issue and pull-request templates.
- A concrete data-safety section (README and the docs "Your data" page) describing
  exactly what happens on rename, folder move, sync conflict, backup, and export failure.

### Changed
- The sync-merge, conflict-copy, `.arf` bundle, and folder-move logic were pulled out of
  the main component into small, separately tested modules. Behaviour is unchanged.
- Release notes are now generated from this changelog, so the release title and body
  always match the tag.

### Fixed
- The documentation site's top navigation no longer crowds on narrow/mobile screens.

## [1.4.1] - 2026-07-08

### Fixed
- Handle Turkish and other non-Latin characters correctly in note titles, filenames,
  tags, search, and suggestions.

## [1.4.0] - 2026-07-08

### Added
- Multilingual connection suggestions with an optional on-device multilingual model.
- The reference Library, `[@citekey]` citations, an optional end-of-note bibliography,
  and reference folders; two works by the same author in one year are disambiguated.
- Multi-select bulk export.
- Tickable task checkboxes in the reading view, and inline images.

## [1.3.1] - 2026-07-08

### Fixed
- Stop phantom "(conflict copy)" notes from appearing while editing a note whose file
  was being re-flushed. The conflict check now requires the remote copy to be strictly newer.

## [1.3.0] - 2026-07-08

### Added
- Drag and drop in the sidebar: file a note into a folder, nest one folder inside another,
  or drop onto the vault to move something back to the top level. Circular moves are refused.

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
- First public release: a local-first Markdown vault, `[[wikilinks]]` and backlinks,
  concept tags, a knowledge graph, on-device similarity (Resonance and the weekly
  Synthesis digest), continuous two-way folder sync, and document export.

[1.5.0]: https://github.com/tunabirgun/arf/releases/tag/v1.5.0
[1.4.1]: https://github.com/tunabirgun/arf/releases/tag/v1.4.1
[1.4.0]: https://github.com/tunabirgun/arf/releases/tag/v1.4.0
[1.3.1]: https://github.com/tunabirgun/arf/releases/tag/v1.3.1
[1.3.0]: https://github.com/tunabirgun/arf/releases/tag/v1.3.0
[1.2.0]: https://github.com/tunabirgun/arf/releases/tag/v1.2.0
[1.1.0]: https://github.com/tunabirgun/arf/releases/tag/v1.1.0
[1.0.0]: https://github.com/tunabirgun/arf/releases/tag/v1.0.0
