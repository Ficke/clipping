# adamficke.com

Photography portfolio and full-resolution download store. Astro builds a static
site; AWS serves it from private S3 buckets through CloudFront. Stripe-hosted
Checkout and three small Lambdas handle purchases without a long-running server
or public admin interface.

## Local development

Requirements: [Bun](https://bun.sh/) and Git. Album and infrastructure work also
requires authenticated AWS access.

```sh
bun install
git config core.hooksPath .githooks
bun run dev
```

A fresh clone can build from the committed photo manifests. Run `bun run
photos:pull` only when you need local copies of existing masters. These are the
sanitized files stored in S3, not the original camera exports.

Before opening a pull request, run:

```sh
bun test
bun run typecheck
bun run build
```

## Publishing an album

1. Put exported images in a new directory under `content/albums/`. A
   `YYYY-MM-name` directory keeps albums easy to scan, but the directory name is
   not part of the album's identity.
2. Preview the upload, then publish the media:

   ```sh
   bun run photos:push -- content/albums/2026-08-lost-coast --dry-run
   bun run photos:push -- content/albums/2026-08-lost-coast
   ```

   The first real push asks for the title, permanent story ID, dates, location,
   cover, and optional sale prices. It also mints permanent photo IDs, strips
   private metadata from the uploaded masters, archives that metadata separately,
   and generates the public derivatives.
3. Edit the generated `index.md` to add captions, alt text, or album prose. See
   [the album template](content/albums/TEMPLATE.md) for the supported fields.
4. Run the checks above, commit `index.md` and `photos.json`, and open a pull
   request. Merging to `main` deploys the site.

For an existing album, start with `bun run photos:pull`, make the changes, and
run the same push sequence. Do not remove a photograph by deleting its local
file; use the lifecycle commands below so its identity and purchase history are
preserved.

`storyId` and each `photoId` are permanent. Titles, filenames, folder names,
captions, alt text, cover choice, and photo order can change safely.

## Store and photo lifecycle

A `price` on a photo's frontmatter entry puts it on sale. Use the photo ID shown
in the store URL, or an album plus filename:

```sh
bun run photos:store -- photo_1234567890abcdef12345678 --price 40
bun run photos:store -- photo_1234567890abcdef12345678 --delist
bun run photos:store -- olympics DSCF7588.jpg --price 55
```

Store changes require a normal site build and deploy, but no media or Lambda
deploy. The photo lifecycle is deliberately separate:

```sh
bun run photos:remove -- olympics DSCF7588.jpg
bun run photos:restore -- olympics DSCF7588.jpg
bun run photos:delete -- olympics DSCF7588.jpg
```

- `remove` takes a photo out of the album and store but retains its master, so
  existing buyers keep access. It is reversible.
- `restore` returns a removed photo to the album; run `photos:push` afterward to
  rebuild derivatives if garbage collection has removed them.
- `delete` destroys the master and metadata after an explicit confirmation. It
  is allowed only after removal; S3 versioning provides a 90-day recovery window.

Run `bun run photos:sales -- <photo-id>` before a permanent deletion to inspect
orders for that photograph.

The commerce design and operational procedures are intentionally kept out of
this README:

- [Commerce architecture](docs/commerce.md)
- [Commerce operations and recovery](docs/commerce-operations.md)
- [Photo storage and publishing architecture](docs/photo-architecture.md)

## Architecture

- `src/` contains the Astro site and browser code. The output is static HTML,
  CSS, and JavaScript.
- `shared/` contains runtime-neutral TypeScript primitives used by the site,
  Lambdas, and operator commands.
- `lambda/` contains the Buyer, Webhook, and origin Authorizer Lambdas. DynamoDB
  stores durable order state; signed download tokens redeem against private S3
  masters.
- `scripts/` contains the photo and commerce operator commands.
- `content/albums/` contains authored album Markdown and generated
  `photos.json` manifests. Full-resolution images are ignored by Git.
- `infra/` contains Terraform for S3, CloudFront, Route 53, CodeBuild, Lambda,
  API Gateway, DynamoDB, logging, and alarms.

The source-language and dependency rules are documented in
[Code architecture](docs/code-architecture.md).

Photo media and site publishing are separate pipelines. A media build reads
private masters and creates immutable, content-addressed derivatives. The fast
site build reads only committed manifests, so a text edit does not download or
reprocess the photo archive.

GitHub Actions deploys `main` by assuming an AWS role through OIDC and starting
the site CodeBuild project. The local pre-push hook blocks direct pushes to
`main`; use a branch and pull request.

## License

The code is MIT licensed; see [LICENSE](LICENSE). The photographs remain all
rights reserved under [NOTICE](NOTICE), including copies in Git history and
generated derivatives.
