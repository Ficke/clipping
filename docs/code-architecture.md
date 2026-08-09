# Code structure

Most of the project is organized into a few layers. The code that knows the
least about its surroundings sits at the center, while code that talks to Astro,
AWS, Stripe, or the command line stays near the outside.

```text
src/      Astro pages, components, and browser code
shared/   types and validation used across the project
commerce/ payment and fulfillment rules
lambda/   AWS handlers and adapters
scripts/  Bun commands and local tools
infra/    Terraform
```

Application and tooling code in the JavaScript ecosystem is written in
TypeScript. Build tools may generate JavaScript in ignored directories, but
generated files should never be committed. The
`bun run check:typescript-policy` command checks this in CI.

## Deciding where code belongs

Start with the narrowest layer that can own the behavior. A rule about whether
an order can be refunded belongs in `commerce/`. The code that reads the order
from DynamoDB belongs in `lambda/`. Keeping those concerns separate lets us test
the rule without starting AWS services.

The allowed dependencies look like this:

```text
src/      -> shared/
commerce/ -> shared/
lambda/   -> commerce/, shared/
scripts/  -> commerce/, shared/, selected Lambda adapters
```

Nothing in `shared/` should import Astro, AWS, Stripe, filesystem APIs, or
process APIs. Both `src/` and `commerce/` can use `shared/`, but they should not
depend on each other. Lambda handlers connect the commerce rules to AWS, and the
scripts reuse those layers for local and administrative commands.

## Checking data at the edges

TypeScript cannot tell us whether a JSON file, environment variable, or Stripe
response is valid at runtime. Parse outside data when it enters the application,
then pass the checked value to the rest of the code. The same rule applies to
album frontmatter, command-line arguments, and AWS records.

Keep each stored format tied to one parser. If a producer and consumer define
separate versions of the same shape, they can drift without the compiler
noticing.

## Names that carry meaning

An album keeps the same `storyId` even if its title or folder changes. A photo
keeps the same `photoId` when it is renamed or re-exported. These IDs are stored
in manifests and orders, so changing their meaning requires a migration that can
still read existing data.

The private full-resolution image is called a master. Public resized images are
called derivatives. Album frontmatter records prices in dollars as
`priceDollars`, while application and commerce code use integer `priceCents`.

## Checking a change

Run the standard checks before opening a pull request:

```sh
bun test
bun run typecheck
bun run build
```

If the change touches `commerce/`, `lambda/`, or a shared type they use, also
run `bun run lambda:build`. Update the relevant guide whenever you change a
command, stored format, or developer workflow.
