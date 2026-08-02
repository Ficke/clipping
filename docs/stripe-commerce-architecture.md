# Stripe commerce architecture migration

Status: planned, pre-launch architecture. This document describes the target
design, not the commerce implementation currently deployed.

## Revision 2 — 2026-08-02

This revision corrects four defects in the first draft and removes roughly two
thirds of its infrastructure. The reliability goal is unchanged and is carried
entirely by three things: a durable order record, webhook-driven fulfillment,
and an immutable fulfillment asset. Everything removed below was scaffolding
around those three.

### Corrections

- **`form-action 'self'` would have broken checkout in Chrome and Safari.**
  Chrome applies `form-action` to the redirect target of a form submission, so a
  form POSTing to `/api/checkout` that answers `303` to a Stripe host is blocked
  at submission. Verified against Chrome 150: `form-action 'self'` blocks and
  misreports the violation against the same-origin action URL;
  `form-action 'self' https://<host>` completes. Firefox does not block, which
  is why this would have looked intermittent. The Stripe host is now allowlisted
  explicitly and checked in a browser before launch.
- **The webhook could not have supplied the origin-verification header.** The
  first draft required that header on every route while showing Stripe posting
  straight to the origin. Stripe now posts through CloudFront, which injects the
  header like any other viewer request.
- **The Checkout Session index was on the browser-return read path.** Global
  secondary indexes are eventually consistent, so a buyer returning within a
  second of payment could have been told `404` for a real paid order. The return
  path now resolves the order from `client_reference_id` and reads by partition
  key. Both indexes are gone as a result.
- **A cleanup TTL on `pending` could have deleted a settling order.** Delayed
  payment methods take two to fourteen days. TTL now applies only after an order
  reaches `closed`.

Managed Payments is also no longer a public-preview dependency — it reached
general availability on 2026-04-22 — so the version pinning below is ordinary
hygiene rather than risk management.

### Simplifications

- **No API Gateway.** The first draft introduced it because CloudFront origin
  access control signing requires POST clients to send `x-amz-content-sha256`,
  which a native form cannot. Turning OAC signing off removes that requirement
  entirely, and the secret origin header the draft already specified provides
  the same protection an API Gateway custom domain would have. Removes the HTTP
  API, stage, routes, integrations, custom domain, ACM certificate, and DNS
  record. Costs per-route throttling; see [Ingress](#ingress).
- **No SQS, DLQ, or worker Lambda.** Stripe retries failed deliveries with
  backoff for about three days, which is the durability the queue was for. One
  webhook handler verifies, retrieves, and writes in a few hundred
  milliseconds. The reconciliation command replaces DLQ redrive.
- **No temporary sandbox stack.** `bun run commerce:dev` already runs the real
  handler against test-mode keys and refuses to start against a live key. With
  `stripe listen` and one test-mode table, the whole functional suite runs
  locally. Ingress wiring is verified against the deployed-but-unexposed
  production stack instead of a parallel CloudFront surface.
- **No download-token key ring.** Tokens live seven days and a compromised key
  is a key whose links you want voided. The format stays versioned so a key ring
  can be added if a reason appears; the rotation runbook is gone.
- **Trimmed order record and validation.** Five constant-valued fields and three
  integrity checks that only defended against an attacker already holding the
  API key have been dropped.

Net: about ten new Terraform resources rather than about forty, two Lambdas
rather than three, five migration steps rather than nine, and one runbook rather
than four.

## Summary

There are no real customer orders to migrate. The store can make a clean cutover
without an entitlement backfill, legacy-token support, or a dual-run period.

```text
Browser -> CloudFront -> Buyer Lambda (Function URL)
Stripe  -> CloudFront -> Webhook Lambda (Function URL) -> DynamoDB
Download token -> Buyer Lambda -> immutable private S3 asset
```

The important design decisions are:

- Stripe events enter through a signed webhook and are processed by an
  idempotent handler. Stripe's own retry schedule is the delivery guarantee.
- DynamoDB records each order and its immutable fulfillment asset.
- The browser return and the webhook call the same entitlement operation.
- Every DynamoDB read on a request path is a strongly consistent read by
  partition key. There are no secondary indexes.
- A buyer who loses a link recovers through the existing receipt-reply and
  operator-reissue process. Custom delivery email and customer accounts remain
  out of scope.
- Refunds and disputes block new links and mark the order revoked. Redemption
  checks revocation but fails open, so a DynamoDB outage cannot strand a buyer.

Stripe recommends combining webhook fulfillment with browser-return fulfillment
because the browser is not guaranteed to reach the success page:
[Stripe Checkout fulfillment guidance](https://docs.stripe.com/checkout/fulfillment).

## What the current design gets right

Stripe-hosted Checkout, a private server-authoritative catalog, short-lived
presigned S3 URLs, opaque photo IDs, and a static success page all carry
forward unchanged. The migration corrects the following.

### Durable fulfillment

Today nothing is written down. Fulfillment re-derives everything from the paid
Session plus the live catalog, so `resolveDownload` throws if the photo has
since been delisted or purged — stranding someone who already paid, which is
the opposite of the intent stated in `lambda/fulfill.ts`. The target records a
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

Both Lambdas are exposed as Function URLs with `authorization_type = NONE`,
reachable only through CloudFront.

Origin access control signing is deliberately **not** used. AWS requires that
POST clients behind a signed Lambda origin compute and send
`x-amz-content-sha256`, which a native HTML form cannot do:
[AWS Lambda URL origin guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html).
With signing off, CloudFront proxies the body unchanged and POST works.

In its place, CloudFront injects a random origin-verification header on every
origin request, and both handlers reject requests without it. This restricts
origin bypass; it is not buyer authentication. It is the same control an API
Gateway custom domain would have needed, since that domain would also have been
publicly resolvable.

**Accepted tradeoff:** there is no per-route request throttling. `/api/checkout`
is the route where abuse costs money, so the buyer Lambda gets a reserved
concurrency limit. Account-wide concurrency is 10, which is already a hard
ceiling on throughput.

CloudFront configuration:

- Two origins, two cache behaviors. `api/stripe-webhook` must be ordered before
  `api/*`.
- Caching disabled, all seven viewer HTTP methods allowed so POST can pass,
  query strings and viewer headers forwarded, bodies unchanged.
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

The Stripe host must therefore be allowlisted, and it must be confirmed in a
browser rather than assumed — Managed Payments checkout is Link-branded and may
introduce a hop. If the host proves unstable, the fallback is for
`POST /api/checkout` to return `200` HTML containing
`<meta http-equiv="refresh" content="0;url=…">` and a visible fallback link:
`form-action` does not govern a meta-refresh navigation, so no Stripe host
appears in the CSP and the flow still works without JavaScript.

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
without an order. A new intentional submission creates a new order and Session;
the idempotency key protects uncertain retries of one Stripe request rather than
merging a visitor's separate attempts.

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

`photoId` stays in the token so the download filename needs no read. Redemption
derives the S3 key from `assetRef`, so it does not depend on the catalog.

Redemption additionally reads the order by partition key and refuses a `revoked`
order — **failing open on any DynamoDB error**, so an outage degrades to the
previous stateless behavior rather than stranding a buyer. This closes the
repeated-redownload window after a refund at the cost of one sub-millisecond
read.

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
6. Applies the entitlement operation and returns `2xx`.

Invalid signatures write nothing and change no order. A transient failure
returns `5XX` so Stripe retries; Stripe's schedule runs about three days, and
the reconciliation command covers anything that outlives it.

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

It validates:

- The integration marker and order ID, against the stored order.
- Live/test mode.
- `payment_status === 'paid'`. This is the check that keeps an unfunded bank
  debit from delivering the file.
- `currency` and `amount_subtotal` against the price snapshotted on the order.

It does not separately check the Stripe Product, line-item count, or quantity.
Those are properties of a Session this store created under an idempotency key,
using a key that — if stolen — would let an attacker create orders directly.
They defend against nothing reachable.

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

## AWS infrastructure and security

Two Lambdas with separate roles:

- **Buyer API**: catalog read, Checkout Session create, order read/write, token
  key read, `s3:GetObject` signing limited to `fulfillment/*`. Reserved
  concurrency set.
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
acceptable — it is defense in depth, not authentication — but it should be
generated out of band alongside the other secrets.

## Monitoring and recovery

Application logs use structured outcomes and redacted or hashed identifiers.
Never log request bodies, signatures, full Session IDs, tokens, query strings,
customer data, or presigned URLs.

Alarm through the existing SNS topic on:

- Lambda errors and throttles, for both functions.
- A log metric filter on the handlers' structured 5xx outcome. This is the one
  custom metric worth its $0.30/month: a caught exception returning 500 is
  invisible to the `Errors` metric, and it is the likeliest failure.
- DynamoDB throttles and system errors.
- A scheduled reconciliation failure.

Deliberately not alarmed: rejected-event counts, invalid-transition counts, and
Checkout creation bursts. At this volume they would cost more than the rest of
the stack and tell you less than reconciliation does.

Reconciliation runs on a schedule and compares recent Stripe events and Sessions
against DynamoDB, reporting and repairing paid-but-not-entitled orders. This is
the check that actually detects the failure that matters, and it replaces DLQ
redrive.

Retain the receipt-reply recovery policy. `commerce:link` looks up the durable
order, retrieves current Stripe payment and Charge state, refuses unpaid,
refunded, or disputed orders, and mints a fresh seven-day token. No public admin
route, customer account, custom email delivery, or PII database is introduced.

Document webhook-secret rotation, refund, dispute, restoration, reconciliation,
and manual reissue. That is the whole runbook set.

## Pre-launch migration

1. Build catalog version 3 and upload a content-addressed fulfillment asset for
   every sellable photograph.
2. Run the full acceptance suite locally: `bun run commerce:dev`,
   `stripe listen --forward-to localhost:8787/api/stripe-webhook`, and a
   test-mode DynamoDB table. Confirm the live Stripe checkout host here, for the
   CSP allowlist.
3. Deploy the production table, both Lambdas, IAM, CloudFront behaviors, logs,
   and alarms **without exposing the checkout form**. Verify ingress by hand:
   the origin header is required, `GET /api/checkout` is `405`, and a registered
   live webhook delivers a signed event that reaches DynamoDB.
4. Switch the store to the POST form and deploy the CSP, referrer, and
   purchase-page changes. Complete the live drill: one controlled purchase,
   download, manual reissue, refund, and post-refund reissue refusal.
5. Remove the old stateless fulfillment path, the `albums/*` presign grant, and
   the OAC-signed origin configuration.

Because there are no customer orders, there is no backfill, dual-write period,
legacy-token decoder, or extended rollback window.

## Acceptance criteria

- Generated store HTML uses an accessible native POST form and contains no
  purchase `href`.
- **The full redirect to Stripe completes under the production CSP in Chrome,
  Safari, and Firefox.** This is a browser check, not a header inspection.
- Invalid method, body, field, origin header, or attempted price never calls
  Stripe.
- The pending order is durable before Checkout Session creation, and uncertain
  Stripe retries reuse its idempotency key.
- Webhook signatures use exact raw bytes; invalid signatures and wrong modes
  change no order.
- Webhook-before-return, return-before-webhook, duplicate, concurrent, and
  out-of-order cases converge on one legal order state.
- Unpaid and async-failed Sessions never grant access; async success does.
- A Session retrieved immediately after creation resolves without a stale read.
- Wrong amount, currency, metadata, account, or mode is rejected.
- Repricing, delisting, renaming, or catalog removal after Checkout creation
  does not alter the purchased asset.
- Refunds and disputes revoke the order and block new links.
- Redemption refuses a revoked order, and still serves when DynamoDB is
  unreachable.
- A `pending` order survives a simulated fourteen-day delayed settlement.
- Direct Function URL access without the origin-verification header fails.
- Session IDs, tokens, download URLs, webhook bodies, and customer data do not
  appear in logs, DynamoDB, or alarm payloads.
- Unit tests, typecheck, Lambda bundles, Terraform validate and plan, the local
  suite, and the live drill pass before the old path is removed.

## Open questions

- Confirm `session.payment_intent` is populated for `mode: payment` with
  Managed Payments. An Invoice is created even for one-time payments, and
  `lambda/reissue.ts` already depends on `expand: ['payment_intent.latest_charge']`
  on a path that has never run live. If the charge turns out to be
  invoice-backed, resolve through `session.invoice` instead.
- Confirm the Managed Payments checkout host for the CSP allowlist, including
  any Link-branded redirect hop.

Both are answered in migration step 2, before anything is deployed.

## Explicitly out of scope

- Existing customer or entitlement migration.
- Customer accounts or self-service purchase history.
- Custom email delivery or SES.
- Download-token key rotation without voiding live links.
- Per-route request throttling, WAF, Step Functions, or a permanent sandbox
  environment.
- Multiple products, quantities, carts, subscriptions, or license tiers beyond
  the current single-download offer.
