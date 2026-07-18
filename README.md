# adamficke.com

Photography portfolio. Astro 7 static site → GitHub Actions → private S3 →
CloudFront. No servers, no database, no admin surface. Bun for installs and
scripts; photo originals archived in S3, not git.

## First-time setup on a machine

```sh
bun install        # deps (bun.lock is committed)
aws login          # AWS SSO — needed for photo sync
bun run photos:pull    # hydrate content/albums/ with the originals from S3
bun run dev        # local preview
```

Photos are gitignored — a fresh clone has the markdown but no images until
`photos:pull`.

## Adding an album

1. Create a folder under `content/albums/` named `YYYY-MM-slug` and drop in
   your JPEGs (lowercase extensions; displayed in filename order — an
   `01-`/`02-` prefix keeps them sorted) plus an `index.md`:

   ```
   content/albums/2026-08-lost-coast/
   ├── index.md
   ├── 01-DSCF1234.jpg
   ├── 02-DSCF1250.jpg
   └── ...
   ```

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

2. Push the photos to the archive, then the markdown to git:

   ```sh
   bun run photos:push
   git add . && git commit -m "Lost Coast" && git push
   ```

CI pulls the originals, builds, and deploys. That's it.

**Never rename a published album folder** — the folder name (minus the date
prefix) is the URL. Renaming breaks inbound links, and would orphan comment
threads if comments are ever added.

Captions and text, in one place:

- **Trip notes**: the markdown body of `index.md`, rendered above the photos
- **Per-photo captions**: the `captions:` map in frontmatter, keyed by exact
  filename — photos without an entry just show their EXIF line (or nothing)
- **EXIF line** (camera, focal length, aperture, shutter, ISO): read from the
  file at build time, automatic (the Squarespace-migrated photos had EXIF
  stripped, so those use hand captions)
- **`description:`** (optional frontmatter): overrides the auto-generated
  `<meta>` description for the album page

## Where the photos live

**S3 is the archive; git holds only text.** Full-quality originals live in
the versioned `adamficke-com-originals` bucket (mistaken deletes and
overwrites are recoverable for 90 days), laid out to mirror the repo:
`albums/<folder>/<file>.jpg`. `photos:push`/`photos:pull` are incremental
`aws s3 sync` wrappers that only touch image files — markdown always comes
from git.

The build derives everything the site serves. Astro + sharp emit
content-hashed derivatives into `dist/_astro/`:

- AVIF (q60) + WebP (q80) at 640/1080/1600/2000 px for the responsive
  `<picture>` on album pages — AVIF for modern browsers at roughly half the
  weight, WebP fallback
- a 2000 px WebP (q90) that the lightbox opens as "fullsize"
- a 1200 px JPEG for Open Graph / social previews

Derivatives carry no metadata (sharp strips it), so EXIF/GPS in your
originals never reaches the public site — only the build-time camera-settings
line does. Export size is your call: bigger originals are downscaled at
build and the site serves at most 2000 px wide (bump the `widths` /
`getImage` calls in `src/pages/photography/[slug].astro` to go larger).

The site bucket (`adamficke-com-site`) only ever holds derivatives plus
HTML/CSS/JS and is fully disposable.

## Architecture

- **Astro 7** static build, **Bun** for package management and scripts
- **S3**: `adamficke-com-site` (deploy target), `adamficke-com-originals`
  (photo archive, versioned), `adamficke-com-tfstate` (Terraform state) —
  all private, all public access blocked; CloudFront reads the site bucket
  via Origin Access Control
- **CloudFront**: HTTPS-only, HTTP/2+3, security headers (HSTS, strict CSP,
  frame-deny), a viewer-request function for pretty URLs and www→apex redirect
- **GitHub Actions** (`.github/workflows/deploy.yml`): on push to `main` —
  `bun install --frozen-lockfile`, assume the AWS role via OIDC (no stored
  keys), pull originals, build, sync, invalidate. Builds stay incremental:
  the sharp encode cache persists at `s3://adamficke-com-originals/cache/`
  (S3, so it never evicts — GitHub's cache drops entries idle >7 days) and
  the pulled originals ride a best-effort actions/cache. Only new photos get
  encoded. Repo variables: `AWS_DEPLOY_ROLE_ARN`, `SITE_BUCKET`,
  `CLOUDFRONT_DISTRIBUTION_ID`
- **Terraform** (`infra/`, state in S3): everything above plus a $10/month
  AWS budget alert and the currently-disabled Route 53 / ACM resources for
  the custom domain
- **RSS** at `/rss.xml`

Costs ≈ $0.50–1.50/month once the domain moves to Route 53.

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
