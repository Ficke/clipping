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
| M1 — immutable assets/catalog | code complete | 151 green; sellable dry run passed | 6 sellable assets | Exactly six checksum-verified objects remain; nonsellable surplus was removed |
| M2 — order state machine | complete | green | no | Domain and DynamoDB repository complete |
| M3 — buyer/webhook APIs | complete | green | no | Durable Buyer, signed Webhook, stateless redemption complete |
| M4 — recovery/local suite | complete | sandbox green | no | Full local sandbox drill passed; event-ordering and won-dispute findings fixed |
| M5 — AWS infrastructure | complete | 151 green; ingress and isolation passed | Gates A-D | CloudFront routes commerce to protected REST with 5/3/2 reservations; old HTTP endpoint is disabled |
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
  `ORIGINALS_BUCKET`, `SITE_BUCKET`,
  `SITE_URL`, `ORIGIN_VERIFY_HEADER_NAME`, and `ORIGIN_VERIFY_HEADER_VALUES`.
- Webhook environment: `COMMERCE_WEBHOOK_SECRET_PARAM`, `COMMERCE_TABLE`, and
  both origin-verification variables.
- Authorizer environment: `ORIGIN_VERIFY_HEADER_VALUES` only; its IAM role can
  write only to its exact log group.
- `ORIGIN_VERIFY_HEADER_VALUES` carries both generated secrets, comma-separated.
  CloudFront sends one; every component accepts either, so rotation propagates
  without a rejection window.
- SSM caches expire after five minutes and never retain failed loads.

## Session handoff

- Current task: commit and publish the reviewed branch, then perform the M6 POST
  storefront deployment through the main-only release workflow. The six
  sellable assets and infrastructure Gates A-D are deployed, verified, and
  drift-free.
- Rollout defaults are `commerce_reserved_concurrency_enabled = true`,
  `commerce_rest_cutover_enabled = true`, and
  `commerce_http_api_dormant = true`. M6 deploys the POST storefront and catalog
  containing immutable `assetRef` values. Rollback re-enables HTTP before
  repointing CloudFront. Never combine those operations.
- Last verified commands: `bun test` (151 pass), `bun run typecheck`, Astro
  build, Buyer/Webhook/Authorizer bundles, all commerce and fulfillment operator
  bundles, `terraform fmt -check`, `terraform validate`, and `git diff --check`.
- Gate A evidence: missing and same-length incorrect tokens returned `401`
  without Lambda invocation. One authorized empty-form checkout returned a
  non-cacheable `400`, invoked Authorizer and Buyer exactly once, did not invoke
  Webhook, and wrote no order. The final Terraform plan had zero drift. The SNS
  email subscription was replaced after its old link expired and is confirmed.
- Production state: CloudFront is `Deployed` against REST API `w98yd824p3` at
  `/commerce`, with both protected origin headers. Public checkout and fulfill
  validation probes return the expected non-cacheable `400`; direct REST
  requests with missing or incorrect gateway tokens return `401` before Lambda.
  HTTP API `ugmazzudce` remains managed but its default endpoint is disabled.
  Buyer, Webhook, and Authorizer reserve
  5/3/2 concurrency, leaving 990 unreserved from the 1000 account limit. Seven
  commerce alarms exist, the SNS email subscription is confirmed, and the order
  table is empty. No site/storefront activation, webhook registration or secret
  population, Stripe request, fulfillment upload/backfill, or live purchase
  occurred.
- The separately approved Lambda concurrency request targets 1001 because AWS
  rejects self-service requests below its published default of 1000. Request
  `c2417d3b4a624900a758f086935b5722QepcbJ1M` remains `CASE_OPENED`, but AWS has
  already raised the applied quota to 1000. The applied 5/3/2 reservations leave
  990 unreserved. Do not generate a replacement origin value, save a plan to
  persistent storage, or recompute a plan during apply.
- Complete: POST storefront deployed and propagated; legacy GET checkout
  disabled then removed from both APIs and from the Buyer; the legacy Function
  URL runtime, its role, log group, alarm, and origin access control deleted at
  the M7 gate; the production webhook endpoint registered against live mode with
  both secrets stored.
- Outstanding: the live purchase drill has never run, so no order has reached
  `entitled` in production and the download, token, and revocation paths are
  unexercised outside the sandbox. The commerce alarm topic also needs a
  confirmed subscriber; its Gate A email subscription expired unconfirmed, so
  all seven alarms currently publish to nobody.
- Remaining compatibility rails: enriched catalog v2, and the dormant HTTP API
  configuration. Both APIs share the Buyer, so rollback is two variable flips
  (`commerce_rest_cutover_enabled`, `commerce_http_api_dormant`) plus CloudFront
  propagation. Retire the HTTP API once the drill has passed.

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
- 2026-08-08: A source-only revision-5 prework review found that the retained
  HTTP API would remain a public invocation path after the REST cutover and
  could still consume Buyer or Webhook reservations directly. The rollout now
  has a third apply gate that disables the HTTP API default endpoint only after
  CloudFront has fully deployed the REST origin; ordered rollback re-enables
  HTTP before repointing CloudFront. Reservations are rebalanced to 5/3/2 to
  remove the Authorizer's single-slot cold-cache bottleneck. The source also
  adds the absent regional API Gateway logging role/account setting with
  commerce-log-group-scoped writes and expands the REST deployment fingerprint
  to cover every material deployed configuration. Authenticated reads confirmed
  the Lambda quota is still 10 with no pending request, `cloudWatchRoleArn` is
  null, the HTTP API endpoint is enabled, CloudFront still uses it, the table
  and alarms are healthy, and the alarm topic has no subscriber. No quota
  request, Terraform plan/apply, state write, CloudFront change, webhook or
  Stripe action, site deployment, fulfillment upload/backfill, or secret read
  occurred. The exact-plan procedure now uses a volatile RAM-backed plan file
  so approval and apply refer to the same artifact without persisting it.
- 2026-08-08: A read-only cost review confirmed that the correction introduces
  no provisioned concurrency, API cache, NAT gateway, WAF, paid parameter tier,
  customer-managed KMS key, or other fixed hourly service. The alarm design was
  consolidated from an eventual 15 standard alarms to seven: HTTP and REST API
  `5xx`, legacy/Buyer/Webhook/Authorizer errors, and Webhook throttles. Exhausted
  DynamoDB failures and Buyer/Authorizer throttle impact already reach an API
  `5xx` alarm, so the six per-operation DynamoDB alarms and Buyer throttle alarm
  are intentionally removed by Gate A. All 151 tests, typecheck, Astro, three
  Lambda bundles, Terraform formatting/validation, and diff checks passed. AWS
  still has the 12 previously deployed alarms; no quota request, Terraform plan
  or apply, alarm deletion, or other cloud mutation occurred.
- 2026-08-08: AWS rejected the initially approved concurrency target of 110
  before creating a request because both its CLI and console require a value at
  least as large as the published 1000 default even though this account's
  applied new-account quota is 10. The user superseded that target with 1001.
  Request `c2417d3b4a624900a758f086935b5722QepcbJ1M` was created in us-east-1
  with status `CASE_OPENED`; the applied quota remains 10 pending AWS action.
  The correction still reserves Buyer/Webhook/Authorizer at 5/3/2, which will
  leave 991 units unreserved at the approved target. No Terraform plan or
  apply, browser action, webhook or Stripe action, site deployment, or
  fulfillment upload/backfill occurred.
- 2026-08-08: The user approved splitting the correction rather than blocking
  all additive work on the quota review. Revision 6 adds a default-false
  `commerce_reserved_concurrency_enabled` gate. Gate A adds the protected REST
  path, logging, alarms, subscription, and compatible bundles without reserved
  concurrency while CloudFront remains on HTTP API. Gates B and C may then cut
  CloudFront to REST and make HTTP dormant while the account-wide concurrency
  limit remains 10. M6 may deploy the POST storefront after those infrastructure
  gates. After quota 1001 is granted, Gate D enables only the 5/3/2
  reservations. No Terraform plan/apply or AWS infrastructure mutation
  occurred.
- 2026-08-08: The approved RAM-backed Gate A plan passed its hash, source,
  worktree, and AWS-account checks and was applied directly without
  regeneration. It partially succeeded, then API Gateway rejected the regional
  `cloudWatchRoleArn` because the dedicated inline policy did not match the
  service's required wildcard CloudWatch Logs permission set. The REST API,
  Authorizer, roles, logs, compatible Buyer/Webhook bundles, six of the final
  seven alarms, and a pending email subscription now exist, but the REST stage
  did not complete; CloudFront and the enabled HTTP API remain unchanged. The
  consumed RAM plan was ejected and the in-memory origin value cleared. Source
  now adds `logs:CreateLogGroup` and uses the complete documented Logs action
  set on `Resource: "*"`, isolated on the dedicated API Gateway role. No retry,
  replacement plan, CloudFront/site change, Stripe/webhook action, or
  fulfillment upload/backfill occurred.
- 2026-08-08: The separately approved RAM-backed Gate A recovery plan at source
  commit `489af92` passed its artifact hash, clean-worktree, and AWS-account
  checks and applied directly without regeneration: eight additions, three
  in-place changes, and zero deletions. It corrected the dedicated API Gateway
  Logs policy, set the regional `cloudWatchRoleArn`, created the REST stage and
  five method settings, added the REST `5xx` alarm, and converged both gateway
  responses. Gate A now has seven alarms total and an email subscription
  awaiting confirmation. Five missing-token and five same-length wrong-token
  direct REST probes all returned `401`; access logs showed no integration and
  CloudWatch reported zero Authorizer, Buyer, and Webhook invocations. The user
  paused before the correct-token malformed-body probe, so it and the zero-drift
  check remain pending. Both consumed RAM volumes were ejected, all in-memory
  origin/token values were cleared, and no secret-bearing shell remains. The
  quota request remains `CASE_OPENED` at desired 1001. A later monitor read
  confirmed AWS raised the applied limit and unreserved pool to 1000; all three
  functions remain unreserved. Gate D is therefore next and should produce
  5/3/2/990. CloudFront remains on the enabled HTTP API. No Stripe, webhook
  registration, site deployment, or fulfillment upload/backfill action
  occurred.
- 2026-08-08: Gates A, D, and B completed. The authorized empty-form Gate A
  probe returned a non-cacheable `400` with exactly one Authorizer and Buyer
  invocation, no Webhook invocation, and no order write; the source now models
  API Gateway's restored default response templates and plans with zero drift.
  The expired SNS subscription was replaced and the new email subscription is
  confirmed. The exact Gate D apply changed only Buyer/Webhook/Authorizer
  reservations to 5/3/2, leaving 990 unreserved; five concurrent Buyer probes
  and one malformed Webhook probe all returned `400` without an order write.
  The exact Gate B apply materially changed only CloudFront, which is `Deployed`
  against REST API `w98yd824p3` at `/commerce` with both protected headers.
  Public validation probes returned expected non-cacheable `400` responses and
  direct missing/incorrect-token requests returned `401` with no Lambda
  invocation. Final Terraform plans after Gates D and B had zero drift. All 151
  tests, typecheck, site and Lambda builds, Terraform validation, and diff checks
  passed. HTTP API `ugmazzudce` remains enabled for Gate C; no site deployment,
  Stripe/webhook registration, fulfillment upload/backfill, or live purchase
  occurred.
- 2026-08-08: The approved Gate C RAM-backed plan hash was rechecked and applied
  without regeneration. It changed only HTTP API `ugmazzudce` by setting
  `disable_execute_api_endpoint = true`: zero additions, one in-place change,
  and zero deletions. Five direct requests returned `404` with zero Buyer and
  Webhook invocation delta. Public CloudFront checkout and fulfillment probes
  continued to return their expected non-cacheable `400` responses through the
  protected REST API, and the order table remained empty. The final plan
  reported no changes. The RAM volume was ejected, the in-memory origin value
  was cleared, and no secret-bearing shell remains. Gates A-D are complete; no
  site deployment, fulfillment upload/backfill, webhook registration, Stripe
  request, or live purchase occurred.
- 2026-08-08: The production fulfillment backfill dry run completed against
  `adamficke-com-originals`: zero uploaded, zero reused, 71 would upload, and
  zero failed. It downloaded source objects only to its automatically removed
  temporary directory and made no S3 changes. The real immutable upload remains
  a separate approval boundary before the M6 storefront deployment.
- 2026-08-08: The approved production fulfillment backfill was interrupted in
  the UI while the user clarified why separate fulfillment objects are
  required, but its detached process continued to completion. All 71
  conditional, checksum-verified objects were created under `fulfillment/`,
  totaling 323,537,723 bytes. Existing `albums/` objects were not modified or
  deleted, and no storefront, catalog, webhook, Stripe, or order change
  occurred.
- 2026-08-08: Publishing and backfill tooling was narrowed from every retained
  catalog photo to only explicit `forSale: true` photos. The complete suite
  remained green at 151 tests and typecheck passed. The revised production dry
  run selected exactly six sellable objects, verified all six as reusable, and
  reported zero missing and zero failed. Those six total 77,776,354 bytes; the
  other 65 completed copies total 245,761,369 redundant bytes and remain pending
  an explicit cleanup decision.
- 2026-08-08: After explicit approval, the exact 65 nonsellable fulfillment
  object versions were permanently deleted with zero errors. Final inventory is
  six current versions totaling 77,776,354 bytes and zero delete markers. A
  production dry run checksum-verified all six as reusable with zero missing and
  zero failed. Existing album originals were not modified or deleted.
- 2026-08-08: M6's local release build passed. Generated store HTML contains six
  native POST checkout forms and no checkout links; the purchase page is
  present; and the compatible additive-v2 private catalog contains six sellable
  entries with six valid immutable asset references and no malformed sellable
  entry. Photo media cleanup reported nothing obsolete. The production site
  synchronization was previewed only; no site object or CloudFront invalidation
  changed. Normal deployment remains restricted to a main-branch CodeBuild
  release after the branch is committed, reviewed, and merged.
