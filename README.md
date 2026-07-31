# adamficke.com

Photography portfolio. Astro 7 static site, built in AWS CodeBuild and served
from private S3 buckets through CloudFront. No servers, no database, no admin
surface. Bun runs installs and scripts; photo originals and generated media
live in S3, while git holds album text and small photo manifests.

## First-time setup on a machine

```sh
bun install                            # deps (bun.lock is committed)
git config core.hooksPath .githooks    # block pushes to main + committed keys
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

   Store settings:
     DSCF1234.jpg sale price USD [not for sale]
     DSCF1250.jpg sale price USD [not for sale] 40
   ```

   Each new photo gets one store prompt. Press Enter to leave it unlisted, or
   enter a USD price. Existing photos are not re-prompted on later pushes.

   The story ID is permanent: it keys the S3 archive, the manifest, the URL,
   and any future comments. The script checks it is unused both locally and
   in S3 before writing anything.

   It then lowercases image extensions, rejects unsupported photo formats or
   nested image folders, and writes `index.md`. Before upload it makes a
   temporary, lossless fulfillment copy of every export: GPS, camera, editing,
   and descriptive metadata are removed while the embedded color profile and
   copyright/creator/contact fields are retained. Only that sanitized
   full-resolution copy is synchronized to S3; the temporary copy is deleted.

   The five camera settings shown on album pages are captured before
   sanitization into a small source-metadata sidecar. A later push from a fresh
   clone preserves those approved values from the committed `photos.json` even
   though `photos:pull` returns already-sanitized files.

   Finally it asks where to generate the image variants:

   ```
   Build media for 24 photos:
     codebuild  reproducible, builds from HEAD
     local      faster, builds from your working tree
     where      [codebuild]
   ```

   Both run the same `photos-build-media.mjs` and consume the same contract: the
   sanitized image bytes plus the approved metadata sidecar. Local generation
   reads the temporary staging directory directly; CodeBuild reads the exact
   same bytes after S3 sync. Variant keys derive from each sanitized source
   file's hash, so the two are interchangeable and either warms the cache for
   the other. CodeBuild is the
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
`photos.json`. The new manifest records superseded content hashes. After the
next site deploy has published and invalidated every page that could reference
them, the deploy automatically removes derivative trees that no committed
manifest still uses.
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
deploy from being one command away, and `.githooks/pre-commit` refuses a staged
Stripe API key — this repo is public, and a committed key
is the usual way one gets taken over. Both are advisory: `--no-verify` skips
them, and they only apply once a clone has run the `core.hooksPath` line above.
GitHub's own branch protection would need Pro on a private repo.

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
nothing but the site build. The deploy also waits for its CloudFront
invalidation and runs `photos:gc`, which deletes only derivative hashes marked
obsolete by committed manifests and unused by every current album.

## Selling downloads

Photographs can be sold as full-resolution downloads. Payment is Stripe-hosted
Checkout with Managed Payments: Stripe/Link is merchant of record and handles
covered sales tax, VAT, GST, fraud, disputes, transaction support, and payment
emails. The file is the single full-resolution, metadata-minimized fulfillment
export in the archive bucket, presigned for the buyer. It retains its embedded
color profile and copyright information, but not GPS, camera, or editing
metadata. There is still no database — a signed token carries the entitlement.

Every photograph shares one generic Stripe Product, **Full-resolution
photograph download**. Its description carries the personal-license terms, and
the Product carries Stripe's
Managed Payments classification (`Digital Photographs/Images — downloaded —
non-subscription — permanent rights`) and the personal-license offering. The site
remains authoritative for price, availability, and the mapping from each opaque
`photo_…` identifier to its private original. Stripe never receives the album
slug, filename, or S3 key.

### Putting a photo on sale

Each store lightbox URL ends in the photograph's opaque ID, for example
`/store/#photo_1234567890abcdef12345678`. Use that ID directly for store
changes:

```sh
bun run photos:store -- photo_1234567890abcdef12345678 --price 40
bun run photos:store -- photo_1234567890abcdef12345678 --price 55    # reprice
bun run photos:store -- photo_1234567890abcdef12345678 --remove      # delist
```

The existing `<album> <filename>` form remains available, using an album
folder, permanent story ID, or public slug:

```sh
bun run photos:store -- olympics DSCF7588.jpg --remove
```

The store lightbox previews only the selected photograph; it does not navigate
or preload the rest of the store. Album lightboxes retain their normal
previous/next, keyboard, and swipe navigation.

Omit the action flag for an interactive price/update prompt; add `--dry-run` to
preview without writing. The command writes readable photo-level content:

```yaml
photos:
  - file: DSCF7588.jpg
    forSale: true
    price: 40
```

The site build converts dollars to integer cents and emits the private catalog,
which the Lambda treats as authoritative. A store or price change is a content
deploy; it needs no media upload or Lambda deploy.

Photo removal has deliberately separate scopes:

```sh
bun run photos:store -- photo_1234567890abcdef12345678 --remove
# Delists, but keeps the public album photo and private fulfillment mapping.

bun run photos:site -- olympics DSCF7588.jpg --hide
bun run photos:site -- olympics DSCF7588.jpg --show
# Reversibly removes/restores the public photo; hiding also delists it.

bun run photos:store -- olympics DSCF7588.jpg --purge-catalog
# Also removes fulfillment mapping. Requires confirmation because old purchases break.

bun run photos:store -- olympics DSCF7588.jpg --restore-catalog
# Restores the private mapping; it does not relist the photo for sale.
```

Use `photos:site --hide` instead of deleting an original when the goal is only
to remove it from the website. Physical deletion remains removing the local file
and running `photos:push`; S3 versioning provides a 90-day recovery window. If
the deleted file was the explicit cover, `photos:push` selects the first
remaining visible photo as the new cover. Obsolete public derivatives are
removed automatically after the updated site is deployed.

Everything for sale appears at `/store/`, grouped by album, and that is the only
place with a buy button — album pages stay reading pages. The store is linked in
the header but kept out of search; `/license/`, in the footer, states the grant
in full.

The Lambda reads that object straight from the site bucket rather than through
CloudFront, so a price change takes effect within its 60-second cache regardless
of CDN state.

The catalog object is private application data despite sharing the site bucket:
the CloudFront viewer function returns 404 for `/downloads-catalog.json` while
the commerce Lambda and `commerce:link` read it directly from S3 using IAM.

Each photo's price lives in its album entry. License terms live in
`src/lib/downloads.ts`; a genuinely different license later becomes a separate
Stripe Product and offer without changing the photograph's `photo_id`.

### The money path

```
/store/     ─ <a href="/api/checkout?photo_id=…">   (a plain link: no JS, no CSP change)
                 │
CloudFront   /api/*  ──►  commerce Lambda ──►  Managed Payments Checkout ──► 303
                 │
buyer pays on checkout.stripe.com
                 │
                 └─ GET  /purchase/?session_id=…  → verify paid → mint token
                                                        │
                          GET /api/download?t=…  ──►  302 to a presigned S3 URL
```

Three GET routes, one Lambda, behind the existing distribution at `/api/*`.
CloudFront signs every origin request with SigV4; the Function URL uses IAM auth
and is not directly public.

Entitlements are signed tokens rather than rows: a token names only the opaque
photo ID and Checkout Session, expires in seven days, and is exchanged through
the catalog for a *fresh* 15-minute presigned URL on every download. So a leaked
link is useful for minutes while the buyer's own link keeps working, and the
originals bucket stays private and un-fronted by CloudFront.

The Checkout return URL is only an immediate handoff. It stops minting new
entitlements shortly after the Checkout Session expires, so retaining browser
history is not permanent access. Stripe/Link sends and owns the payment receipt.
If a buyer
loses an expired link, reissue one from a trusted machine:

```sh
aws login
bun run commerce:link -- cs_test_…   # sandbox; link points at localhost:8787
bun run commerce:link -- cs_live_…   # production, later
```

The command re-reads the purchase from Stripe, refuses unpaid, refunded, or
disputed charges, and prints a fresh seven-day link. There is no public admin
route, database, or custom delivery-email service.

### Deploying it

The Lambda is bundled locally and shipped by Terraform, so it deploys on
`terraform apply`, not on a push to `main`:

```sh
bun run lambda:build            # → dist-lambda/index.mjs (gitignored)
cd infra && terraform apply
```

`terraform apply` fails if the bundle is missing — build first.

Terraform creates the parameter holding `{}`, on purpose: Stripe keys must never
pass through Terraform state, and `ignore_changes` keeps it that way. Populate it
out of band:

```sh
aws ssm put-parameter --overwrite \
  --name /adamficke-com/commerce \
  --type SecureString \
  --value "$(jq -nc \
      --arg k "rk_live_…" \
      --arg p "prod_…" \
      --arg d "$(openssl rand -hex 32)" \
      '{stripeApiKey:$k, stripeProductId:$p, downloadTokenKey:$d}')"
```

Use a [restricted key](https://docs.stripe.com/keys/restricted-api-keys) (`rk_`),
not a secret key, with read/write access to Checkout Sessions and read access to
PaymentIntents and Charges for manual refund/dispute checks.
Rotating `downloadTokenKey` voids every live download link.

**Where keys live.** In SSM Parameter Store as KMS-encrypted `SecureString`
values, and nowhere else — not a file, not a shell export, not a Lambda
environment variable. Two parameters:

| Parameter | Holds | Read by |
| --- | --- | --- |
| `/adamficke-com/commerce` | live key, live Product ID, token key | the deployed Lambda |
| `/adamficke-com/commerce-test` | test key, sandbox Product ID, token key | `bun run commerce:dev` |

Separate parameters rather than one, because the Lambda's IAM policy names only
the first: local development cannot reach a live key, and the deployed function
cannot accidentally run on test ones.

`commerce:dev` refuses to start if the parameter it reads holds a live key, and
`.githooks/pre-commit` refuses to commit either kind.

Parameter Store rather than Secrets Manager because the two are equivalent for
this — both KMS-encrypted under a KMS key, both IAM-gated, both audited in
CloudTrail — while Secrets Manager charges $0.40 per secret per month for managed
rotation, cross-region replication, and resource policies that go unused here.
Rotation is pasting a new key from the Stripe dashboard. Standard-tier parameters
are free up to 4 KB.

### Running the store locally

`bun run commerce:dev` serves `dist/` **and** the store on `localhost:8787`, so
the site and `/api/*` share one origin exactly as they do behind CloudFront —
a relative buy link just works, and pretty URLs resolve the way the
viewer-request function resolves them. It runs the real handler, so what passes
here is the code that runs in production.

```sh
aws login                             # keys come from Parameter Store
bun run build                         # the store reads dist/, so build first
bun run commerce:dev                  # → http://localhost:8787
```

Nothing is for sale until a photo has both `forSale: true` and `price`, so use
`photos:store`, rebuild, and browse to the store: real Stripe test
Checkout, card `4242 4242 4242 4242`, any future expiry and CVC.

**No key is ever written to disk.** Local development reads
`/adamficke-com/commerce-test` from Parameter Store through the same code path
the deployed Lambda uses. Populate it once, with the same command as the
production secret but with test keys:

```sh
aws ssm put-parameter --overwrite --name /adamficke-com/commerce-test --type SecureString --value …
```

Exactly one thing is faked: the catalog is read from
`dist/downloads-catalog.json` instead of the site bucket, so putting a photo on
sale locally needs no deploy. Everything else is real, which is why **redeeming
a download link needs a working AWS session** — the file is genuinely presigned
out of the archive bucket.

`commerce:dev` refuses to start if the secret it reads holds an `rk_live`/`sk_live`
key.

Because `dist/` is served rather than watched, rerun `bun run build` after a
change. For pure UI work with hot reload, `bun run dev` is still the right tool —
buy links render there, they just have no store behind them.

### Managed Payments boundary

Managed Payments covers indirect transaction taxes where Stripe supports it:
sales tax, VAT, and GST calculation, collection, registration, filing, and
remittance. It does not cover the photographer's income tax, self-employment
tax, deductions, or business accounting. Stripe's published standard pricing is
3.5% of each successful Managed Payments total (including indirect tax), in
addition to the applicable Payments processing fee.

Checkout sets `managed_payments.enabled`, references the classified Stripe
Product, and deliberately sends no `automatic_tax`, `tax_code`, `tax_behavior`,
tax rate, registration, or jurisdiction logic. Managed Payments collects the
customer details it requires. Stripe's own Managed Payments emails are not
controlled by the normal Dashboard receipt-email toggle.

### Go-live checklist

- [x] **Sandbox Managed Payments**: activated and verified by creating a hosted
      Checkout Session through the real test API.
- [x] **Sandbox Product**: created with tax code `txcd_10501000` (Digital
      Photographs/Images — downloaded — non-subscription — permanent rights), with
      its `prod_…` ID stored beside the sandbox key.
- [x] **Live Stripe setup**: Managed Payments eligibility verified with an unpaid
      live Checkout Session; the classified Product and restricted key are stored
      in the production SSM parameter.
- [ ] **Presentation**: configure the business name, logo, support contact,
      statement descriptor, terms, and privacy policy. Receipts show the product
      as sold through Link.
- [ ] **Payment methods**: enable only immediate methods for launch — cards,
      Link, Apple Pay, and Google Pay. The code deliberately does not pin
      `payment_method_types`, so the Dashboard remains authoritative.
- [x] **Restricted key**: sandbox and live keys are verified with Checkout
      Sessions read/write plus PaymentIntents and Charges read.
- [ ] **Recovery drill**: complete a test purchase, download it, run
      `commerce:link` against an equivalent live Session when available, and
      confirm reissue refuses refunded or disputed charges.

## Where the photos live

Full-quality fulfillment exports live in the versioned
`adamficke-com-originals` bucket at `albums/<storyId>/<file>.jpg`. They are
losslessly stripped of all metadata except color-space and
copyright/creator/contact fields before upload; an unsanitized duplicate is not
stored in AWS. Public derivatives live separately in
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

sharp auto-orients photos and strips metadata from derivatives, so only the
selected camera settings stored in the manifest reach the public site. Export
size is your call: larger fulfillment exports are downscaled, and the site
serves at most 2000 px wide. Changing
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
  paths without evicting immutable `/_astro/*` or `/media/*` assets. `/api/*`
  routes to the commerce Lambda, uncached and with no viewer-request function
- **Commerce** (`lambda/`): one Node 22 Lambda on ARM behind `/api/*` — Stripe
  Checkout and presigned downloads. Stateless: Stripe holds the
  order, a signed token holds the entitlement, and `/downloads-catalog.json`
  from the site build holds the fulfillment mapping, sale state, and prices.
  See [Selling downloads](#selling-downloads)
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

Runs ≈ $0.50–1.50/month. The store adds no fixed cost of its own: Lambda is
inside the free tier at this volume (and pennies beyond it), and SSM standard-tier
parameters are free. Stripe charges per sale — standard US card processing is
2.9% + 30¢, plus 3.5% of the Managed Payments transaction total (including
indirect tax).

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
