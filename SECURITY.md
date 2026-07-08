# Security Policy

## Reporting a vulnerability

If you find a security problem in Arf, please report it privately first. Do not open a
public issue for it.

- Use GitHub's private vulnerability reporting: the **Security** tab of this repository →
  **Report a vulnerability**.
- If that is unavailable, open a minimal issue that says only "security report, please
  provide contact" — without details — and the maintainer will follow up.

Please include what you found, the steps to reproduce it, the version and platform, and the
impact as you understand it. You will get an acknowledgement within a few days. Once a fix is
released, you are welcome to be credited if you would like.

## Scope

Arf is local-first by construction, which shapes what a vulnerability means here:

- **Your notes are plain files on your own disk.** There is no Arf account and no server that
  holds your data. Anyone with access to your machine or your synced folder has access to your
  notes — that is the trust boundary of any local file, not a flaw in Arf.
- **The model runs on your device.** The only network activity is the one-time download of the
  public embedding model and the reference lookups (Crossref, Open Library, arXiv) you trigger
  yourself. Note text is never uploaded.
- **Notes can come from untrusted sources.** A vault may contain Markdown files written or
  synced from elsewhere, so note content is rendered through DOMPurify to strip scripts and
  event handlers before it reaches the reading view. Reports of a bypass here are in scope.

Things especially worth reporting: a way to make note rendering execute script, a path that
lets a crafted note or filename escape the vault folder, or a data-loss path in save, sync,
rename, move, or import/export.

## Supported versions

Arf ships fixes on the latest release. Please reproduce on the most recent version before
reporting.
