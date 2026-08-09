# Code architecture

All tracked executable source is TypeScript. Bundlers may emit JavaScript into
ignored build directories, but generated output is never committed.
`scripts/typescript-policy.test.ts` rejects every tracked `.js`, `.mjs`, or
`.cjs` file, and CI runs that policy explicitly.

## Dependency direction

`shared/` owns runtime-neutral domain primitives and serialized contracts. It
must not import Astro, AWS, Stripe, filesystem, or process APIs.

Runtime-specific directories depend inward on the domain layers:

```text
src/      -> shared/
commerce/ -> shared/
lambda/   -> commerce/, shared/
scripts/  -> shared/, commerce/, selected lambda/ adapters
```

- `src/` adapts the shared model to Astro content, pages, and browser code.
- `commerce/` owns runtime-neutral order, entitlement, checkout, fulfillment,
  and reconciliation operations.
- `lambda/` contains deployed AWS entrypoints and AWS adapters.
- `scripts/` contains Bun CLI entrypoints and operator adapters.

CLI code imports `commerce/` operations and uses Lambda modules only for
deployment adapters such as the DynamoDB repository and secret parsing.

Avoid a general `utils.ts`. Shared modules are grouped by domain and expose a
small, intentional API: `ids.ts` owns identities, `album.ts` owns authored album
and lifecycle contracts, `media.ts` owns serialized media contracts, and
`commerce.ts` owns catalog and money contracts. Storage keys remain with the
download domain because their format is part of fulfillment behavior.

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

## Names, structure, and comments

These conventions follow the MIT Communication Lab's
[Coding and Comment Style](https://mitcommlab.mit.edu/broad/commkit/coding-and-comment-style/)
guidance.

Names carry the first explanation. Use nouns for values and types, verbs for
operations, and domain terms from the table above. Prefer a small function with
a specific name to a comment that narrates a large block. Group code by purpose
and break long expressions vertically so the important operation remains
visible without horizontal scrolling.

Comments explain constraints, tradeoffs, safety properties, or non-obvious
external behavior. They are complete sentences and live next to the decision
they explain. Do not restate a function name or translate one line of code into
English. Update or remove a comment in the same change that invalidates it;
incorrect guidance is worse than no comment. Public runbooks and contracts
belong in `README.md` or `docs/`, while implementation detail stays with the
code.

## Change checklist

1. Put shared contracts at the innermost applicable domain layer.
2. Parse external data at its boundary and use the validated type afterward.
3. Split large entrypoints around operations that can be tested independently.
4. Update package, CodeBuild, CI, and documentation references together.
5. Keep the tracked-JavaScript policy at zero files.
6. Run `bun test`, `bun run typecheck`, `bun run build`, and, when commerce or
   Lambda code changed, `bun run lambda:build`.
