# budget-view

Read-only, encrypted online viewer for the **Budget** macOS app.

The Mac app publishes an AES-GCM–encrypted snapshot of the Overview to
`data.json` in this repo after every bank sync. This static site fetches it,
decrypts it in the browser with a shared passphrase, and renders the Snapshot
and Evolution views. No server, no login, free hosting via GitHub Pages.

## Files

- `index.html` — shell + passphrase lock screen
- `styles.css` — styling (light/dark)
- `app.js` — decrypt (WebCrypto) + Overview rendering (mirrors the app's aggregation)
- `data.json` — the encrypted snapshot, overwritten by the Mac app (not committed by hand)

## Setup (once)

1. Make this a **public** GitHub repo and push these files.
2. Repo **Settings → Pages** → serve from `main` / root. Note the URL
   `https://<user>.github.io/budget-view/`.
3. In the Budget app: **Settings → Online viewing** — set owner/repo, paste a
   fine-grained GitHub token (this repo, Contents: read/write), set a passphrase,
   enable, and **Publish now**.
4. Share the URL and passphrase with your viewer, separately.

## Security

The file on this public URL is ciphertext. The passphrase (never stored here)
is the only thing that decrypts it — PBKDF2-SHA256 (210k) + AES-GCM, matching
the app's `SnapshotCrypto`. Use a long passphrase.
