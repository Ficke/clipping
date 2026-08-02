# Stripe commerce implementation ledger

This is the durable handoff record for implementing
[`stripe-commerce-architecture.md`](stripe-commerce-architecture.md). Update it
at the end of every implementation session. A code merge, Terraform apply, site
deployment, and Stripe Dashboard change are separate states and must be recorded
separately.

## Current state

| Milestone | Code | Tests | Deployed | Notes |
| --- | --- | --- | --- | --- |
| M0 — contracts and gates | complete | green | no | Ledger, SDKs, split bundles, and CI gates implemented |
| M1 — immutable assets/catalog | code complete | green | no | Backfill command implemented; AWS backfill not run |
| M2 — order state machine | complete | green | no | Domain and DynamoDB repository complete |
| M3 — buyer/webhook APIs | complete | green | no | Durable Buyer, signed Webhook, stateless redemption complete |
| M4 — recovery/local suite | code complete | automated green | no | Operator safety, recovery matrix, temp-table lifecycle, and runbooks complete; real sandbox drill not run |
| M5 — AWS infrastructure | source complete | validate green | no | No authenticated plan or apply |
| M6 — storefront cutover | in progress | build green | no | POST form/polling implemented; v3 activation and browser checks pending |
| M7 — live drill/cleanup | pending | pending | no | Production-only work remains manual |

Checkpoint on 2026-08-02: M4 source complete with 137 tests passing and the
full local code gate green. The real Stripe/AWS sandbox drill remains an
explicit external action.

## Frozen contracts

### HTTP

- `POST /api/checkout`: form-urlencoded body no larger than 1 KB, containing
  exactly one `photo_id`; returns a non-cacheable `303`.
- `GET /api/checkout`: temporary compatibility route during deployment, then
  `405` with `Allow: POST` and no Stripe call.
- `POST /api/stripe-webhook`: signed Stripe JSON no larger than 256 KB.
- `GET /api/fulfill?session_id=…`: `200`, retryable `202`, unknown `404`, or
  indistinguishable expired/closed/revoked `410`.
- `GET /api/download?t=…`: validates a stateless token and returns `302` to S3.
- All routes require the CloudFront origin-verification header, use no CORS, and
  return `Cache-Control: no-store, private`.

### Catalog and fulfillment

- `assetRef` is `<64 lowercase SHA-256 hex>.<lowercase extension>`.
- The immutable object key is `fulfillment/<assetRef>`.
- Catalog v2 temporarily carries additive `assetRef`; catalog v3 contains
  `photoId`, `assetRef`, `forSale`, optional `priceCents`, `albumTitle`, `label`,
  and optional `previewSrc`.
- Token version 1 contains only `version`, `orderId`, `photoId`, `assetRef`, and
  `expiresAt`; redemption reads no catalog, Stripe object, or DynamoDB row.

### Orders

- IDs are `ord_` followed by 32 lowercase hexadecimal characters.
- States are `pending`, `entitled`, `closed`, and `revoked`.
- Automated transitions: `pending -> entitled`, `pending -> closed`, and
  `pending|entitled -> revoked`. `revoked` is terminal for automation.
- Closed rows alone receive `deleteAfter`, 30 days after closure. Restoration
  records `restoredAt`, `restoredBy`, and `restorationReason` after verifying a
  won dispute and absence of refund/current dispute.
- All request-path reads are strongly consistent partition-key reads. There are
  no secondary indexes.

### Secrets and environment

- Buyer secret: `stripeApiKey`, `stripeProductId`, `downloadTokenKey`.
- Webhook secret: `stripeReadApiKey`, `stripeWebhookSecret`, and optional
  `stripeWebhookSecretPrevious`.
- Buyer environment: `COMMERCE_SECRET_PARAM`, `COMMERCE_TABLE`,
  `ORIGINALS_BUCKET`, `SITE_BUCKET`, `SITE_URL`,
  `ORIGIN_VERIFY_HEADER_NAME`, and `ORIGIN_VERIFY_HEADER_VALUE`.
- Webhook environment: `COMMERCE_WEBHOOK_SECRET_PARAM`, `COMMERCE_TABLE`, and
  both origin-verification variables.
- SSM caches expire after five minutes and never retain failed loads.

## Session handoff

- Current task: M4 code is complete. The next external gate is the local
  Stripe/AWS sandbox drill in `stripe-commerce-operations.md`; after that, M5
  needs an authenticated Terraform plan before any apply.
- Last verified commands: `bun test` (137 pass), `bun run typecheck`, Astro
  build, both Lambda bundles, all operator-script bundles, `terraform
  fmt -check`, `terraform validate`, and `git diff --check`.
- Production state: no Terraform apply, site cutover, webhook registration, or
  Stripe live-mode action has occurred.
- Next action: with explicit authorization for AWS and Stripe sandbox changes,
  run the local acceptance drill without deploying; otherwise continue with a
  read-only M5 Terraform plan review.
- Known compatibility rails: keep enriched catalog v2 and legacy GET checkout
  until the M6 activation gate; remove both in M7.

## Verification evidence

Append dated command results, sandbox exercises, Terraform plans/applies, site
deploys, Dashboard changes, and production drill results here. Never include
Session IDs, webhook signatures, API keys, download tokens, presigned URLs, or
customer data.

- 2026-08-02: M0–M3 implementation checkpoint prepared on
  `codex/commerce-v3`. Immutable publishing/catalog tests, order state and
  repository tests, Buyer/Webhook handler tests, typecheck, Astro build, both
  Lambda bundles, Terraform formatting, and Terraform validation passed. No AWS
  backfill, Terraform plan/apply, site deployment, webhook registration, or
  Stripe live-mode action was performed.
- 2026-08-02: M4 code checkpoint completed. Reconciliation now safely recovers
  a missing Checkout Session write (including dry-run parity and
  integrity-before-attach), and covers refund, dispute, async-failure, and
  won-dispute review outcomes. Operator commands validate exact arguments,
  explicit Stripe mode, and table mode. The local harness owns a tagged unique
  temporary table and has tested cleanup for normal, readiness-failure, and
  uncertain create paths. The operations runbook covers sandbox acceptance,
  reconciliation, reissue, restoration, Link escalation, and webhook-secret
  rotation. All 137 tests and the full local code gate passed. No AWS, Stripe,
  catalog backfill, Terraform plan/apply, site deploy, or production action was
  performed.
