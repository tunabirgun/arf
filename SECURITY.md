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
- **The model runs on your device.** Network activity is limited to the one-time download of the
  public embedding model and the reference/full-text lookups you trigger yourself — reference
  metadata (Crossref, Open Library, DataCite, Project Gutenberg) and, when you ask for an
  open-access copy, discovery via Unpaywall, OpenAlex, Semantic Scholar and Europe PMC followed by
  downloading the PDF/EPUB. Only a reference's own identifiers (a DOI, arXiv id, PMCID, or your
  search words) ever leave the device; your notes and highlights are never uploaded.
- **Open-access downloads run through the native HTTP client, not the web view.** Publisher
  open-access hosts serve their files without cross-origin headers, so an in-page fetch is blocked;
  Arf performs these requests from the Rust side instead. That path is granted a broad `https://*`
  scope because an open-access copy can live on any publisher or repository domain — a deliberate,
  documented widening. It is used only for user-initiated reference lookups and downloads, every
  downloaded file is verified (PDF/EPUB signature) before it is saved, and no credentials or note
  content are ever attached to these requests.
- **Notes can come from untrusted sources.** A vault may contain Markdown files written or
  synced from elsewhere, so note content is rendered through DOMPurify to strip scripts and
  event handlers before it reaches the reading view. Reports of a bypass here are in scope.

Things especially worth reporting: a way to make note rendering execute script, a path that
lets a crafted note or filename escape the vault folder, or a data-loss path in save, sync,
rename, move, or import/export.

## Verifying a release

The installers are unsigned for now, but every release carries a signed manifest:
`SHA256SUMS.txt` lists the SHA-256 digest of every release asset and is accompanied by a
detached GPG signature, `SHA256SUMS.txt.asc`, made with the Arf release key
([`RELEASE_SIGNING_KEY.asc`](RELEASE_SIGNING_KEY.asc), fingerprint
`D121 6D39 F6C0 8D3F A83C 4D38 2085 EA4C 79CC 7FBA`). To verify a download:

```bash
gpg --import RELEASE_SIGNING_KEY.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## Supported versions

Arf ships fixes on the latest release. Please reproduce on the most recent version before
reporting.
