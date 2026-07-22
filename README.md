# adamficke.com

Photography portfolio. Astro 7 static site, built by GitHub Actions and
served from a private S3 bucket through CloudFront. No servers, no database,
no admin surface. Bun runs installs and scripts; photo originals are
archived in S3, not git.

## First-time setup on a machine

```sh
bun install            # deps (bun.lock is committed)
aws login              # AWS SSO — needed for photo sync
bun run photos:pull    # hydrate content/albums/ with the originals from S3
bun run dev            # local preview
```

Photos are gitignored — a fresh clone has the markdown but no images until
`photos:pull`. Running `photos:push` without an album path checks and
incrementally uploads every local album.

## Adding an album

1. Create `content/albums/YYYY-MM-slug/` and drop in your exports. JPEG,
   PNG, WebP, and AVIF are supported. Photos display in natural filename
   order, so a camera sequence like `DSCF9.jpg`, `DSCF10.jpg`, `DSCF11.jpg`
   needs no manual numbering:

   ```
   content/albums/2026-08-lost-coast/
   ├── DSCF1234.jpg
   ├── DSCF1250.jpg
   └── ...
   ```

2. Preview the album upload. A dry run only reports extension renames,
   `index.md` creation, and S3 uploads; it changes nothing locally or in AWS:

   ```sh
   bun run photos:push -- content/albums/2026-08-lost-coast --dry-run
   ```

3. Upload the originals and create `index.md`. For a new album, add
   `--prewarm` to generate its responsive images locally and add them to the
   same shared cache that CI uses:

   ```sh
   # Standard upload
   bun run photos:push -- content/albums/2026-08-lost-coast

   # Recommended for a new album: upload, then prewarm the image cache
   bun run photos:push -- content/albums/2026-08-lost-coast --prewarm
   ```

   The command lowercases image extensions, rejects unsupported photo
   formats or nested image folders, creates `index.md` when it is missing,
   and incrementally uploads the originals to S3. The generated title comes
   from the folder slug (`lost-coast` becomes `Lost Coast`), the date comes
   from the first photo's EXIF (falling back to the folder month), and the
   cover is the first photo.

   Prewarming pulls `s3://adamficke-com-originals/cache/astro` into
   `node_modules/.astro`, builds locally, and syncs new cache entries back to
   S3. It does not deploy the site or commit generated files. Run the same
   operation independently at any time with `bun run photos:prewarm`.

4. The generated `index.md` is ready to publish without changes, or you can
   edit its title and add optional details:

   ```markdown
   ---
   title: "Lost Coast"       # editable; defaults from the folder slug
   date: 2026-08-14          # controls ordering; rendered above the title
   cover: DSCF1234.jpg       # image shown on the index page
   order:                    # optional: override natural filename order
     - DSCF1250.jpg
     - DSCF1234.jpg
   captions:                 # optional: one descriptive sentence per photo
     DSCF1250.jpg: "Fog coming over Punta Gorda."
   draft: true               # optional: hide until ready
   ---

   Optional album text — the story of the trip, shown above the photos.
   ```

   If `order:` is present, it must list every photo exactly once. Full
   conventions live in `content/albums/TEMPLATE.md`.

5. Commit the generated markdown to publish:

   ```sh
   git add content/albums/2026-08-lost-coast/index.md
   git commit -m "Lost Coast"
   git push
   ```

CI pulls the originals, builds, and deploys.

**Never rename a published album folder** — the folder name minus the date
prefix is the URL, and renaming breaks inbound links.

### Text on an album page

- **Album text**: the markdown body of `index.md`, rendered above the photos
- **Captions**: the `captions:` map in frontmatter, keyed by exact filename
- **EXIF line** (camera, focal length, aperture, shutter, ISO): read from
  each file at build time; photos with no EXIF just omit the line
- **`description:`** (optional frontmatter): overrides the auto-generated
  `<meta>` description for the album page

## Where the photos live

**S3 is the archive; git holds only text.** Full-quality originals live in
the versioned `adamficke-com-originals` bucket, laid out to mirror the repo
(`albums/<folder>/<file>.jpg`); deleted or overwritten objects are
recoverable for 90 days. `photos:push` / `photos:pull` are incremental
`aws s3 sync` wrappers that only touch image files — markdown always comes
from git.

The build derives everything the site serves. Astro + sharp emit
content-hashed derivatives into `dist/_astro/`:

- AVIF (q60) + WebP (q80) at 640/1080/1600/2000 px for the responsive
  `<picture>` on album pages
- a 2000 px WebP (q90) that the lightbox opens as fullsize
- a 1200 px JPEG for Open Graph / social previews

sharp strips all metadata from derivatives, so EXIF/GPS in the originals
never reaches the public site — only the build-time camera-settings line
does. Export size is your call: bigger originals are downscaled at build,
and the site serves at most 2000 px wide (raise the `widths` / `getImage`
values in `src/pages/photography/[slug].astro` to go larger).

The site bucket (`adamficke-com-site`) holds only derivatives plus
HTML/CSS/JS and is fully disposable.

### Prewarming image transforms

The expensive part of a new-album deploy is generating responsive images.
GitHub Actions and `photos:prewarm` intentionally share both cache paths:

- Local: `node_modules/.astro`
- S3: `s3://adamficke-com-originals/cache/astro`

Run `bun run photos:prewarm` after adding or replacing photos but before
pushing the related markdown. It pulls the current shared cache, runs the
normal Astro build, and uploads only new or changed cache entries. The local
push does not use `--delete`, so it cannot prune entries created by another
build. CI still runs a build after the markdown reaches `main`, but unchanged
image transforms should be cache hits.

`node_modules/.astro` and `dist/` are gitignored. Prewarming never commits or
deploys them, and metadata-only edits do not need another prewarm.

## Architecture

- **Astro 7** static build; **Bun** for package management and scripts
- **S3**: `adamficke-com-site` (deploy target), `adamficke-com-originals`
  (photo archive, versioned), `adamficke-com-tfstate` (Terraform state) —
  all private with public access blocked; CloudFront reads the site bucket
  via Origin Access Control
- **CloudFront**: HTTPS-only, HTTP/2+3, security headers (HSTS, strict CSP,
  frame-deny), and a viewer-request function for pretty URLs, legacy-URL
  redirects, and www → apex
- **GitHub Actions** (`.github/workflows/deploy.yml`): on push to `main`,
  assumes the AWS role via OIDC (no stored keys), pulls originals, builds,
  syncs to S3, invalidates CloudFront. Builds are incremental — the sharp
  encode cache persists at `s3://adamficke-com-originals/cache/` and the
  pulled originals ride actions/cache, so only new photos get encoded.
  Repo variables: `AWS_DEPLOY_ROLE_ARN`, `SITE_BUCKET`,
  `CLOUDFRONT_DISTRIBUTION_ID`
- **Terraform** (`infra/`, state in S3): all of the above, plus a $10/month
  AWS budget alert and the Route 53 / ACM resources for the custom domain
  (inert until `enable_custom_domain = true`)
- **RSS** at `/rss.xml`

Runs ≈ $0.50–1.50/month once the domain is on Route 53.

## Domain cutover (when ready)

The domain is registered at Squarespace. Two independent steps, in either
order:

1. **Serve the site from adamficke.com**
   - In `infra/`: set `enable_custom_domain = true`, `terraform apply`
   - Take the `nameservers` output and set those four as the domain's
     nameservers at the registrar
   - Once DNS propagates, ACM validates automatically; if the first apply
     timed out waiting, re-run `terraform apply` to attach the cert and
     aliases to CloudFront
2. **Transfer registration to Route 53**
   - Squarespace: unlock the domain, request the transfer auth code
   - Route 53 console → Registered domains → Transfer in, paste the code
   - Keep the Squarespace subscription active until the transfer completes
     (up to ~7 days)
