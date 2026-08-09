---
name: preview-check
description: >-
  Build and drive the site in headless Chrome before pushing visual or
  interactive changes to production.
---

# Preview-check: verify changes locally before pushing

Every push to `main` deploys straight to production, so visual and
interactive changes get verified here first.

## Steps

Build and start the production preview in one terminal:

```sh
bun run build
bun run preview
```

In another terminal, drive the default album or a specific route:

```sh
bun run preview:check
bun run preview:check -- /
```

Then **Read the screenshots** in `artifacts/preview-check/`
and actually look at them — a blank or top-left-pinned frame means a bug.
The script also reports browser console errors and asserts the lightbox
Esc-close works.

To check the GA4 tag instead of the visuals:

```sh
bun run preview:analytics -- /               # any path
bun run preview:analytics -- / --csp         # under CloudFront's CSP
bun run preview:analytics -- / --off         # assert it stays silent
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

`--csp` replays the policy from `infra/main.tf`. A contract test fails if the
two copies drift.

When done, stop the preview server with Ctrl-C in its terminal.

## Notes

- The typed browser checks live with the rest of the repository tooling in
  `scripts/`; this skill only documents the pre-push workflow.
- `playwright-core` is a devDependency and drives the user's installed
  Google Chrome (`channel: 'chrome'`) — nothing to download.
- Album images must be hydrated (`bun run photos:pull`) or pages will
  have no photos.
- `bun run dev` (hot reload) is better while iterating; this check runs
  the production build, which is what should be verified before a push.
- What local preview cannot show: CloudFront-layer behavior (security
  headers, pretty-URL/redirect function, caching).
