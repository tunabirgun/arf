# Contributing to Arf

Thanks for your interest in Arf. It is a local-first second brain: a desktop app built
with Tauri 2 and Svelte 5, where your notes are plain Markdown files you own and the
similarity model runs on your own machine. Bug reports, fixes, and focused features are
all welcome.

## Ways to help

- **Report a bug.** Open an issue with the bug-report template. A small set of steps that
  reproduces it is worth more than a long description.
- **Suggest a feature.** Open an issue with the feature-request template. Arf aims to stay
  small and calm, so it is fine if not every idea fits — say what problem it solves.
- **Send a pull request.** For anything larger than a small fix, open an issue first so we
  can agree on the approach before you spend time on it.

## Development setup

You need [Node.js](https://nodejs.org) 18+, the [Rust toolchain](https://rustup.rs), and,
on Windows, the MSVC C++ build tools. See the platform notes in
[the Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run dev          # Vite dev server (web build) at http://localhost:5175
npm run tauri dev    # the desktop app against the dev server
npm run tauri build  # installers → src-tauri/target/release/bundle/
```

The web build (`npm run dev`) uses `localStorage` instead of the file vault, but runs the
same UI, so it is the fastest way to work on interface and logic. Anything that touches the
real vault (file reads/writes, sync) should also be checked in `npm run tauri dev`.

## Tests

The pure logic lives in small modules under `src/lib` so it can be tested without a browser.

```bash
npm test          # unit tests (Vitest)
npm run test:e2e  # end-to-end smoke test (Playwright, against the web build)
npm run build     # production build must stay green
```

Please add or update tests when you change behaviour, and run `npm test` and `npm run build`
before opening a pull request. CI runs both on every pull request.

Where you add logic, prefer a small pure function in `src/lib` (imported by the component)
over logic embedded in a `.svelte` file — it keeps the component thin and the behaviour testable.

## Pull request checklist

- The build passes (`npm run build`) and tests pass (`npm test`).
- New behaviour has a test.
- Commits are focused and their messages say what changed and why.
- The change keeps notes as plain files and keeps everything on-device — no telemetry,
  no network calls except the one-time public model download and the reference lookups
  the user explicitly triggers.

## Code style

Match the surrounding code: small modules, short hashtag-style comments, no large comment
blocks inside functions. Keep the accent palette and typography consistent with the rest of
the app and the docs.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE), the same license that covers the project.
