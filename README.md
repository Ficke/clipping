# adamficke.com

Photography portfolio. Astro 7 static site, built in AWS CodeBuild and served
from private S3 buckets through CloudFront. No servers, no database, no admin
surface. Bun runs installs and scripts; photo originals and generated media
live in S3, while git holds album text and small photo manifests.

## First-time setup on a machine

```sh
bun install                            # deps (bun.lock is committed)
git config core.hooksPath .githooks    # refuse pushes to main (see Publishing)
bun run dev                            # local preview
```

A fresh clone can build and preview from the committed manifests without
downloading photos. For album work, run `aws login` first. `bun run
photos:pull` hydrates the gitignored originals from S3 when you need to update
an existing album.

`predev` clears `.astro/`, whose cached frontmatter goes stale against schema
changes in `src/content.config.ts`.

## Adding an album

1. Create a folder under `content/albums/` and drop in your exports. JPEG,
   PNG, WebP, and AVIF are supported. The folder name is only a working
   label — it seeds the form's defaults on the first push and nothing reads
   it afterwards — so `YYYY-MM-name` is a useful convention for sorting but
   not a requirement:

   ```
   content/albums/2026-08-lost-coast/
   ├── DSCF1234.jpg
   ├── DSCF1250.jpg
   └── ...
   ```

2. Preview the album upload. A dry run only reports extension renames,
   `index.md` creation, and S3 uploads; it changes nothing locally or in AWS,
   and it skips the form:

   ```sh
   bun run photos:push -- content/albums/2026-08-lost-coast --dry-run
   ```

3. Upload and publish the album media:

   ```sh
   bun run photos:push -- content/albums/2026-08-lost-coast
   ```

   For a new album this opens a short form with defaults derived from the
   folder name — press Enter to accept each one. `location` is the exception:
   nothing can infer it, so it is required.

   ```
   2026-08-lost-coast → new album, 24 photos
     storyId    [lost-coast]
                  → /photography/lost-coast/
     title      [Lost Coast]
     date       [2026-08-14]
     cover      [DSCF1234.jpg]
     location   [] Mendocino Coast
   ```

   The story ID is permanent: it keys the S3 archive, the manifest, the URL,
   and any future comments. The script checks it is unused both locally and
   in S3 before writing anything.

   It then lowercases image extensions, rejects unsupported photo formats or
   nested image folders, writes `index.md`, and synchronizes the album's
   originals to S3.

   Finally it asks where to generate the image variants:

   ```
   Build media for 24 photos:
     codebuild  reproducible, builds from HEAD
     local      faster, builds from your working tree
     where      [codebuild]
   ```

   Both run the same `photos-build-media.mjs` and write to the same buckets —
   variant keys derive from each source file's hash, so the two are
   interchangeable and either warms the cache for the other. CodeBuild is the
   default because it builds from `HEAD` in a fixed container. Local is
   markedly faster on a cold album, since it skips the source bundle and the
   round trip that pulls the originals back out of S3; use `--local` to skip
   the prompt. Only variants that do not already exist are generated, so
   re-pushing an unchanged album is quick either way.

4. The generated `index.md` is ready to publish without changes, or you can
   edit its title and add optional details:

   ```markdown
   ---
   storyId: "lost-coast"     # permanent; keys storage, URL, future comments
   title: "Lost Coast"       # editable; defaults from the folder name
   date: 2026-08-14          # controls ordering; rendered above the title
   location: "Mendocino Coast"
   cover: DSCF1250.jpg       # optional; defaults to the first photo
   draft: true               # optional: hide until ready
   photos:                   # order of the list is the order of the album
     - file: DSCF1234.jpg
     - file: DSCF1250.jpg
       caption: "Fog coming over Punta Gorda."
       alt: "Fog moving over a dark coastal ridge."
   ---

   Optional album text — the story of the trip, shown after the opening photo.
   ```

   Full conventions live in `content/albums/TEMPLATE.md`.

5. Check it locally, then publish it — see [Publishing](#publishing):

   ```sh
   bun run build   # catches schema errors and photos/photos.json mismatches
   ```

## Updating an album

Run `bun run photos:pull` to hydrate the originals, then add, replace, or
remove files in the album folder and run the same dry-run/push sequence.
Because identity lives in `index.md`, the folder can be renamed or
reorganized freely — the album is still the same album.

`photos:push` reconciles the `photos` list against the folder on every push:
new files are added, deleted ones removed, and captions, alt text and any
hand-set order are preserved. New photos slot into filename order unless the
album has been reordered by hand, in which case they are appended.

The local folder is authoritative: the push adds and replaces changed objects
and removes remote images no longer in the folder. The originals bucket is
versioned, so overwrites and deletions remain recoverable for 90 days.

The media job hashes source bytes. A replacement gets new immutable URLs;
unchanged photos reuse their existing variants; removed photos disappear from
`photos.json`. Old content-addressed derivatives are intentionally retained
and can be garbage-collected separately without putting a live page at risk.
Changing only text — title, description, captions, alt, cover, or the order of
`photos:` — needs no photo upload; edit `index.md` and publish it normally.

**Changing `storyId` changes the URL**, breaks inbound links, and orphans the
album from its S3 archive and manifest. Treat it as permanent. The folder
name, by contrast, is free to change at any time.

### Text on an album page

- **Album text**: the markdown body of `index.md`, rendered after the opening
  photo and before the rest of the sequence
- **Captions**: the `caption:` field on an entry in `photos:`
- **Alt text**: the `alt:` field on an entry in `photos:`, kept separate from
  the caption so each can do its own job
- **EXIF line** (camera, focal length, aperture, shutter, ISO): captured in
  `photos.json` when media is published; available under “Photo details” when
  present
- **`description:`** (optional frontmatter): overrides the auto-generated
  `<meta>` description for the album page

## Publishing

`main` deploys to production on merge, so album and site changes go through a
branch and a pull request.

The `.githooks/pre-push` hook refuses pushes to `main` to keep an accidental
deploy from being one command away. It is advisory — `--no-verify` skips it, and
it only applies once a clone has run the `core.hooksPath` line above. GitHub's
own branch protection would need Pro on a private repo.

```sh
git checkout -b japan-24

# only the text and the manifest: originals are gitignored, and the
# generated derivatives already live in S3
git add "content/albums/2024-12-Japan-'24/index.md" \
        "content/albums/2024-12-Japan-'24/photos.json"
git commit -m "Japan '24"

git push -u origin japan-24
gh pr create --fill
```

Merging to `main` triggers `.github/workflows/deploy.yml`, which assumes the
AWS role via OIDC, uploads a git source archive, and waits for the
`adamficke-com-site` CodeBuild job. That job reads the committed manifests,
builds only HTML/CSS/JS, deploys to the site bucket, and invalidates the
mutable CloudFront paths, leaving immutable `/_astro/*` and `/media/*` in
cache. It never downloads originals or historical derivatives.

Media generation has already happened by this point — `photos:push` does it at
upload time, not at deploy time. A deploy that changes only album text costs
nothing but the site build.

## Where the photos live

Full-quality originals live in the versioned `adamficke-com-originals`
bucket at `albums/<storyId>/<file>.jpg`. Public derivatives live separately in
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
  source bundles), `adamficke-com-access-logs` (CloudFront request logs
  retained indefinitely), and `adamficke-com-tfstate` (Terraform state)—all
  private with public access blocked
- **CloudFront**: HTTPS-only, HTTP/2+3, security headers (HSTS, strict CSP,
  frame-deny), and a viewer-request function for pretty URLs, legacy-URL
  redirects, and the canonical-host redirect. Deploys invalidate mutable site
  paths without evicting immutable `/_astro/*` or `/media/*` assets
- **Analytics**: GA4 (`G-P2XYT72XL6`) for visitor and page-level reporting;
  privacy-reduced CloudFront standard logs in S3 for operational analysis.
  Access logs omit viewer IPs, query strings, forwarded-for values, and
  cookies
- **GitHub Actions** (`.github/workflows/deploy.yml`): on push to `main`,
  assumes the AWS role via OIDC, uploads the git source archive, and waits for
  the site CodeBuild job
- **CodeBuild**: `adamficke-com-media` processes one changed album at upload
  time; `adamficke-com-site` builds and deploys the lightweight Astro site.
  Both use the current Ubuntu `standard:8.0` image. Bun's cold install is
  faster than transferring a dependency cache for this small project
- **Terraform** (`infra/`, state in S3): all of the above, plus a $10/month
  AWS budget alert, the Route 53 hosted zones, and the ACM certificate
- **RSS** at `/rss.xml`

Runs ≈ $0.50–1.50/month.

## Domains

`adamficke.com` is the canonical URL. It is registered with Amazon Registrar
and its DNS is delegated to a Route 53 hosted zone in the same account, so
registration and DNS are managed together.

CloudFront answers for four names — the canonical apex, `www.adamficke.com`,
and the retired `adamficke.dev` pair — under one ACM certificate in
`us-east-1`. The viewer-request function 301s every name except the canonical
apex, which also covers the raw `*.cloudfront.net` hostname. Old `.dev` links
keep working and search engines see a single canonical host.

Terraform derives the certificate SANs, CloudFront aliases, and Route 53 alias
records from `domain_name` plus `redirect_domains` in `infra/variables.tf`.
Changing those two variables is the whole edit; `managed_domains` separately
controls which hosted zones exist.

Delegation has to come first when adding a domain. ACM validates by writing a
CNAME into the domain's hosted zone, so `terraform apply` will block until the
registrar points at that zone's nameservers. Get them from
`terraform output nameservers`, set them at the registrar, and apply once the
change is visible in `dig NS <domain>`. Copy any email records (MX, SPF, DKIM,
DMARC) into the Route 53 zone before cutting nameservers over; leave the old
website A/AAAA/CNAME records behind.

## License

The code is MIT licensed — see [LICENSE](LICENSE). Fork it, learn from it,
reuse it.

The photographs are not. They stay all rights reserved, wherever they appear:
in `content/albums/`, in the `/media/` derivatives the site serves, and in this
repository's git history. [NOTICE](NOTICE) spells out the split.
