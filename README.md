# adamficke.com

Photography portfolio. Astro 7 static site, built in AWS CodeBuild and served
from private S3 buckets through CloudFront. No servers, no database, no admin
surface. Bun runs installs and scripts; photo originals and generated media
live in S3, while git holds album text and small photo manifests.

## First-time setup on a machine

```sh
bun install            # deps (bun.lock is committed)
bun run dev            # local preview
```

A fresh clone can build and preview from the committed manifests without
downloading photos. For album work, run `aws login` first. `bun run
photos:pull` hydrates the gitignored originals from S3 when you need to update
an existing album.

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

3. Upload and publish the album media:

   ```sh
   bun run photos:push -- content/albums/2026-08-lost-coast
   ```

   The command lowercases image extensions, rejects unsupported photo
   formats or nested image folders, creates `index.md` when it is missing,
   and synchronizes the album's originals to S3. It then starts the
   `adamficke-com-media` CodeBuild job, which generates only missing
   content-addressed image variants and downloads the resulting `photos.json`
   manifest into the album folder. The generated title comes from the folder
   slug (`lost-coast` becomes `Lost Coast`), the date comes from the first
   photo's EXIF (falling back to the folder month), and the cover is the first
   photo.

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

5. Commit the album text and generated manifest to publish:

   ```sh
   git add content/albums/2026-08-lost-coast/index.md \
     content/albums/2026-08-lost-coast/photos.json
   git commit -m "Lost Coast"
   git push
   ```

GitHub Actions sends a small source archive to CodeBuild. The site build reads
the manifest, builds only HTML/CSS/JS, deploys to S3, and invalidates
CloudFront. It never downloads originals or historical derivatives.

**Never rename a published album folder** — the folder name minus the date
prefix is the URL, and renaming breaks inbound links.

### Updating an album

Hydrate the originals if needed, then add, replace, or remove files in the
album folder and run the same dry-run/push sequence. The local folder is
authoritative: `photos:push` adds and replaces changed objects and removes
remote images no longer in the folder. The originals bucket is versioned, so
overwrites and deletions remain recoverable for 90 days.

The media job hashes source bytes. A replacement gets new immutable URLs;
unchanged photos reuse their existing variants; removed photos disappear from
`photos.json`. Old content-addressed derivatives are intentionally retained
and can be garbage-collected separately without putting a live page at risk.
Changing only title, description, captions, cover, or `order:` requires no
photo upload—edit `index.md` and commit it normally.

### Text on an album page

- **Album text**: the markdown body of `index.md`, rendered above the photos
- **Captions**: the `captions:` map in frontmatter, keyed by exact filename
- **EXIF line** (camera, focal length, aperture, shutter, ISO): captured in
  `photos.json` when media is published; photos with no EXIF omit the line
- **`description:`** (optional frontmatter): overrides the auto-generated
  `<meta>` description for the album page

## Where the photos live

Full-quality originals live in the versioned `adamficke-com-originals`
bucket at `albums/<folder>/<file>.jpg`. Public derivatives live separately in
the private `adamficke-com-media` bucket and are served by CloudFront under
`/media/*`. Git contains `index.md` plus `photos.json`; generated image files
are never committed.

The album-specific media CodeBuild job uses sharp to emit immutable,
content-addressed derivatives:

- AVIF (q60) + WebP (q80) at 640/1080/1600/2000 px for the responsive
  `<picture>` on album pages
- a 2000 px WebP (q90) that the lightbox opens as fullsize
- JPEG fallbacks at the responsive widths
- a 1200 px JPEG for Open Graph / social previews

sharp auto-orients photos and strips metadata from derivatives, so EXIF/GPS
in the originals never reaches the public site—only the selected camera
settings stored in the manifest do. Export size is your call: larger
originals are downscaled, and the site serves at most 2000 px wide. Changing
the global media profile creates a new versioned URL namespace instead of
mutating published assets.

## Architecture

- **Astro 7** static build; **Bun** for package management and scripts
- **S3**: `adamficke-com-site` (HTML/CSS/JS), `adamficke-com-media`
  (immutable public derivatives), `adamficke-com-originals` (versioned photo
  archive and manifests), `adamficke-com-builds` (short-lived CodeBuild
  source bundles), and `adamficke-com-tfstate` (Terraform state)—all private
  with public access blocked
- **CloudFront**: HTTPS-only, HTTP/2+3, security headers (HSTS, strict CSP,
  frame-deny), and a viewer-request function for pretty URLs, legacy-URL
  redirects, and www → apex. Deploys invalidate mutable site paths without
  evicting immutable `/_astro/*` or `/media/*` assets
- **GitHub Actions** (`.github/workflows/deploy.yml`): on push to `main`,
  assumes the AWS role via OIDC, uploads the git source archive, and waits for
  the site CodeBuild job
- **CodeBuild**: `adamficke-com-media` processes one changed album at upload
  time; `adamficke-com-site` builds and deploys the lightweight Astro site.
  Both use the current Ubuntu `standard:8.0` image. Bun's cold install is
  faster than transferring a dependency cache for this small project
- **Terraform** (`infra/`, state in S3): all of the above, plus a $10/month
  AWS budget alert and the Route 53 hosted zone. ACM and the CloudFront domain
  aliases remain inert until `enable_custom_domain = true`
- **RSS** at `/rss.xml`

Runs ≈ $0.50–1.50/month once the domain is on Route 53.

### Infrastructure rollout

Run `terraform apply` in `infra/` before merging a change that first enables
this pipeline. Then run `photos:push` for each existing hydrated album to
backfill the media bucket and verify the generated `photos.json` files match
the committed manifests. After that, the normal merge-to-`main` deployment
can switch the live HTML to `/media/*` safely.

## Domain cutover (when ready)

The domain is registered at Squarespace. Two independent steps, in either
order:

1. **Serve the site from adamficke.com**
   - In `infra/`, run `terraform apply` with the default configuration
   - Take the `nameservers` output and set those four as the domain's
     nameservers at the registrar
   - Once delegation propagates, run
     `terraform apply -var='enable_custom_domain=true'`; ACM validates and
     Terraform attaches the certificate and aliases to CloudFront
2. **Transfer registration to Route 53**
   - Squarespace: unlock the domain, request the transfer auth code
   - Route 53 console → Registered domains → Transfer in, paste the code
   - Keep the Squarespace subscription active until the transfer completes
     (up to ~7 days)
