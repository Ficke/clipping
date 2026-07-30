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

For work on the store, also install the [Stripe
CLI](https://docs.stripe.com/stripe-cli) (`npm i -g @stripe/cli`) — it forwards
webhooks to `bun run commerce:dev`. See [Selling
downloads](#selling-downloads).

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
deploy from being one command away, and `.githooks/pre-commit` refuses a staged
Stripe key or webhook signing secret — this repo is public, and a committed key
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
nothing but the site build.

## Selling downloads

Photographs can be sold as full-resolution downloads. Payment is Stripe
Checkout; the file is the original out of the archive bucket, presigned for the
buyer. There is still no database — a signed token carries the entitlement.

### Putting a photo on sale

Two frontmatter fields, no code and no Lambda deploy:

```yaml
forSale: true               # offer every photo in the album
photos:
  - file: DSCF7556.jpg
    forSale: false          # …except this one
  - file: DSCF7640.jpg
```

`forSale` on a photo overrides the album in either direction, so a single photo
can be sold out of an album that otherwise is not. Publish it the usual way; the
site build emits `/downloads-catalog.json`, and the Lambda reads that as the
authority on what is purchasable and at what price. **Putting an album on sale is
a content deploy.** Nothing in `infra/` changes.

The Lambda reads that object straight from the site bucket rather than through
CloudFront, so a price change takes effect within its 60-second cache however the
CDN is behaving. The deploy invalidates the public copy too, which matters only
to anything fetching the URL directly.

Prices and licence terms live in `src/lib/downloads.ts`, in one table. A new
licence tier added there appears on every photo already for sale.

### The money path

```
album page  ─ <a href="/api/checkout?sku=…">        (a plain link: no JS, no CSP change)
                 │
CloudFront   /api/*  ──►  commerce Lambda ──►  Stripe Checkout Session ──► 303
                 │
buyer pays on checkout.stripe.com
                 │
                 ├─ POST /api/stripe/webhook  → verify signature → mint token → email
                 └─ GET  /purchase/?session_id=…  → same token, shown immediately
                                                        │
                          GET /api/download?t=…  ──►  302 to a presigned S3 URL
```

The webhook is what guarantees delivery; the landing page is what makes it
instant. Both run the same `fulfillCheckout`, which writes nothing, so running
twice is harmless — only the webhook sends the email, so that happens once.

Four routes, one Lambda, behind the existing distribution at `/api/*`. Its
Function URL is public because Stripe has to POST to it (an OAC-signed POST
needs an `x-amz-content-sha256` header Stripe knows nothing about), so
CloudFront adds a shared secret header and the Lambda refuses anything without
it. The webhook's real guarantee is its own signature.

Entitlements are signed tokens rather than rows: a token names the SKU and the
session and expires in seven days, and is exchanged for a *fresh* 15-minute
presigned URL on every download. So a leaked link is useful for minutes while
the buyer's own link keeps working, and the originals bucket stays private and
un-fronted by CloudFront.

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
      --arg k "rk_test_…" \
      --arg w "whsec_…" \
      --arg d "$(openssl rand -hex 32)" \
      '{stripeApiKey:$k, stripeWebhookSecret:$w, downloadTokenKey:$d}')"
```

Use a [restricted key](https://docs.stripe.com/keys/restricted-api-keys) (`rk_`),
not a secret key, with write access to Checkout Sessions and nothing else.
Rotating `downloadTokenKey` voids every live download link.

**Where keys live.** In SSM Parameter Store as KMS-encrypted `SecureString`
values, and nowhere else — not a file, not a shell export, not a Lambda
environment variable. Two parameters:

| Parameter | Holds | Read by |
| --- | --- | --- |
| `/adamficke-com/commerce` | live keys | the deployed Lambda |
| `/adamficke-com/commerce-test` | test keys | `bun run commerce:dev` |

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
are free up to 4 KB; this payload is about 283 bytes.

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
bun run commerce:listen               # other shell: forwards Stripe webhooks
```

Nothing is for sale until an album says so, so add `forSale: true` to one and
rebuild. Then browse to the album and click the buy link: real Stripe test
Checkout, card `4242 4242 4242 4242`, any future expiry and CVC.

**No key is ever written to disk.** Local development reads
`/adamficke-com/commerce-test` from Parameter Store through the same code path
the deployed Lambda uses. Populate it once, with the same command as the
production secret but with test keys:

```sh
aws ssm put-parameter --overwrite --name /adamficke-com/commerce-test --type SecureString --value …
```

If `stripe listen` reissues its signing secret, override just that field for a
run — no file needed:

```sh
STRIPE_WEBHOOK_SECRET=whsec_… bun run commerce:dev
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

### Go-live checklist

- [ ] **Stripe Tax**: set the head office address in
      [tax settings](https://dashboard.stripe.com/settings/tax), then add a
      registration for the state you are obliged to collect in. `automatic_tax`
      is enabled in code, but **Stripe collects nothing in a jurisdiction with no
      active registration and reports no error** — it silently sells tax-free
      while looking configured.
- [ ] **Product tax code**: `PRODUCT_TAX_CODE` in `src/lib/downloads.ts` is
      `txcd_10501000` (*Digital Photographs/Images — downloaded, permanent
      rights*). The alternative is `txcd_10505001` (*Digital Finished Artwork*),
      a better fit if a licence ever grants reproduction rights. Confirm with a
      tax advisor — it changes what is collected.
- [ ] **Webhook endpoint**: register `https://adamficke.com/api/stripe/webhook`
      for `checkout.session.completed` and
      `checkout.session.async_payment_succeeded`, and put its signing secret in
      the secret above.
- [ ] **Delivery email**: verify an SES identity, set `commerce_from_email` in
      `infra/variables.tf`, and get the account out of the SES sandbox. Left
      empty, buyers still get their file from the landing page and the Lambda
      logs that it emailed nobody.
- [ ] **Payment methods**: whatever is enabled in the
      [Dashboard](https://dashboard.stripe.com/settings/payment_methods) is what
      buyers see. The code never pins `payment_method_types`.
- [ ] **EU/UK**: out of scope by choice. Digital goods owe VAT there from the
      first sale with no threshold, so selling outside the US needs a
      registration decision first.

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
  paths without evicting immutable `/_astro/*` or `/media/*` assets. `/api/*`
  routes to the commerce Lambda, uncached and with no viewer-request function
- **Commerce** (`lambda/`): one Node 22 Lambda on ARM behind `/api/*` — Stripe
  Checkout, the webhook, and presigned downloads. Stateless: Stripe holds the
  order, a signed token holds the entitlement, and `/downloads-catalog.json`
  from the site build holds the prices. See [Selling downloads](#selling-downloads)
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
parameters are free. Stripe charges per sale — 2.9% + 30¢, plus ~0.5% for Stripe
Tax.

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
