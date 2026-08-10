# adamficke.com

This repository contains the code and photo essays for
[adamficke.com](https://adamficke.com), a photography portfolio where visitors
can buy full-resolution downloads. The site is built with Astro and hosted on
AWS. Purchases go through Stripe Checkout, with a small set of Lambda functions
handling orders and download links.

## Getting started

You will need [Bun](https://bun.sh/) and Git. Clone the repository, then run:

```sh
bun install
git config core.hooksPath .githooks
bun run dev
```

Astro will print the address of the local site. Everything needed to build it is
already in the repository, including manifests for the published photos. AWS
access is only needed for publishing photos, testing purchases, or changing the
infrastructure.

Before opening a pull request, check your work with:

```sh
bun test
bun run typecheck
bun run build
```

If you changed anything in `commerce/` or `lambda/`, also run:

```sh
bun run lambda:build
```

CI runs the same checks and validates the Terraform configuration.

## Previewing a production build

The development server is usually enough while you work. Use the production
preview after changing a layout, browser behavior, analytics, or the content
security policy.

```sh
bun run build
bun run preview
```

Leave the preview server running and open a second terminal for the browser
checks:

```sh
bun run preview:check
bun run preview:analytics -- / --csp
bun run preview:analytics -- / --off
```

By default, `preview:check` opens `/photography/salt-point/`, scrolls through
the album, tests the lightbox, and saves screenshots to
`artifacts/preview-check/`. You can give it any route on the site. For example,
after changing the About page, run:

```sh
bun run preview:check -- /about/
```

Pages without a gallery are still checked for browser errors. The two analytics
commands confirm that the production content security policy allows one page
view and that ordinary local visits send no analytics. These checks use Chrome
and expect the preview server to be running.

Google Analytics records one privacy-sanitized page view for every production
page, grouped as Photography, Store, About, License, or Other. The Store group
includes both `/store/` and the post-Checkout `/purchase/` page. Query strings
are excluded so checkout session IDs and other arbitrary URL values cannot be
sent to Google. GA's random first-party browser ID supports new-versus-returning
and same-browser journey reports; the site does not set a User-ID or send names,
emails, order IDs, or checkout identifiers. Google Signals and
ad-personalization signals are disabled in the tag.

On album and store pages, a `view_item` event records a photograph after at
least 40% of it remains visible for 750ms. A `select_item` event records each
photograph shown in the lightbox, including arrow or swipe navigation. Both use
the permanent photo ID, a display label, the album story ID, and a Gallery or
Store context; they contain no visitor or order data.

## Publishing an album

Create a folder under `content/albums/` and add your exported images. A folder
name such as `2026-08-lost-coast` makes albums easy to find, but it does not
become the album's permanent ID.

Start with a dry run:

```sh
bun run photos:push -- content/albums/2026-08-lost-coast --dry-run
```

When the preview looks right, publish the album:

```sh
bun run photos:push -- content/albums/2026-08-lost-coast
```

The command asks for the album details, assigns permanent IDs to new photos,
uploads private masters, and builds the public image sizes. It also creates
`index.md` and `photos.json` in the album folder. Edit `index.md` to add captions,
alternative text, or introductory prose. The [album frontmatter
reference](content/albums/TEMPLATE.md) explains the available fields.

Commit both files when the album is ready. Merging the pull request to `main`
deploys the site.

To update an existing album, first download its current masters:

```sh
bun run photos:pull -- <album>
```

Do not remove a published photo by deleting its local file. Use `photos:remove`
so the photo keeps its identity and existing purchases continue to work. See
[Photo publishing](docs/photo-architecture.md) for removal, restoration, and
permanent deletion.

## Where things live

- `src/` contains the Astro pages, components, and browser code.
- `content/albums/` contains the album writing and generated photo manifests.
- `scripts/` contains commands for publishing photos, operating the store, and
  checking production builds.
- `commerce/` contains the payment and fulfillment rules.
- `lambda/` contains the AWS handlers.
- `infra/` contains the Terraform configuration.

More detail is available in the subsystem guides:

- [Code structure](docs/code-architecture.md)
- [Photo publishing](docs/photo-architecture.md)
- [Store design](docs/commerce.md)
- [Store operations](docs/commerce-operations.md)

When a change is merged to `main`, GitHub Actions packages that exact commit and
sends it to CodeBuild. CodeBuild uses the `buildspec-site.yml` from the same
commit, so the deployment steps always match the code being deployed. A local
pre-push hook blocks direct pushes to `main`. Open a pull request instead.

## License

The code is available under the [MIT License](LICENSE). The photographs are all
rights reserved under [NOTICE](NOTICE).
