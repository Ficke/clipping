# adamficke.com

Photography portfolio. Astro static site → GitHub Actions → private S3 →
CloudFront. No servers, no database, no admin surface.

## Adding an album

Create a folder under `content/albums/` named `YYYY-MM-slug` (the date prefix
just keeps folders tidy — sort order comes from frontmatter; the URL is the
folder name without the prefix):

```
content/albums/2026-08-lost-coast/
├── index.md
├── 01-DSCF1234.jpg     # full-res JPEGs, displayed in filename order
├── 02-DSCF1250.jpg
└── ...
```

`index.md`:

```markdown
---
title: "Lost Coast Trail"
date: 2026-08-14          # controls ordering on the index page
cover: 01-DSCF1234.jpg    # image shown on the index page
captions:                 # optional, per-photo
  02-DSCF1250.jpg: "Fog coming over Punta Gorda"
draft: true               # optional: hide until ready
---

Trip notes go here — regular markdown, shown above the photos.
```

Push to `main`. CI builds responsive variants and deploys — nothing else to do.
EXIF (camera, focal length, aperture, shutter, ISO) is read from the files at
build time and shown under each photo automatically — no need to type it.
(The photos migrated from Squarespace had their EXIF stripped, so those use
hand captions.)

Captions and text, in one place:

- **Trip notes**: the markdown body of `index.md`, rendered above the photos
- **Per-photo captions**: the `captions:` map in frontmatter, keyed by exact
  filename — photos without an entry just show their EXIF line (or nothing)
- **EXIF line**: automatic from the file; nothing to write
- **`description:`** (optional frontmatter): overrides the auto-generated
  `<meta>` description for the album page

Local preview: `npm install`, then `npm run dev`.

## Where the high-quality files live

**Git is the archive.** The full-quality JPEGs are committed in
`content/albums/` alongside their markdown — the repo is the single source of
truth, and everything on the web is derived from it.

The originals are never uploaded to S3. At build time, Astro feeds each one
through sharp and emits content-hashed derivatives into `dist/_astro/`:

- WebP at 640 / 1080 / 1600 / 2000 px wide for the responsive `<img srcset>`
  on album pages (the browser picks one by viewport)
- a 2000 px WebP (q85) that the lightbox opens as "fullsize"
- a 1200 px JPEG used as the album's Open Graph / social-preview image

`deploy.yml` syncs `dist/` to S3, so the bucket only ever holds those
derivatives plus HTML/CSS/JS. It is fully disposable — any checkout of the
repo can regenerate and redeploy it with a push.

Sizing guidance for new albums: export at whatever quality you like — bigger
originals are simply downscaled at build, and the site serves at most 2000 px
wide (bump the `widths` / `getImage` calls in
`src/pages/photography/[slug].astro` if you ever want larger). Full-res
40 MP exports are fine but grow the repo ~15–25 MB per photo; a ~3000 px
long-edge export at high quality is a good balance of archive value and repo
size. (The Squarespace-era photos are 2000 px because that's the largest
Squarespace would give back.)

## Architecture

- **Astro 5** static build; photos live next to their markdown in `content/`
- **S3** (`adamficke-com-site`, us-east-1): private bucket, all public access
  blocked; CloudFront reads via Origin Access Control
- **CloudFront**: HTTPS-only, HTTP/2+3, security headers (HSTS, strict CSP,
  frame-deny), a viewer-request function for pretty URLs and www→apex redirect
- **GitHub Actions** (`.github/workflows/deploy.yml`): builds on push to
  `main`, assumes an AWS role via OIDC (no stored keys), syncs, invalidates.
  Repo variables: `AWS_DEPLOY_ROLE_ARN`, `SITE_BUCKET`,
  `CLOUDFRONT_DISTRIBUTION_ID`
- **Terraform** (`infra/`, local state): everything above plus the
  currently-disabled Route 53 / ACM resources for the custom domain

Costs ≈ $0.50–1.50/month once the domain moves to Route 53.

## First-time AWS bootstrap

With AWS credentials active (`aws login`) and `gh` authenticated:

```sh
./infra/wire-aws.sh
```

It terraform-applies the stack, points the GitHub Actions variables at the
resulting role/bucket/distribution, runs a deploy, and smoke-tests the
CloudFront URL (including a legacy-URL redirect). Until this has run, CI
builds every push but skips the deploy steps.

## Domain cutover (when ready)

The domain is still registered at Squarespace. Two independent steps, in
either order:

1. **Serve the site from adamficke.com**
   - In `infra/`: set `enable_custom_domain = true`, `terraform apply`
   - Note the `nameservers` output; at the registrar, replace the domain's
     nameservers with those four
   - Once DNS propagates, ACM validates automatically and re-running
     `terraform apply` (if the first one timed out waiting) attaches the cert
     and aliases to CloudFront
2. **Transfer registration to Route 53** (kills the Squarespace bill)
   - Squarespace: unlock the domain, request the transfer auth code
   - Route 53 console → Registered domains → Transfer in, paste the code
   - Keep the Squarespace subscription alive until the transfer completes
     (~up to 7 days)
