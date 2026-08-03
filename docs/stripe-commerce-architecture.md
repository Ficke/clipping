# Stripe commerce architecture migration

Status: planned, pre-launch architecture. This document describes the target
design, not the commerce implementation currently deployed.

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

## Summary

There are no real customer orders to migrate. The store can make a clean cutover
without an entitlement backfill, legacy-token support, or a dual-run period.

```text
Browser -> CloudFront -> HTTP API -> Buyer Lambda
Stripe  -> CloudFront -> HTTP API -> Webhook Lambda -> DynamoDB
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

One Regional API Gateway **HTTP API** behind the existing CloudFront
distribution, with explicit routes to the two Lambdas.

The API uses its ordinary `{api-id}.execute-api.{region}.amazonaws.com` hostname
as the CloudFront origin, with a `$default` auto-deploy stage so no origin path
is needed. There is no custom domain, ACM certificate, or Route 53 record — the
first draft added those, and they bought nothing.

**Lambda Function URLs are not used.** A Function URL with
`authorization_type = NONE` is publicly invocable by anyone holding the URL, and
a secret header checked inside the handler runs only after invocation and
concurrency are already consumed. Origin access control would close that, but
AWS requires POST clients behind a signed Lambda origin to send
`x-amz-content-sha256`, which a native HTML form cannot do:
[AWS Lambda URL origin guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html).
The HTTP API resolves both: no CloudFront request signing, so POST passes
unchanged, and throttling that rejects before Lambda is invoked.

Route throttles:

| Route | Rate | Burst |
| --- | --- | --- |
| `POST /api/checkout` | 2 | 5 |
| `POST /api/stripe-webhook` | 10 | 20 |
| `GET /api/fulfill` | 5 | 10 |
| `GET /api/download` | 10 | 20 |

There is no `$default` or `ANY` route. Unsupported methods are rejected by the
gateway; handlers reject them too, since neither should be the only guard.

**No reserved concurrency.** AWS always reserves 100 units for functions without
an explicit reservation regardless of the account limit, so at this account's
quota of 10 there is no reservable pool. `infra/commerce.tf` already recorded
this constraint. Route throttling is the control instead, and it is the better
one — it acts before invocation rather than after. Note also that the
account-level requests-per-second ceiling is ten times the concurrency quota.

CloudFront injects a random origin-verification header on every origin request,
and both handlers reject requests without it. The `execute-api` hostname remains
publicly resolvable, so this is bypass **detection**, not the primary control;
route throttles apply to direct traffic just as they do to CloudFront traffic.

CloudFront configuration:

- Caching disabled for `api/*`, all seven viewer HTTP methods allowed so POST
  can pass, query strings and viewer headers forwarded, bodies unchanged.
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

Two Lambdas with separate roles, behind the shared HTTP API:

- **Buyer API**: catalog read, Checkout Session create, order read/write, token
  key read, `s3:GetObject` signing limited to `fulfillment/*`.
- **Webhook**: webhook secret read, Stripe read credential, order read/write. It
  cannot mint tokens, read originals, or create Sessions.

Restricted Stripe API keys, scoped explicitly:

- Buyer: Checkout Sessions write.
- Webhook: Checkout Sessions read, PaymentIntents read, Charges read, Disputes
  read, Events read.

Three SSM SecureString parameters so each function reads only what it needs:
`/<name>/commerce` (buyer key, Product ID, token key), `/<name>/commerce-webhook`
(signing secret, read key), and the existing `/<name>/commerce-test` for local
development. All are created holding `{}` with `ignore_changes`; real values are
written out of band and never pass through Terraform state.

Secret caching must be bounded by TTL or tied to a deployment revision. The
current implementation caches for the life of the execution environment, so a
rotated secret can persist indefinitely in a warm container.

The origin-verification header value lives in Terraform state. That is
acceptable — it is bypass detection, not authentication — but it should be
generated out of band alongside the other secrets.

## Monitoring and recovery

Application logs use structured outcomes and redacted or hashed identifiers.
Never log request bodies, signatures, full Session IDs, tokens, query strings,
customer data, or presigned URLs. API Gateway access logs carry only request ID,
route, status, integration status, latency, and response size.

Alarm through the existing SNS topic on:

- API Gateway stage `5xx`. This covers the blind spot noted above at no cost: a
  handler that catches an exception and returns 500 does not increment the
  Lambda `Errors` metric, but the gateway records the status either way.
- Lambda errors and throttles, for both functions.
- DynamoDB throttles and system errors.

Deliberately not alarmed: rejected-event counts, invalid-transition counts, and
Checkout creation bursts. At this volume they would cost more than the rest of
the stack and tell you less than reconciliation does.

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
3. Deploy the production table, HTTP API with route throttles, both Lambdas,
   IAM, CloudFront behaviors, logs, and alarms **without exposing the checkout
   form**. Keep the strictly validated legacy GET checkout compatibility switch
   enabled while the deployed storefront still uses GET links. Verify ingress
   by hand: throttles reject, the origin header is required, and a registered
   live webhook delivers a signed event that reaches DynamoDB. Retain the
   deployed legacy Lambda, Function URL, role, log group, alarm, origin access
   control, and invocation permissions as an unattached rollback rail through
   the live drill; guard them from accidental Terraform destruction.
4. Switch the store to the POST form and deploy the CSP, referrer, and
   purchase-page changes. After the deploy has propagated, disable legacy GET
   checkout and verify it returns `405` with no Stripe call. Complete the live
   drill: one controlled purchase, download, and manual reissue — then refund
   that purchase from the Dashboard to verify the live external-reversal path,
   and confirm reissue is refused afterwards. A Dashboard refund produces the
   same `charge.refunded` event Link would, and it is the only way to exercise
   this end to end in live mode.
5. Remove the old stateless fulfillment path, the `albums/*` presign grant, the
   Lambda Function URL, and its origin access control.

Because there are no customer orders, there is no backfill, dual-write period,
legacy-token decoder, or extended rollback window.

## Acceptance criteria

- Generated store HTML uses an accessible native POST form and contains no
  purchase `href`.
- **The full redirect to Stripe completes under the production CSP in Chrome,
  Safari, and Firefox.** This is a browser check, not a header inspection.
- Route throttles reject excess requests at the gateway, without invoking
  Lambda.
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
