# Stripe commerce architecture migration

Status: planned, pre-launch architecture. This document describes the target
design, not the commerce implementation currently deployed.

## Revision 7 — 2026-08-08

The first approved Gate A apply created the additive REST and Authorizer
resources but stopped when API Gateway rejected the account
`cloudWatchRoleArn`. The dedicated role trusted `apigateway.amazonaws.com`, but
its policy omitted `logs:CreateLogGroup` and restricted stream/event access to
the precreated commerce group. API Gateway validates this regional account role
against the complete `AmazonAPIGatewayPushToCloudWatchLogs` action set with
`Resource: "*"`, even when Terraform precreates the destination log group.

The corrected inline policy matches that required action/resource set. The
broader Logs permissions remain isolated on a dedicated role assumable only by
API Gateway. The partial resources are not routed by CloudFront and the REST
stage was not completed, so the deployed HTTP API remains the only active
commerce origin. Revision 7 supersedes revision 6's narrower logging-role
policy; the Gate A-C/D ordering is unchanged.

## Revision 6 — 2026-08-08

AWS's reduced new-account Lambda quota allows the deployed functions to share
ten unreserved executions but permits no function-level reservation. AWS also
rejected the original 110 request because its self-service workflow requires a
value at least as large as the published 1000 default; request
`c2417d3b4a624900a758f086935b5722QepcbJ1M` now targets 1001.

The quota review does not need to block the protected infrastructure or POST
storefront rollout. Gate A adds the Regional REST API, exact token validation,
Authorizer, logging, compatible bundles, alarm consolidation, and missing SNS
subscription with concurrency left unreserved. Gate B points CloudFront at the
verified REST stage. After CloudFront reports `Deployed`, Gate C disables the
old HTTP API endpoint. M6 can then deploy the POST storefront and remove legacy
GET after propagation. Missing or incorrect direct-origin tokens are rejected
before any Lambda invocation throughout the REST rollout.

The account-wide quota of 10 remains a hard shared ceiling during Gates A-C and
M6, but Buyer, Webhook, and Authorizer are not isolated from one another. After
AWS applies quota 1001, a separate Gate D enables the 5/3/2 reservations and
verifies isolation. If AWS grants the request earlier, Gate D should run at the
next exact-plan boundary. Terraform defaults the reservation, REST-cutover, and
HTTP-dormancy flags false; HTTP dormancy still requires the REST cutover, but
reserved concurrency does not block infrastructure or storefront progress.
Revision 6 supersedes revision 5's requirement that reservations precede the
REST cutover.

## Revision 5 — 2026-08-08

An end-to-end pre-apply review found that revision 4 protected only the new
REST endpoint. After its CloudFront cutover, the retained HTTP API would still
have an enabled public `execute-api` endpoint wired directly to Buyer and
Webhook. Direct traffic could therefore bypass the REST token gate and exhaust
either function's reservation. Calling that API an unrouted rollback rail did
not make it dormant.

The corrected rollout has three apply gates. Gate A adds and verifies the REST
path while the HTTP API remains active for CloudFront. Gate B points CloudFront
at REST and waits for the distribution to report `Deployed`. Gate C then
disables the old HTTP API's default endpoint while retaining its API, routes,
integrations, and permissions in Terraform. Rollback reverses that order:
re-enable and verify the HTTP API first, then repoint CloudFront. This avoids a
propagation window in which neither origin works.

The ten reserved units are rebalanced to Buyer 5, Webhook 3, and Authorizer 2.
Buyer still matches its configured burst while the cached authorizer no longer
has a single-invocation ceiling during a cold-cache race. The REST deployment
fingerprint now covers methods, integrations, the authorizer identity settings,
gateway responses, and binary media types so later source changes cannot remain
undeployed.

Authenticated prework confirmed that the regional API Gateway account has no
`cloudWatchRoleArn`. Gate A therefore adds a dedicated account logging role.
It also confirmed that the
Lambda concurrency quota remains 10 with no pending request, the HTTP API
default endpoint is enabled, and the commerce alarm topic has no subscriber.
The quota increase and alarm confirmation remain explicit prerequisites.

Revision 5 supersedes revision 4's two-gate rollout, active HTTP rollback rail,
and 6/3/1 allocation. Its REST token-gate design remains unchanged.

## Revision 4 — 2026-08-02

Production verification disproved revision 3's ingress safety assumption. A
30-request burst sent directly to the public HTTP API without the CloudFront
origin header produced both handler `403` responses and integration `503`
responses; Buyer Lambda metrics recorded invocations and throttles. The route
throttle was configured as designed. AWS documents API Gateway throttles as
best-effort targets, not guaranteed ceilings, so they cannot be the hard
pre-invocation boundary revision 3 assigned to them.

The corrected design uses an additive Regional REST API with a cached `TOKEN`
Lambda authorizer. CloudFront overwrites a dedicated gateway-token header with
a 64-character value derived from the existing random origin value. API Gateway
first matches that token against an exact validation expression; a missing or
different value is rejected without invoking the authorizer or either commerce
Lambda. The authorizer repeats the comparison before returning its cached allow
policy. Buyer and Webhook continue checking the original header as defense in
depth.

The account's Lambda concurrency quota must increase from 10 to 110 before this
can be applied. AWS retains 100 units for unreserved functions, leaving ten for
reserved concurrency: Buyer 6, Webhook 3, and Authorizer 1. This bounds Buyer
traffic and preserves Webhook capacity even when a valid public storefront
request burst exceeds the gateway's best-effort throttle.

Rollout has two Terraform apply gates. The first adds and verifies the REST API,
authorizer, reserved concurrency, logs, and alarms while CloudFront continues
using the deployed HTTP API. The second changes only the CloudFront commerce
origin after direct missing-, wrong-, and valid-token probes pass. The HTTP API
and legacy Function URL remain managed rollback rails through M7. No storefront
JavaScript or browser challenge is required for this origin control.

## Revision 3 — 2026-08-02

Revision 2 removed too much in one place and reversed a settled decision in
another. This revision fixes both, and closes the two open questions.

### Corrections

- **Function URLs are not private, and revision 2 said they were.** A Function
  URL with `authorization_type = NONE` is a public Lambda invocation endpoint;
  the origin-verification header is checked inside the handler, after invocation
  and concurrency have already been spent. At an account concurrency quota of
  10, direct traffic could starve checkout, download, and webhook processing.
  Ingress is now a throttled HTTP API, which rejects before Lambda is invoked.
  See [Ingress](#ingress).
- **Reserved concurrency is not allocatable at this quota.** AWS always reserves
  100 units for functions without a reservation, *"regardless of your total
  account concurrency limit"* — so with a quota of 10 there is no reservable
  pool. `infra/commerce.tf` already recorded this. The control is now route
  throttling at the gateway, and reserved concurrency is dropped.
- **Revision 2 silently reversed the issued-link policy.** It added a DynamoDB
  read and revocation check to every download, contradicting revision 1's
  deliberate choice to let issued seven-day tokens expire naturally — and its
  changelog did not say so. Reverted: redemption is stateless again. The
  protection was close to worthless (the buyer already has the file) and it cost
  a DynamoDB dependency on the most availability-critical path plus fail-open
  semantics that were too broad. Revision 2 also overstated DynamoDB read
  latency as sub-millisecond; single-digit milliseconds is correct.
- **Integrity checks were cut too aggressively.** Revision 2 argued the dropped
  checks "defend against nothing reachable." That is true of an attacker holding
  the API key, but the checks also catch configuration and coding regressions.
  Those needing no extra API call are restored. See
  [The entitlement operation](#the-entitlement-operation).
- **Reconciliation was under-specified.** A paid-but-not-entitled sweep cannot
  replace queue recovery. It must also close expired and failed pending orders,
  detect externally imposed refunds and disputes, and find orders whose Session
  was created but whose Session ID write failed.

### Changes

- **Ingress is one HTTP API on its ordinary `execute-api` hostname.** No custom
  domain, ACM certificate, or DNS record — those were the waste in revision 1,
  not the gateway itself. Route throttles are enforced before Lambda invocation,
  which is the property Function URLs cannot provide.
- **Reconciliation is an on-demand operator command, not a cron.** There are no
  orders yet and none anticipated for a while, so nothing runs while idle.
  Alarms are the trigger; `commerce:reconcile` is the durable recovery. No
  EventBridge resources, no scheduled-failure alarm.
- **No voluntary refunds.** The business does not offer them. Stripe and Link can
  still impose refunds — including *"without your approval"* if a support
  escalation goes unanswered for 48 hours, and within 60 days in certain cases —
  so `charge.refunded` and dispute handling remain. They cover external facts,
  not a feature this store offers.
- **The paid custom metric is gone.** API Gateway records the response status, so
  a handler that catches an exception and returns 500 appears in the free
  stage-level `5xx` metric. The log metric filter revision 2 added is redundant.

### Resolved from revision 2's open questions

- `session.payment_intent` is defined as the PaymentIntent for `payment`-mode
  Sessions. A coexisting Invoice is not evidence of its absence. PaymentIntent
  is the canonical path to the Charge; the sandbox assertion stays, but this is
  no longer an unresolved architectural branch.
- *"Custom domains aren't supported on Managed Payments checkouts"*, so
  `checkout.stripe.com` is the documented host for the CSP allowlist. The
  browser test stays, to catch any Link redirect hop.

### Revision 2 — superseded in part

Revision 2 corrected four defects in the first draft — `form-action` blocking
the Stripe redirect in Chrome and Safari, the webhook being unable to supply the
origin header, an eventually-consistent index on the browser-return read path,
and a TTL that could delete a settling order — and removed SQS, the DLQ, the
worker Lambda, the temporary sandbox stack, the token key ring, and both
secondary indexes. All of that stands. Its ingress design and its
revocation-at-redemption change do not, per the corrections above.

Revision 3's HTTP API ingress and no-reserved-concurrency conclusions are
superseded by revision 4. Its remaining corrections and domain design stand.

## Summary

There are no real customer orders to migrate. The store can make a clean cutover
without an entitlement backfill, legacy-token support, or a dual-run period.

```text
Browser -> CloudFront -> REST API token gate -> Buyer Lambda
Stripe  -> CloudFront -> REST API token gate -> Webhook Lambda -> DynamoDB
Download token -> Buyer Lambda -> immutable private S3 asset
```

The important design decisions are:

- Stripe events enter through a signed webhook and are processed synchronously
  by an idempotent handler that returns `2xx` only after DynamoDB commits.
  Stripe's retry schedule is the delivery guarantee.
- DynamoDB records each order and its immutable fulfillment asset.
- The browser return and the webhook call the same entitlement operation.
- Every DynamoDB read on a request path is a strongly consistent read by
  partition key. There are no secondary indexes.
- Download tokens are self-contained and stateless. Redemption reads nothing.
- The store does not offer refunds. Externally imposed refunds and disputes
  revoke the order and block future links; already-issued seven-day tokens
  expire naturally.
- A buyer who loses a link recovers through the existing receipt-reply and
  operator-reissue process. Customer accounts and custom delivery email remain
  out of scope.

Stripe recommends combining webhook fulfillment with browser-return fulfillment
because the browser is not guaranteed to reach the success page:
[Stripe Checkout fulfillment guidance](https://docs.stripe.com/checkout/fulfillment).

## What the current design gets right

Stripe-hosted Checkout, a private server-authoritative catalog, short-lived
presigned S3 URLs, opaque photo IDs, and a static success page all carry forward
unchanged. The migration corrects the following.

### Durable fulfillment

Today nothing is written down. Fulfillment re-derives everything from the paid
Session plus the live catalog, so `resolveDownload` throws if the photo has
since been delisted or purged — stranding someone who already paid, which is the
opposite of the intent stated in `lambda/fulfill.ts`. The target records a
content-addressed fulfillment asset at checkout time so that a later reprice,
rename, delisting, or catalog purge cannot affect a paid order.

### Native POST

Purchase is a `GET` link today. Crawlers, prefetchers, and link scanners can
therefore create Checkout Sessions, and once orders are durable they would
create database rows too. `rel="nofollow"` is not a control. A POST form fixes
this and is the reason the ingress changes at all.

### Observability

Lambda handlers that catch exceptions and return HTTP 500 do not increment the
Lambda `Errors` metric, so the single existing alarm is nearly blind to the
failure mode most likely to occur.

### Privacy

The Session ID and download token are bearer capabilities. They must not appear
in referrers, query-string logs, application logs, or alarm payloads.

## Ingress

One Regional API Gateway **REST API** behind the existing CloudFront
distribution, with five explicit methods and no proxy, `ANY`, or default route.
The ordinary `{api-id}.execute-api.{region}.amazonaws.com/{stage}` URL remains
the origin; there is no custom domain, certificate, or DNS record for the API.

Every method requires a cached `TOKEN` Lambda authorizer whose identity source
is `X-Commerce-Gateway-Token`. Terraform derives its value as SHA-256 of the
existing random origin-verification value, so it is fixed-width and no second
secret must be generated or rotated. CloudFront overwrites the viewer's header
with that value. API Gateway's exact validation expression rejects a missing or
different token before invoking the authorizer. On a match, the authorizer
timing-safely compares the token again and returns an allow policy covering only
the stage's `/api/*` methods, cached for one hour.

The original independently named origin-verification header is still injected
and checked inside Buyer and Webhook. It is defense in depth and a configuration
drift detector; it is not relied upon to preserve concurrency. Neither token is
put in HTML, JavaScript, request logs, or application logs.

**Lambda Function URLs are not the active ingress.** A Function URL with
`authorization_type = NONE` spends invocation capacity before an application
header check. Lambda origin access control avoids that, but signed POSTs impose
`x-amz-content-sha256` requirements a native HTML form cannot meet:
[AWS Lambda URL origin guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html).
The REST token gate preserves the native form body while rejecting direct
bypass before integration.

Route throttles remain useful best-effort traffic shaping, not security or
capacity ceilings:

| Route | Rate | Burst |
| --- | --- | --- |
| `POST /api/checkout` | 2 | 5 |
| `GET /api/checkout` | 2 | 5, temporary through the M6 cutover |
| `POST /api/stripe-webhook` | 10 | 20 |
| `GET /api/fulfill` | 5 | 10 |
| `GET /api/download` | 10 | 20 |

Unsupported methods are rejected by the gateway; handlers reject them too.
REST proxy payload v1 and the deployed HTTP API/Function URL payload v2 are both
accepted while rollback rails remain. JSON and form bodies are base64-preserved
by the REST API so Stripe signatures and native form bytes are not re-encoded.

**Reserved concurrency requires a prior quota increase.** AWS retains at least
100 units for functions without reservations. At the current regional quota of
10 there is no reservable pool. AWS's self-service quota workflow rejected the
smaller 110 target because it is below the published default, so the approved
target is 1001: allocate Buyer 5, Webhook 3, and Authorizer 2, leaving 991 units
unreserved. Reserved concurrency is both an exclusive minimum and a maximum. A
valid Buyer burst can therefore throttle Buyer but cannot consume Webhook,
Authorizer, rollback, or unrelated-function capacity.

The deployed HTTP API remains intact after the REST cutover, but its default
endpoint becomes dormant only after CloudFront finishes propagating. It is a
recoverable configuration rail, not a second accepted production ingress.
The legacy IAM-protected Function URL and runtime also remain through M7.

CloudFront configuration:

- Caching disabled for `api/*`, all seven viewer HTTP methods allowed so POST
  can pass, query strings and viewer headers forwarded, bodies unchanged.
- The REST stage name is set as the commerce origin path. CloudFront injects
  both the gateway token and original handler-verification header.
- A separate behavior for `/purchase/*` carrying a response-headers policy with
  `Referrer-Policy: no-referrer`. The existing policy is attached
  distribution-wide and cannot be varied per page without this.
- CSP changes from `form-action 'none'` to
  `form-action 'self' https://checkout.stripe.com`.
- The referrer field is removed from CloudFront access logs.

### The `form-action` constraint

`form-action` is evaluated against the redirect target of a form submission in
Chrome and Safari, and against every hop in the chain. A bare `'self'` blocks
the redirect to Stripe. Firefox permits it, so this fails inconsistently.

Managed Payments does not support custom Checkout domains, so the host is
`checkout.stripe.com`. Confirm the full chain in a browser anyway — Managed
Payments checkout is Link-branded and may introduce a hop. If a hop appears and
proves unstable, the fallback is for `POST /api/checkout` to return `200` HTML
containing `<meta http-equiv="refresh" content="0;url=…">` and a visible
fallback link: `form-action` does not govern a meta-refresh navigation, so no
Stripe host appears in the CSP and the flow still works without JavaScript.

## Public interfaces

| Method | Route | Behavior |
| --- | --- | --- |
| `POST` | `/api/checkout` | Validate one catalog item, create an order and Checkout Session, then return `303`. |
| `GET` | `/api/checkout` | Return `405` with `Allow: POST`; never call Stripe. |
| `POST` | `/api/stripe-webhook` | Verify the Stripe signature and apply the entitlement operation. |
| `GET` | `/api/fulfill?session_id=…` | Fulfill or retrieve the durable order associated with the Checkout return. |
| `GET` | `/api/download?t=…` | Verify the signed entitlement and return `302` to a presigned S3 URL. |

No CORS: browser traffic is same-origin through CloudFront. All responses are
non-cacheable.

### Checkout request

`POST /api/checkout` accepts `application/x-www-form-urlencoded` with a maximum
body of 1 KB and exactly one `photo_id`. It rejects missing, duplicate, unknown,
malformed, or extra fields before loading Stripe. Price, currency, product, sale
state, and fulfillment asset come from the private catalog.

The handler:

1. Generates a local order ID.
2. Creates a conditional DynamoDB `pending` order holding the catalog snapshot.
3. Creates a Checkout Session using the order ID as the idempotency key and as
   `client_reference_id`.
4. Copies the order ID, photo ID, and integration marker into Session and
   PaymentIntent metadata.
5. Stores the returned Session ID and expiry on the order.
6. Returns `303` to the Stripe-hosted URL.

The order is durable before the Session exists, so there can never be a Session
without an order. Step 5 can still fail after Stripe has created the Session,
leaving a `pending` order with no Session ID; reconciliation repairs that by
matching the order ID in Session metadata.

A new intentional submission creates a new order and Session. The idempotency
key protects uncertain retries of one Stripe request rather than merging a
visitor's separate attempts.

### Fulfillment response

`GET /api/fulfill` retrieves the Session from Stripe, reads the order ID from
`client_reference_id`, and reads the order by partition key. It returns:

- `200` with the download URL, token expiry, and stored display snapshot.
- `202` with `Retry-After` while a valid delayed payment is still pending.
- `404` for a Session Stripe does not recognize.
- `410` when the Checkout-return window has passed, or when the order is
  `closed` or `revoked`. The message points at receipt-reply recovery and does
  not distinguish the cases.
- A non-cacheable `5XX` for transient dependencies.

The purchase page polls a `202` for at most 30 seconds, then shows a durable
pending message. In practice this rarely fires: Stripe waits up to 10 seconds
for the `checkout.session.completed` acknowledgement before redirecting, so the
order is usually already entitled when the browser lands.

## Order and asset model

An on-demand DynamoDB table with point-in-time recovery. Partition key is the
local order ID. **No global secondary indexes** — every request-path read is a
strongly consistent `GetItem`. Reconciliation scans, which is free at this
table's size.

```text
orderId                  partition key
state                    pending | entitled | closed | revoked
closeReason              expired | failed, when state is closed
livemode
photoId
assetRef                 sanitized-file hash plus format
stripeSessionId
stripePaymentIntentId
stripeChargeId
expectedAmount           integration-currency subtotal, snapshotted at creation
amountTotal              audit only; includes Managed Payments tax
presentmentAmount        audit only
presentmentCurrency      audit only
checkoutExpiresAt
createdAt
entitledAt
updatedAt
revokedAt
revocationReason
sourceEventId
albumTitle               display snapshot
label                    display snapshot
previewSrc               display snapshot, optional
```

Do not store customer email, address, payment-method data, full Stripe events,
download tokens, or presigned URLs.

TTL applies only to `closed` orders, at 30 days. `pending` orders are never
TTL'd — a delayed payment can take two weeks to settle. They are self-limiting
instead: `checkout.session.expired` fires 24 hours after creation and moves an
abandoned order to `closed`.

### State machine

```text
pending  -> entitled
pending  -> closed     (expired | failed)
pending  -> revoked
entitled -> revoked
```

`revoked` is terminal for automated processing. Restoration after a won dispute
requires a trusted operator command recording who restored it, when, and why.
Conditional writes make duplicate and concurrent transitions idempotent; a
duplicate observing the intended final state is a success.

### Immutable fulfillment assets

The publishing workflow hashes the sanitized fulfillment bytes and uploads them
to a content-addressed key:

```text
fulfillment/<sha256>.<extension>
```

Catalog version 3 carries the resulting `assetRef`; checkout snapshots it into
the order. Upload tooling must refuse to overwrite an existing hash-derived key
with different bytes, which catches a key derived from the wrong hash.

Note that `catalog.ts` and `src/lib/downloads.ts` both hard-pin version 2 — two
places to change.

The buyer Lambda's `s3:GetObject` grant narrows from `albums/*` to
`fulfillment/*`.

### Download tokens

```text
version
orderId
photoId
assetRef
expiresAt
```

HMAC-SHA-256 over the encoded payload, verified before parsing, with a single
key. The format is versioned so a key ring can be introduced later; there is no
rotation procedure today, and rotating voids live links by design. Recovery from
a rotation is the existing `commerce:link` reissue.

**Redemption reads nothing.** The S3 key comes from `assetRef` and the filename
from `photoId`, so no catalog lookup and no DynamoDB read are involved. A token
is a seven-day bearer capability that expires on its own.

This is deliberate, and it was briefly reversed in revision 2. A revocation
check at redemption protects almost nothing — the buyer downloaded the file when
they bought it, so re-downloading the same bytes gains them nothing — while
putting a database dependency on the path where availability matters most.
Refunds and disputes therefore block *future* links rather than voiding issued
ones. See [Refunds and disputes](#refunds-and-disputes).

## Stripe event handling

The webhook Lambda:

1. Accepts only `POST` carrying the origin-verification header, Stripe's JSON
   content type, and a bounded body.
2. Reconstructs the exact body bytes, including a base64-encoded body.
3. Verifies `Stripe-Signature` against the current or overlapping previous
   webhook secret before parsing or acting.
4. Confirms live/test mode. The endpoint signing secret establishes the source
   account.
5. Accepts only the configured event types.
6. Applies the entitlement operation and returns `2xx` **only after the DynamoDB
   transition has committed**.

Invalid signatures write nothing and change no order. A transient failure
returns `5XX` so Stripe retries; Stripe's schedule runs about three days, and
`commerce:reconcile` covers anything that outlives it.

Configure Stripe to send only:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

### The entitlement operation

Both the webhook and the browser return call `ensureEntitlement(sessionId)`.
Each retrieves current Stripe state rather than trusting event ordering, so
webhook-first, return-first, duplicate, and concurrent execution all converge on
one legal order state.

It validates, all from the retrieved Session with no additional API call:

- `session.id` matches `order.stripeSessionId`.
- `session.mode === 'payment'`.
- The integration marker, order ID, and photo ID in metadata match the order.
- Live/test mode matches.
- `payment_status === 'paid'`. This is the check that keeps an unfunded bank
  debit from delivering the file.
- `currency` and `amount_subtotal` match the price snapshotted on the order.

It does not expand line items to revalidate the Stripe Product or quantity. That
is a server-created, single-item checkout and the amount is independently
checked, so the expansion buys nothing. The checks above are kept even though a
stolen API key would defeat them: they also catch configuration drift and coding
regressions, which is the likelier failure.

Charge-derived events resolve their order by retrieving the Charge with
`payment_intent` expanded and reading `order_id` from PaymentIntent metadata. No
index is required.

Integrity mismatches must never be treated as successful fulfillment.

### Adaptive Pricing

Adaptive Pricing is always on with Managed Payments. For Sessions created after
2025-03-31, `currency` and `amount_subtotal` remain in the integration currency
and the localized amount moves to `presentment_details`, so the amount check
above is correct and a non-USD `presentment_currency` is not a mismatch.

**This holds only because the catalog is USD-only with no `currency_options`.**
Several Managed Payments methods — Klarna, Pix, UPI, Cash App, Bancontact —
require local-currency presentment and would change `session.currency` if
multi-currency prices were ever introduced. `amount_total` is recorded for audit
but never compared, because Managed Payments tax can increase it.

## Refunds and disputes

**The store does not offer refunds.** There is no seller-initiated refund
command and no refund procedure for buyers. Digital downloads are delivered
immediately and the license terms are on the storefront before purchase.

That policy does not make refunds impossible, and the integration must not
assume it does. Under Managed Payments, Link owns transaction support: customers
request refunds through Link, Stripe *"can issue refunds within 60 days of the
original transaction in certain cases"*, and if a support escalation goes
unanswered for 48 hours Stripe *"might issue a refund without your approval."*
Disputes are handled by Stripe on your behalf without contacting you.

So `charge.refunded` and the dispute events remain subscribed. They report
external facts, not a feature this store offers. On any of them:

- Move the order to `revoked` with a reason.
- Block future browser-return fulfillment and `commerce:link` reissue.
- Leave any already-issued token to expire on its own schedule.

The operational requirement this creates is not a refund runbook but a
responsiveness one: keep the support email address in Dashboard business
settings current, and answer Link escalations inside 48 hours. Note that in some
jurisdictions Stripe retains the original sales tax on a refund, so a refunded
order costs slightly more than the sale price.

## AWS infrastructure and security

Three Lambdas with separate roles, behind the origin-authorized REST API:

- **Buyer API**: catalog read, Checkout Session create, order read/write, token
  key read, `s3:GetObject` signing limited to `fulfillment/*`.
- **Webhook**: webhook secret read, Stripe read credential, order read/write. It
  cannot mint tokens, read originals, or create Sessions.
- **Authorizer**: CloudWatch Logs write only. It cannot read SSM, DynamoDB, S3,
  Stripe credentials, or invoke either commerce function.

Restricted Stripe API keys, scoped explicitly:

- Buyer: Checkout Sessions write.
- Webhook: Checkout Sessions read, PaymentIntents read, Charges read, Disputes
  read, Events read.

Three SSM SecureString parameters so each function reads only what it needs:
`/<name>/commerce` (buyer key, Product ID, token key), `/<name>/commerce-webhook`
(signing secret, read key), and the existing `/<name>/commerce-test` for local
development. All are created holding `{}` with `ignore_changes`; real values are
written out of band and never pass through Terraform state.

Buyer and Webhook cache successful SSM reads for five minutes and never retain
failed loads. The Authorizer policy cache lasts one hour; the gateway token is
infrastructure configuration and is not rotated with Stripe credentials.

The origin-verification header value lives in encrypted Terraform state and is
generated out of band. Terraform derives the REST gateway token from it; both
values are sensitive bearer configuration and must be redacted from plans,
logs, commits, and evidence. The original value is recovered only into process
memory from encrypted state for later plans. Do not rotate it routinely. If a
rotation is necessary, first make the authorizer accept old and new values,
then update CloudFront, wait for propagation, and remove the old value last.

## Monitoring and recovery

Application logs use structured outcomes and redacted or hashed identifiers.
Never log request bodies, signatures, full Session IDs, tokens, query strings,
customer data, or presigned URLs. API Gateway access logs carry only request ID,
route, status, integration status, latency, and response size.

REST API access logging requires the regional API Gateway account
`cloudWatchRoleArn`. The authenticated revision-5 prework read confirmed this
singleton is unset, so Gate A adds a dedicated role and manages the account
setting. Its only account-wide permission is log-group discovery; stream and
event permissions are limited to the commerce REST access-log group. Recheck
the singleton immediately before planning and stop if another actor has filled
it rather than overwriting or importing that role implicitly.

Alarm through the existing SNS topic on:

- Each active API Gateway stage's `5xx`. This covers the blind spot noted above:
  a handler that catches an exception and returns 500 does not increment the
  Lambda `Errors` metric, but the gateway records the status either way.
- Lambda errors for Buyer, Webhook, and Authorizer, plus Webhook throttles. A
  Webhook capacity failure needs distinct operator attention because it delays
  entitlement and revocation.

Deliberately not alarmed: Buyer or Authorizer throttles, per-operation DynamoDB
failures, rejected-event counts, invalid-transition counts, and Checkout
creation bursts. Reserved-concurrency throttles are intentional backpressure,
and any resulting availability failure plus every DynamoDB failure that
exhausts SDK retries already reaches the API `5xx` alarm. At this volume the
duplicate alarms would cost more than the rest of the request path and tell you
less than the API alarm and reconciliation do. The deployed legacy Lambda keeps
its separate error alarm while it remains a rollback rail. This leaves seven
standard-resolution commerce alarms after Gate A.

### Recovery

Alarms trigger manual recovery. There is no scheduled reconciliation: there are
no orders yet and none expected for a while, so nothing should run while idle.
Revisit automation only once meaningful order volume exists.

`commerce:reconcile` is an on-demand operator command, in the same shape as the
existing `commerce:link`. It scans every non-`closed` order, retrieves current
Stripe state, and reuses the normal transition functions to repair:

- Paid orders still `pending`.
- Orders whose Session expired or whose async payment failed.
- Externally imposed Stripe or Link refunds.
- Opened disputes, and dispute closures that need operator review.
- Orders whose Checkout Session was created but whose Session ID write failed,
  matched by the order ID in Session metadata.

It reports every repair and exits non-zero if any fails. Run it after an alarm,
during the launch drill, or when investigating a specific order.

`commerce:link` retains the receipt-reply recovery path: it looks up the durable
order, retrieves current Stripe payment and Charge state, refuses unpaid,
refunded, disputed, or revoked orders, and mints a fresh seven-day token. No
public admin route, customer account, custom email delivery, or PII database is
introduced.

Documented procedures: webhook-secret rotation, Link escalation response,
dispute review, order restoration, reconciliation, and manual reissue.

## Pre-launch migration

1. Build catalog version 3 and upload a content-addressed fulfillment asset for
   every sellable photograph.
2. Run the full acceptance suite locally: `bun run commerce:dev`,
   `stripe listen --forward-to localhost:8787/api/stripe-webhook`, and a
   test-mode DynamoDB table. Simulate an externally imposed refund and a dispute
   here. Confirm the live Stripe checkout host for the CSP allowlist, and assert
   that `session.payment_intent` is populated for a Managed Payments
   `mode: payment` Session.
3. Apply the M5 correction in three infrastructure gates **without registering
   the webhook**. The account-wide Lambda concurrency limit remains the shared
   hard ceiling of 10 throughout these gates:
   1. Add the REST API, exact token-validation authorizer, logs, alarms, and
      v1-compatible Lambda bundles without function-level reservations while
      CloudFront remains on the HTTP API. Verify missing and wrong direct tokens
      produce no Lambda invocation; use the in-memory correct headers only with
      malformed safe probes to verify the authorized path without Stripe or
      DynamoDB.
   2. Review and approve a separate plan that changes the CloudFront commerce
      origin to the verified REST stage and adds its derived token header. After
      propagation, repeat safe probes and confirm the functions still share the
      ten-unit account ceiling.
   3. After CloudFront reports `Deployed`, review and approve a third plan that
      only disables the old HTTP API default endpoint. Verify its direct URL is
      rejected without Buyer or Webhook invocation. Keep the API configuration
      and the strictly validated legacy GET route for ordered rollback and the
      still-deployed GET storefront.
   Retain the dormant HTTP API configuration and the deployed legacy Lambda,
   Function URL, role, log group, alarm, origin access control, and invocation
   permissions as guarded rollback rails through the live drill.
4. Switch the store to the POST form and deploy the CSP, referrer, and
   purchase-page changes. After the deploy has propagated, disable legacy GET
   checkout and verify it returns `405` with no Stripe call.
5. When the separately approved regional Lambda concurrency request reaches
   1001, apply a reservation-only exact plan for Buyer 5, Webhook 3, and
   Authorizer 2. If AWS grants the request earlier, run this gate at the next
   exact-plan boundary so the enlarged account pool is not left unallocated.
6. In a separate gate, register and populate the production webhook, then
   verify a signed event reaches DynamoDB. Complete the live drill: one
   controlled purchase, download, and manual reissue — then refund that purchase
   from the Dashboard to verify the live external-reversal path, and confirm
   reissue is refused afterwards. A Dashboard refund produces the same
   `charge.refunded` event Link would, and it is the only way to exercise this
   end to end in live mode.
7. Remove the HTTP API, old stateless fulfillment path, the `albums/*` presign
   grant, the Lambda Function URL, and its origin access control only after the
   M7 cleanup gates pass.

Because there are no customer orders, there is no backfill, dual-write period,
legacy-token decoder, or extended rollback window.

## Acceptance criteria

- Generated store HTML uses an accessible native POST form and contains no
  purchase `href`.
- **The full redirect to Stripe completes under the production CSP in Chrome,
  Safari, and Firefox.** This is a browser check, not a header inspection.
- Missing or incorrect direct-origin tokens are rejected by API Gateway without
  invoking Authorizer, Buyer, or Webhook.
- A valid Buyer burst cannot consume Webhook's reserved concurrency. Route
  throttles shape traffic but are not treated as guaranteed ceilings.
- Invalid method, body, field, origin header, or attempted price never calls
  Stripe.
- The pending order is durable before Checkout Session creation, and uncertain
  Stripe retries reuse its idempotency key.
- Webhook signatures use exact raw bytes; invalid signatures and wrong modes
  change no order. A `2xx` is returned only after the DynamoDB write commits.
- Webhook-before-return, return-before-webhook, duplicate, concurrent, and
  out-of-order cases converge on one legal order state.
- Unpaid and async-failed Sessions never grant access; async success does.
- A Session retrieved immediately after creation resolves without a stale read.
- Session ID, Checkout mode, metadata, live/test mode, amount, and currency
  mismatches are all rejected.
- Repricing, delisting, renaming, or catalog removal after Checkout creation
  does not alter the purchased asset.
- An external refund or dispute revokes the order and blocks return and reissue,
  while an already-issued token keeps working until it expires.
- Redemption succeeds with DynamoDB unreachable.
- A `pending` order survives a simulated fourteen-day delayed settlement.
- `commerce:reconcile` repairs every case listed under
  [Recovery](#recovery), reports each repair, and exits non-zero on failure.
- Session IDs, tokens, download URLs, webhook bodies, and customer data do not
  appear in logs, DynamoDB, or alarm payloads.
- Unit tests, typecheck, Lambda bundles, Terraform validate and plan, the local
  suite, and the live drill pass before the old path is removed.

## Explicitly out of scope

- Existing customer or entitlement migration.
- Customer accounts or self-service purchase history.
- Voluntary or seller-initiated refunds.
- Custom email delivery or SES.
- Download-token key rotation without voiding live links.
- Revocation checks at token redemption.
- Scheduled reconciliation, WAF, Step Functions, SQS, or a permanent sandbox
  environment.
- Multiple products, quantities, carts, subscriptions, or license tiers beyond
  the current single-download offer.
