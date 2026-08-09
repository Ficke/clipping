# Code architecture

TypeScript is the default language for authored executable code. JavaScript is
allowed only for generated output, vendored tooling, or a documented toolchain
constraint. `scripts/typescript-policy.test.ts` contains the shrinking allowlist
of legacy `.mjs` files; every migration removes entries, and new JavaScript
source fails CI.

## Dependency direction

`shared/` owns runtime-neutral domain primitives and serialized contracts. It
must not import Astro, AWS, Stripe, filesystem, or process APIs.

The runtime-specific directories depend inward on that shared layer:

```text
                  shared/
                 /   |   \
                v    v    v
              src/ lambda/ scripts/
```

- `src/` adapts the shared model to Astro content, pages, and browser code.
- `lambda/` contains deployed AWS entrypoints and adapters.
- `scripts/` contains Bun CLI entrypoints and operator adapters.

Reusable commerce operations currently under `lambda/` will move into a
runtime-neutral `commerce/` application layer as their callers are converted.
CLI code should then import that layer rather than a deployment entrypoint.

Avoid a general `utils.ts`. Shared modules are grouped by domain and expose a
small, intentional API. The planned groups are identity, albums and lifecycle,
media manifests, commerce and money, and storage keys.

## Boundary rule

TypeScript types do not validate external data. JSON, Markdown frontmatter,
environment variables, CLI arguments, Stripe objects, and AWS records enter as
`unknown` and must be parsed or validated at their boundary. Types used after a
boundary should be inferred from or returned by that validator, so producers
and consumers cannot maintain independent versions of the same contract.

## Domain language

| Term | Meaning |
| --- | --- |
| Album | The authored, folder-independent collection of photographs. |
| `storyId` | The album's permanent persisted identifier. Do not call it `album` inside new serialized contracts. |
| Export | A local camera/editing output before publishing. |
| Master | The private, sanitized full-resolution file delivered to buyers. |
| Derivative | A public resized or reformatted media asset. |
| Album photo | The authored record containing presentation and lifecycle decisions. |
| Manifest entry | Generated facts about one live photograph and its derivatives. |
| `priceDollars` | A human-authored frontmatter value, used only at that boundary. |
| `priceCents` | A positive integer used by application and commerce code. |
| Lifecycle state | `live`, `removed`, or `deleted`; one shared validator owns the legal transitions. |

Persisted field renames require a versioned parser and migration. Code may use
clearer names internally without silently reinterpreting an existing manifest.

## Migration sequence

1. Delete obsolete one-shot tooling before converting it.
2. Move a contract or primitive into `shared/` with focused tests.
3. Convert its reusable script libraries and tests to `.ts`.
4. Convert thin entrypoints, updating package and CodeBuild references together.
5. Remove the converted files from the legacy JavaScript allowlist.
6. Run `bun test`, `bun run typecheck`, `bun run build`, and
   `bun run lambda:build`.

Large entrypoints such as photo publishing and media generation should be split
around pure operations before or during conversion. The goal is not merely a
different extension: it is one checked contract shared by every runtime.
