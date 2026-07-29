# Manager Accountability

Shift accountability for a restaurant management team — morning and night
checklists with photo verification, monthly food-safety audits, GM notes, and
submission history. Rebuilt off Base44 as a static PWA on GitHub Pages with a
Cloudflare Worker + D1 database behind it, so there is no vendor lock-in and no
subscription.

- **Live app:** https://thomasg42.github.io/manager-accountability/
- **API:** `https://manager-accountability-sync.forevergoldai.workers.dev`

## How it is put together

| Piece | What it does |
| --- | --- |
| `docs/` | The whole front end. GitHub Pages serves this folder directly — no build step. |
| `docs/data/checklists.js` | Shift task lists, non-negotiables and audit items, extracted verbatim from Base44. Wording is overridable in Settings. |
| `docs/cloud.js` | Cloud-first data layer plus client-side photo compression. D1 is the ledger; localStorage is a cache and an offline outbox. |
| `sync-worker/index.ts` | Cloudflare Worker API — auth, records, photos. |
| `sync-worker/migrations/` | D1 schema. Apply with `wrangler d1 migrations apply`. |

## Two codes, no credentials in this repo

Both are set once from the app's own first-run screen and stored server-side as
salted SHA-256 hashes.

- **Manager access code** — any manager. Picks a profile, runs the shift
  checklist, attaches photos, submits, runs food-safety audits, reads history.
- **Admin PIN** — GM. Everything above plus the roster and roles, GM notes,
  video links, completion messages, checklist wording, deletes and code
  rotation.

Rotate either from **Settings → Codes**. A forgotten admin PIN can only be
cleared from the Cloudflare dashboard by deleting the row from the `credentials`
table in the `manager-accountability-sync` D1 database.

## How the shift flow works

The app picks the shift that is due rather than asking: today's morning, then
today's night, then tomorrow's morning. Ticks, comments and urgency auto-save as
a draft the whole time; **Submit** files it as final and, if comments were
written, also posts them as a GM note. Once a shift is final, the worker refuses
further writes to it from manager scope so a late draft save cannot rewrite a
filed record.

Verification photos are downscaled in the browser to fit under the worker's
~900KB per-image cap, then stored base64 in D1 — the same approach used by the
receipt store in `gold-mobile-mechanic`.

## Deploying

```bash
# front end — pushing to main republishes GitHub Pages automatically
git push

# backend
npx wrangler d1 migrations apply manager-accountability-sync --remote
npx wrangler deploy
```

**Bump `CACHE` in `docs/sw.js` on every front-end deploy.**

## Known gap carried over from Base44

The two training video URLs (Cash Drawers, KPI) lived in Base44's own
`VideoResource` table rather than in code, so they did not come across in the
export. Copy them out of the live Base44 app before cancelling it and paste them
into the **Videos** tab as admin.

## Not carried over deliberately

The original had a separate accountant view (`AccountantRow`) that was only
partially captured in the export. Roles are preserved on each profile
(`manager` / `accountant`) so the distinction is still recorded, but there is no
separate accountant screen in this rebuild. Say the word if it is needed and it
can be added against the same data.
