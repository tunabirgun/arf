# Roadmap

These are directions, not promises. Arf is meant to stay small and calm, so the bar for
adding anything is that it helps you write notes and see the connections between them —
without a server, an account, or a lock-in format. Dates are deliberately absent; things
land when they are ready. Open an issue to discuss any of these or to propose your own.

## Near term

- **Signed builds.** The installers are currently unsigned, so Windows SmartScreen and macOS
  Gatekeeper warn on first launch. A signing certificate would remove that friction.
- **Conflict-copy review.** When two devices edit the same note at once, Arf keeps both as a
  "(conflict copy)". A small side-by-side view to merge them would beat resolving by hand.
- **Broader test coverage.** Extend the end-to-end tests to cover folder drag-and-drop,
  `.arf` import/export round-trips, and reference lookups against recorded fixtures.

## Considering

- **More citation styles**, driven by CSL, rather than the current fixed set.
- **A richer graph**: filtering by tag or folder, and saved views.
- **Keyboard-first navigation** for every action currently behind a click.
- **Accessibility pass**: focus order, screen-reader labels, and reduced-motion coverage
  across the whole app, not just the parts that have it today.
- **Theming**: user-adjustable accent and font while keeping the ink-on-paper default.

## Out of scope, on purpose

- A cloud account or a hosted sync service. Syncing is delegated to whatever folder-sync tool
  you already trust (Dropbox, iCloud, OneDrive, Syncthing, Git).
- Sending your notes anywhere for processing. The model stays on your device.
- A proprietary file format. Notes remain plain Markdown you can read in any editor.
