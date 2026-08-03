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
| M4 — recovery/local suite | complete | sandbox green | no | Full local sandbox drill passed; event-ordering and won-dispute findings fixed |
| M5 — AWS infrastructure | correction source complete | 151 green; correction acceptance pending | original revision only | REST token gate and 6/3/1 isolation are staged behind additive and CloudFront-cutover apply gates |
| M6 — storefront cutover | in progress | build green | no | POST form/polling implemented; v3 activation and browser checks pending |
| M7 — live drill/cleanup | pending | pending | no | Production-only work remains manual |

Checkpoint on 2026-08-02: M4 is complete with 143 tests passing, the full local
code gate green, and the Stripe/AWS sandbox acceptance drill passed. No
immutable fulfillment object was uploaded or backfilled.

## Frozen contracts

### HTTP

- `POST /api/checkout`: form-urlencoded body no larger than 1 KB, containing
  exactly one `photo_id`; returns a non-cacheable `303`.
- `GET /api/checkout`: strictly validated temporary compatibility during the
  M5/M6 deployment boundary, then `405` with `Allow: POST` and no Stripe call.
- `POST /api/stripe-webhook`: signed Stripe JSON no larger than 256 KB.
- `GET /api/fulfill?session_id=…`: `200`, retryable `202`, unknown `404`, or
  indistinguishable expired/closed/revoked `410`.
- `GET /api/download?t=…`: validates a stateless token and returns `302` to S3.
- All REST methods require the derived CloudFront gateway token before
  integration; Buyer and Webhook also require the original origin-verification
  header. Routes use no CORS and return `Cache-Control: no-store, private`.

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
  `COMMERCE_ALLOW_LEGACY_GET_CHECKOUT`, `ORIGINALS_BUCKET`, `SITE_BUCKET`,
  `SITE_URL`, `ORIGIN_VERIFY_HEADER_NAME`, and `ORIGIN_VERIFY_HEADER_VALUE`.
- Webhook environment: `COMMERCE_WEBHOOK_SECRET_PARAM`, `COMMERCE_TABLE`, and
  both origin-verification variables.
- Authorizer environment: `COMMERCE_GATEWAY_TOKEN` only; its IAM role can write
  only to its exact log group.
- SSM caches expire after five minutes and never retain failed loads.

## Session handoff

- Current task: the M5 ingress correction source is complete. It adds an exact
  pre-integration REST token gate, Authorizer, REST payload-v1 compatibility,
  and Buyer/Webhook/Authorizer reservations of 6/3/1 while retaining the HTTP
  API and legacy Function URL rollback rails. The rollout defaults to additive;
  CloudFront remains on the HTTP API until a second apply gate.
- Last verified commands: `bun test` (151 pass), `bun run typecheck`, Astro
  build, Buyer/Webhook/Authorizer bundles, all commerce and fulfillment operator
  bundles, `terraform fmt -check`, `terraform validate`, and `git diff --check`.
- Production state: M5 infrastructure is applied. No site deployment or
  storefront-v3 activation, webhook registration/population, fulfillment
  upload/backfill, live purchase, or other Stripe live-mode action has
  occurred. The alarm email subscription awaits recipient confirmation.
- Next action: reauthenticate AWS, inspect the regional API Gateway
  `cloudWatchRoleArn`, and request explicit approval for the adjustable Lambda
  concurrency quota increase from 10 to 110. After the quota is granted,
  recover the existing origin value only into memory, review the additive exact
  plan with `commerce_rest_cutover_enabled = false`, and stop for apply
  approval. The CloudFront flip is a later exact-plan/apply gate.
- Known compatibility rails: keep enriched catalog v2, legacy GET checkout, the
  deployed HTTP API, and the legacy Function URL runtime until their documented
  M6/M7 gates.

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
- 2026-08-02: The full local acceptance drill passed against Stripe sandbox and
  temporary AWS DynamoDB tables. Invalid checkout requests stayed local. A paid
  Checkout completed through hosted sandbox Checkout, its signed webhook was
  accepted, fulfillment issued a stateless token, token redemption returned the
  expected S3 redirect without following it, and manual reissue produced a
  fresh link. A separate refund webhook revoked fulfillment and reissue while a
  token issued before revocation remained valid by design. A dispute test
  exposed real delivery ordering in which revocation preceded Checkout
  completion; the handler now acknowledges that terminal ordering, and a fresh
  listener-backed repeat accepted both events while preserving revocation. A
  won dispute then required review, explicit audited restoration, and allowed
  reissue. Full-table reconciliation succeeded in dry-run and write modes with
  zero failures. Both harness-created tables were deleted and their absence was
  confirmed. The sandbox restricted key was verified with Checkout Sessions
  write, Payment Intents read, Charges and Refunds read, Payment Disputes read,
  and Events read. No capability identifiers, secrets, customer data, or
  presigned URLs were recorded. No fulfillment upload/backfill, Terraform
  plan/apply, deployment, webhook registration, storefront activation, or live
  Stripe action occurred.
- 2026-08-02: An authenticated M5 Terraform plan completed with state locking
  disabled and a named, non-secret origin-verification placeholder that must
  never be used for apply. The plan proposed 38 additions, 9 in-place changes,
  and 9 deletions. Additions cover the durable order table, HTTP API and scoped
  routes, split Buyer/Webhook Lambdas and roles, log groups, alarms, the
  purchase response-header policy, and the separate webhook parameter. The
  changes update CloudFront routing/security, related bucket-policy documents,
  the media-build fulfillment grant, and parameter descriptions without
  changing existing SecureString values. IAM review confirmed the Buyer role is
  limited to its parameter, order reads/writes, catalog read, and
  `fulfillment/*` reads; the Webhook role is limited to its parameter and order
  reads/updates; API invocation permissions are route-scoped; and the only new
  build permission is `s3:GetObject`/`s3:PutObject` on `fulfillment/*`. All nine
  deletions are the superseded single commerce Lambda runtime: its function,
  Function URL, role/policy, log group, alarm, origin access control, and two
  CloudFront invocation permissions. There were no same-address replacements
  or unrelated deletions. The temporary saved plan was not applied and was
  removed after review. No AWS resource, Terraform state, deployment, webhook,
  storefront, S3 object, or Stripe object was changed by this planning step.
- 2026-08-02: The M5 gate was revised after a substantive rollback review. A
  temporary Terraform rollback rail now retains and guards the deployed legacy
  commerce Lambda, Function URL, role and policy, log group, alarm, Lambda
  origin access control, and two CloudFront permissions through M7. Read-only
  AWS checks confirmed that the legacy function is active, its last update
  succeeded, and its IAM-protected buffered Function URL remains available.
  The missing SNS subscription was also confirmed as remote state rather than
  a replacement; applying its addition will require a new email confirmation.
  Existing Buyer and test parameter descriptions were restored so neither
  existing SecureString is touched by M5. A required M5/M6 compatibility check
  then found that routing the deployed GET storefront to a POST-only Buyer would
  break purchases. The Buyer now has an explicit, strictly validated legacy GET
  checkout switch: M5 enables it, M6 disables it after the POST storefront has
  propagated, and M7 removes the route. The complete local gate passed with
  145 tests, typecheck, Astro, split Lambda and operator bundles, Terraform
  formatting/validation, and diff checks green. A fresh authenticated plan used
  a 32-byte random origin-verification value held only in a history-disabled
  shell and proposed 38 additions, 7 in-place changes, and zero deletions. The
  additions are the durable table, HTTP API and explicit throttled routes,
  split Lambdas and scoped roles, logs, alarms, purchase response policy,
  webhook parameter shell, and missing alarm subscription. The changes are the
  HTTP API CloudFront cutover, CSP and referrer-log privacy controls, the
  `fulfillment/*` media-build grant, and dependency-driven re-rendering of the
  otherwise unchanged site-build and site/media bucket policies. The legacy
  rollback resources and existing SSM parameters have no planned action. The
  random value and sanitized plan text were cleared after review; no saved plan
  or secret-bearing file was created. No apply, deployment, webhook change,
  storefront activation, S3 upload/backfill, or Stripe action occurred.
- 2026-08-02: The user explicitly approved the exact prompt-time M5 plan after
  it reproduced the reviewed 38-add/7-change/0-destroy delta with a fresh
  32-byte origin-verification value held only in a history-disabled shell. The
  apply completed with 38 additions, four material in-place changes, and zero
  deletions; three dependency-rendered policy updates collapsed to no-ops. A
  post-apply plan using the same in-memory value reported no changes, after
  which the environment value was unset and the shell exited. The value was
  never printed, logged, committed, or saved in a plan file and remains only in
  encrypted Terraform state and deployed configuration.
- 2026-08-02: Sanitized post-apply checks verified the active encrypted,
  point-in-time-recoverable, TTL-enabled on-demand order table; the HTTP API's
  five exact routes, auto-deployed default stage, sanitized access-log fields,
  and route throttle settings; active arm64 Buyer and Webhook Lambdas; the
  retained active legacy Lambda and IAM-protected Function URL rollback rail;
  route-scoped Lambda permissions; exact per-function SSM, KMS, DynamoDB, S3,
  catalog, and log IAM scopes; 30-day log retention; expected alarms; deployed
  CloudFront origin, custom origin-verification header name, behaviors, cache
  and origin-request policies, response-header policies, and referrer-free
  access logs; and the three expected SecureString parameters by metadata only.
  The Buyer and test parameter versions remained unchanged, and the webhook
  parameter is an unpopulated shell. The new SNS subscription is pending email
  confirmation. Direct API access without the origin header returned 403;
  CloudFront-delivered malformed checkout and fulfillment probes returned the
  expected non-cacheable 400 responses; and the purchase response policy was
  present. No secret value, valid checkout, webhook event, Stripe request,
  customer data, site deployment, storefront activation, fulfillment object,
  or backfill was involved.
- 2026-08-02: A safe 30-request direct-API burst without the origin header
  exposed an M5 acceptance failure: 17 requests returned 403 and 13 returned
  503, while the Buyer recorded 12 invocations and 11 throttles in the same
  minute. This demonstrates that the configured HTTP API route throttle did
  not reliably reject requests before Lambda concurrency was consumed. AWS
  documents HTTP API throttles as best-effort targets that clients can exceed,
  not guaranteed ceilings. M5 is therefore deployed and drift-free but not
  accepted as meeting the documented hard pre-invocation isolation property.
  No corrective Terraform apply is authorized; webhook registration,
  storefront activation, and all later production gates remain stopped pending
  a separately reviewed mitigation.
- 2026-08-02: The M5 correction source was completed without an AWS mutation or
  Terraform plan. A new Regional REST API is defined additively with five exact
  methods and a cached `TOKEN` authorizer. CloudFront will overwrite a dedicated
  gateway-token header derived in Terraform from the existing random origin
  value; API Gateway's exact validation expression rejects other values before
  authorizer or integration invocation, and the Authorizer repeats a
  timing-safe comparison with only CloudWatch Logs IAM. Buyer, Webhook, and
  Authorizer reserved concurrency is 6/3/1, contingent on a separately approved
  us-east-1 quota increase from 10 to 110. Buyer and Webhook accept both the REST
  proxy v1 and deployed HTTP/Function URL v2 payloads, including duplicate query
  fields and exact base64-decoded webhook bytes. The rollout flag defaults
  false, so the first apply cannot change the CloudFront commerce origin; the
  HTTP API and legacy runtime remain rollback rails. A later committed flag
  change and exact plan gate the CloudFront-only cutover. All 151 tests,
  typecheck, Astro, three Lambda bundles, commerce/fulfillment operator bundles,
  Terraform formatting/validation, and diff checks passed. The last
  authenticated read confirmed the regional Lambda quota is 10, adjustable,
  with no pending request; the subsequent API Gateway account read was blocked
  by session expiry and must be repeated before planning. No quota request,
  Terraform plan/apply, CloudFront change, webhook action, storefront/site
  deployment, S3 fulfillment upload/backfill, Stripe request, or secret access
  occurred.
