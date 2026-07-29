---
name: preview-check
description: Build the site, serve it locally, and drive it in headless Chrome with screenshots — verify visual/interactive changes BEFORE pushing (every push deploys to production).
---

# Preview-check: verify changes locally before pushing

Every push to `main` deploys straight to production, so visual and
interactive changes get verified here first.

## Steps

```sh
bun run build
(bun run preview > /dev/null 2>&1 &)
timeout 30 bash -c 'until curl -sf http://localhost:4321/ >/dev/null; do sleep 1; done'
bun .claude/skills/preview-check/drive.mjs            # default: salt-point album
bun .claude/skills/preview-check/drive.mjs /          # or any other path
```

Then **Read the screenshots** in `.claude/skills/preview-check/shots/`
and actually look at them — a blank or top-left-pinned frame means a bug.
The script also reports browser console errors and asserts the lightbox
Esc-close works.

To check the GA4 tag instead of the visuals:

```sh
bun .claude/skills/preview-check/analytics-check.mjs /               # any path
bun .claude/skills/preview-check/analytics-check.mjs / --csp         # under CloudFront's CSP
bun .claude/skills/preview-check/analytics-check.mjs / --off         # assert it stays silent
```

It reports whether gtag.js loaded and whether a `page_view` hit was
actually built, and exits non-zero if not.

The tag no-ops unless the page's canonical host matches the host being
served, so an ordinary local visit reports nothing; the script appends
`?ga-debug` to opt back in. `--off` drops that and asserts silence — run
it after touching `analytics.ts`, since a guard that fails open is how
localhost traffic ends up in the real property.

Collect endpoints are also stubbed with a 204 as a second layer. Stubbing
rather than aborting matters: an aborted hit makes gtag attempt a
`www.google.com` fallback that looks like a CSP bug but is not one.

`--csp` replays the policy from `infra/main.tf`; keep the two in sync.

When done:

```sh
lsof -ti:4321 -sTCP:LISTEN | xargs -r kill
```

## Notes

- `playwright-core` is a devDependency and drives the user's installed
  Google Chrome (`channel: 'chrome'`) — nothing to download.
- Album images must be hydrated (`bun run photos:pull`) or pages will
  have no photos.
- `bun run dev` (hot reload) is better while iterating; this check runs
  the production build, which is what should be verified before a push.
- What local preview cannot show: CloudFront-layer behavior (security
  headers, pretty-URL/redirect function, caching).
