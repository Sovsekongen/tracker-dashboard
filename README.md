# tracker-dashboard

A phone-friendly dashboard for the private repo `Sovsekongen/tracker`.

**This repo contains only code — no personal data.** The page fetches the data at runtime from the
GitHub API, using a read-only token that is stored only in your browser (localStorage).

## What it shows
- **Overview:** from `data/summary.json`, built by `scripts/summary.py` in the tracker repo — the
  same numbers as the daily/weekly chats. Last 7 days or last full week (Mon–Sun).
- **Charts:** weight, kcal, protein, sleep, HRV/resting HR (raw CSVs) and lift progress (from `summary.json`).
- **Data:** every CSV in `data/` with date filters, search and sorting.
- **Plans / Recipes / Profile:** markdown files rendered as pages.

## One-time setup on each device
1. Create a fine-grained token: GitHub → Settings → Developer settings → Fine-grained tokens → Generate
   (logged in as Sovsekongen).
   - Resource owner: **Sovsekongen** · Expiration: e.g. 1 year
   - Repository access: **Only select repositories → tracker**
   - Permissions → Repository → **Contents: Read-only** (nothing else)
2. Open the dashboard, paste the token, tap **Save on this device**.
3. iPhone: Share → **Add to Home Screen**.

Forget the token on a device with the **Log out** button. Revoke it on GitHub if a device is lost.

## Security
- Strict Content-Security-Policy: scripts only from this site, network only to `api.github.com`.
- Libraries are vendored in `vendor/` (Chart.js 4.6.1, marked 15.0.12, DOMPurify 3.4.18) — no CDN.
- Markdown is sanitized with DOMPurify; CSV values are inserted as text.

## Files
`index.html` · `style.css` · `app.js` · `vendor/` · `manifest.webmanifest` · icons.
Configuration (owner/repo/branch) is at the top of `app.js`.
