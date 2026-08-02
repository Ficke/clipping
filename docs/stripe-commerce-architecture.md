# Stripe commerce architecture migration

Status: planned, pre-launch architecture. This document describes the target
design, not the commerce implementation currently deployed.

## Summary

There are no real customer orders to migrate. The store can therefore make a
clean cutover without an entitlement backfill, legacy-token support, or an
extended dual-run period.

The target architecture is:

```text
Browser -> CloudFront -> API Gateway -> Buyer Lambda
Stripe -> signed webhook -> Receiver Lambda -> SQS -> Worker Lambda -> DynamoDB
Download token -> Buyer Lambda -> immutable private S3 asset
```

The important design decisions are:

- Stripe events enter through a signed webhook, are durably accepted into SQS,
  and are processed by an idempotent worker.
- DynamoDB records each order and its immutable fulfillment asset.
- The browser return and webhook worker call the same entitlement operation.
- A buyer who loses a link recovers through the existing receipt-reply and
  operator-reissue process; custom delivery email and customer accounts remain
  out of scope.
- Refunds and disputes block new links, but an already issued seven-day token
  remains valid until it expires naturally.
- A temporary isolated Stripe sandbox stack validates the migration and is
  removed after the live drill.

Stripe recommends combining webhook fulfillment with browser-return
fulfillment because the browser is not guaranteed to reach the success page:
[Stripe Checkout fulfillment guidance](https://docs.stripe.com/checkout/fulfillment).

## Architecture assessment

The current design has a sound core: Stripe-hosted Checkout, a private
server-authoritative catalog, short-lived presigned S3 URLs, opaque photo IDs,
and a static success page. The migration corrects the following limitations.

### API ingress

The existing CloudFront-to-Lambda Function URL origin is protected by IAM OAC;
it is not an exposed anonymous origin. It is nevertheless unsuitable for a
native POST form because AWS requires POST clients using this origin type to
provide `x-amz-content-sha256`, which a native HTML form cannot set. API Gateway
is therefore introduced for POST compatibility, explicit routes, throttling,
access logs, and response metrics—not because the current OAC is an insecure
public endpoint. See [AWS Lambda URL origin
guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html).

### Durable fulfillment

A DynamoDB record containing only a Checkout Session ID and photo ID would
still depend on the mutable catalog and `albums/<storyId>/<file>` mapping. The
target records a content-addressed fulfillment asset at checkout time so that a
later reprice, rename, delisting, or catalog purge cannot strand a paid order.

### Event processing

The webhook must acknowledge quickly and must not couple Stripe delivery to a
Stripe API lookup plus a DynamoDB write. A thin receiver verifies the exact
request body, writes a minimal event envelope to SQS, and returns success only
after the queue accepts responsibility. The worker performs all business
validation and state transitions.

### Observability and privacy

Lambda handlers that catch exceptions and return HTTP 500 do not increment the
Lambda `Errors` metric. API Gateway `5XX`, queue age, DLQ depth, rejected event
metrics, DynamoDB failures, Lambda errors, and throttles must be alarmed
separately.

The purchase Session ID and download token are bearer capabilities. They must
not appear in referrers, query-string logs, structured application logs, or
alarm payloads. The purchase page uses `Referrer-Policy: no-referrer`, and
CloudFront access logging omits `cs(Referer)`.

### Managed Payments lifecycle

Managed Payments remains a public-preview dependency. Keep the Stripe SDK and
API/event version pinned, use the same version for API calls and the webhook
destination, and rehearse upgrades in sandbox before changing either. See
[Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments).

## Public interfaces

API Gateway exposes only these routes:

| Method | Route | Behavior |
| --- | --- | --- |
| `POST` | `/api/checkout` | Validate one catalog item, create an order and Checkout Session, then return `303`. |
| `GET` | `/api/checkout` | Return `405` with `Allow: POST`; never call Stripe. |
| `POST` | `/api/stripe-webhook` | Verify the Stripe signature and durably enqueue a normalized event. |
| `GET` | `/api/fulfill?session_id=...` | Fulfill or retrieve the durable order associated with the Checkout return. |
| `GET` | `/api/download?t=...` | Verify the signed entitlement and return `302` to a presigned S3 URL. |

There is no `$default` or `ANY` route and no CORS configuration. The browser
remains same-origin through CloudFront.

### Checkout request

`POST /api/checkout` accepts `application/x-www-form-urlencoded` with a maximum
body size of 1 KB and exactly one `photo_id`. It rejects missing, duplicate,
unknown, malformed, or extra purchase fields before loading Stripe. Price,
currency, product, sale state, and fulfillment asset are loaded from the
private catalog.

The handler:

1. Generates a local order ID.
2. Creates a conditional DynamoDB `pending` order with the immutable catalog
   snapshot.
3. Creates a Stripe Checkout Session using the order ID as the idempotency key,
   `client_reference_id`, and metadata.
4. Copies the order ID, photo ID, and stable integration marker into Session and
   PaymentIntent metadata.
5. Stores the returned Session ID and expiration on the order.
6. Returns `303` to the Stripe-hosted URL.

A new intentional form submission creates a new order and Session. The
idempotency key protects uncertain retries of the same Stripe request rather
than merging all attempts by one visitor.

### Fulfillment response

`GET /api/fulfill` returns:

- `200` with the download URL, token expiry, and stored display snapshot for an
  entitled order.
- `202` with `Retry-After` while a valid delayed payment remains pending.
- `404` for an unknown Stripe Session.
- `410` when the Checkout-return renewal window has passed.
- A non-cacheable `5XX` for transient dependencies.

The purchase page polls a `202` response for at most 30 seconds, then shows a
durable pending message and receipt-reply recovery instructions.

## Order and asset model

Use an on-demand DynamoDB table with point-in-time recovery. The partition key
is the local order ID. Global secondary indexes support lookup by Stripe
Checkout Session ID and PaymentIntent ID.

Each live order stores:

```text
orderId
state                    pending | entitled | failed | expired | revoked
livemode
photoId
assetRef                 immutable sanitized-file hash plus format
stripeSessionId
stripePaymentIntentId
stripeChargeId
stripeProductId
quantity                 always 1 in this version
expectedUnitAmount
integrationCurrency
amountSubtotal
amountTotal
checkoutExpiresAt
createdAt
entitledAt
updatedAt
revokedAt
revocationReason
sourceEventId
albumTitle               display snapshot
label                    display snapshot
previewSrc               optional display snapshot
```

Do not store customer email, address, payment-method data, full Stripe events,
download tokens, or presigned URLs.

Pending and sandbox records may have a cleanup TTL. Entitled and revoked live
orders never receive an automatic TTL.

### State machine

Legal automatic transitions are:

```text
pending -> entitled
pending -> failed
pending -> expired
pending -> revoked
entitled -> revoked
```

`revoked` is terminal for automated processing. Restoration after a won dispute
requires a trusted operator command that records who restored it, when, and
why. Conditional DynamoDB writes make duplicate or concurrent transitions
idempotent. A duplicate that observes the intended final state is treated as a
success.

### Immutable fulfillment assets

The publishing workflow hashes the sanitized fulfillment bytes and uploads
them to a content-addressed key under the originals bucket, for example:

```text
fulfillment/<sha256>.<extension>
```

Catalog version 3 includes the resulting `assetRef`. Checkout snapshots it into
the order. Upload tooling must refuse a conflicting overwrite of an existing
hash-derived key.

Download tokens contain a signed asset reference, so redemption does not rely
on the current catalog or a DynamoDB read. The API derives the private S3 key,
verifies the token, and produces a 15-minute presigned attachment URL.

### Token rotation

The token format is versioned and contains:

```text
version
kid
orderId
sessionId
photoId
assetRef
expiresAt
```

HMAC-SHA-256 signs the encoded payload. Secrets hold a current key and previous
key ring. Rotation adds a new current key and retains the former key for at
least the seven-day download window plus one day before removal.

## Stripe event pipeline

### Receiver responsibilities

The receiver Lambda:

1. Accepts only `POST` with Stripe's JSON content type and a bounded body.
2. Reconstructs the exact body bytes for API Gateway payload format 2.0,
   including base64 bodies.
3. Verifies `Stripe-Signature` against the current or overlapping previous
   webhook secret before parsing or acting.
4. Confirms live/test mode; the endpoint signing secret establishes the Stripe
   source account.
5. Accepts only the configured event types.
6. Enqueues a PII-free envelope containing the event ID, type, object IDs,
   creation time, API version, and mode.
7. Returns `204` only after `SendMessage` succeeds.

Invalid signatures write nothing. A queue failure returns `5XX` so Stripe
retries. The receiver role can read only its webhook secret and send to the
payment-events queue; it cannot call Stripe, read originals, mint tokens, or
modify orders.

Configure Stripe to send only:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

### Queue and worker

Use an encrypted standard SQS queue with:

- 14-day message retention.
- Worker batch size one.
- Visibility timeout at least six times the worker timeout.
- Five receives before redrive.
- A separate encrypted DLQ with 14-day retention.

The worker retrieves the latest Stripe Checkout Session with line items and
PaymentIntent/latest Charge expanded. It validates:

- Local order ID and integration marker.
- Live/test mode.
- Checkout mode and paid status.
- Exactly one line item with quantity one.
- Expected Stripe Product.
- Expected unit amount, integration currency, and subtotal.
- Current refund and dispute state.
- Matching photo and order metadata.

`amount_total` is recorded for audit but is not compared directly to the
catalog unit price because Managed Payments tax can increase the total.

The worker and browser-return handler both call `ensureEntitlement(sessionId)`.
They retrieve current Stripe state rather than assuming event order, and their
conditional state transition makes webhook-first, return-first, duplicate, and
concurrent execution equivalent.

Transient failures throw so SQS retries. Persistent failures move to the DLQ
and alarm. Integrity mismatches must not be silently treated as successful
fulfillment.

## AWS infrastructure and security

- Use a Regional API Gateway HTTP API behind the existing CloudFront
  distribution.
- Disable the production default `execute-api` endpoint and use a Regional API
  custom origin domain.
- Configure CloudFront with caching disabled for `api/*`, all seven viewer HTTP
  methods enabled so POST can pass, query strings and required headers
  forwarded, and bodies unchanged.
- Add a random CloudFront origin-verification header and require it in every API
  adapter. This restricts origin bypass; it is not buyer authentication.
- Keep explicit API Gateway routes responsible for rejecting unsupported
  methods.
- Set initial route throttles to checkout `2 rps / 5 burst`, fulfillment
  `5 / 10`, download `10 / 20`, and webhook `10 / 20`.
- Keep API responses non-cacheable and omit CORS because browser traffic is
  same-origin.
- Change CSP from `form-action 'none'` to `form-action 'self'`.
- Set the purchase flow's referrer policy to `no-referrer` and remove the
  referrer field from CloudFront access logs.

Use separate least-privilege roles:

- Receiver: webhook secret read and SQS send only.
- Worker: SQS consume, Stripe read credential, and DynamoDB order updates.
- Buyer API: catalog read, Checkout create/read, order read/write, token key
  read, and `s3:GetObject` signing permission limited to `fulfillment/*`.

Keep Stripe API credentials, webhook secrets, and token key rings in distinct
SSM SecureString parameters so each function reads only what it needs. Secret
rotation must use bounded caching or an explicit deployment revision so warm
Lambda environments do not retain a retired secret indefinitely.

## Monitoring and recovery

API Gateway access logs contain only request ID, route, status, integration
status, latency, and response size. Application logs use structured outcomes
and redacted or hashed identifiers. Never log request bodies, signatures,
Session IDs in full, tokens, query strings, customer data, or presigned URLs.

Alarm through the existing SNS topic on:

- API Gateway `5XX` responses.
- Lambda errors and throttles.
- Worker duration approaching timeout.
- DynamoDB throttles and system errors.
- SQS oldest-message age.
- Any message visible in the DLQ.
- Custom rejected-event and invalid-transition metrics.
- An unusual burst of Checkout Session creation.

Retain the receipt-reply recovery policy. The trusted `commerce:link` command
looks up the durable order, retrieves current Stripe payment and Charge state,
refuses unpaid/refunded/disputed orders, and mints a fresh seven-day token. No
public admin route, customer account, custom email delivery, or PII database is
introduced.

Add an operator reconciliation command that compares recent Stripe events and
orders with DynamoDB and can enqueue missing work. Document webhook-secret
rotation, token-key rotation, DLQ inspection/redrive, refund, dispute,
restoration, reconciliation, and manual reissue procedures.

## Pre-launch migration

1. Build catalog version 3 and upload a content-addressed fulfillment asset for
   every sellable photograph.
2. Deploy the production DynamoDB table, API Gateway, Lambdas, queues, IAM,
   logs, and alarms without exposing the new checkout form.
3. Deploy a temporary isolated test-mode stack with separate Stripe test keys,
   webhook secret, table, queues, API endpoint, and CloudFront test surface.
4. Register the sandbox webhook and complete the full acceptance suite.
5. Register the live webhook and confirm a signed delivery reaches the
   production queue.
6. Switch CloudFront `api/*` to API Gateway and deploy the POST form, CSP,
   referrer, and purchase-page changes.
7. Complete one controlled live purchase, download, manual reissue, refund, and
   post-refund reissue-refusal drill.
8. Remove the old Function URL and stateless fulfillment implementation after
   the live drill passes.
9. Destroy the temporary sandbox stack.

Because there are no customer orders, the migration deliberately has no
backfill, dual-write period, legacy-token decoder, compatibility Checkout
creation route, or extended rollback window.

## Acceptance criteria

- Generated store HTML uses an accessible native POST form and contains no
  purchase `href`.
- Invalid method, body, field, origin, or attempted price never calls Stripe.
- The pending order is durable before Checkout Session creation, and uncertain
  Stripe retries reuse its idempotency key.
- Successful Checkout creation returns `303`.
- Webhook signatures use exact raw bytes; invalid signatures and wrong modes
  enqueue nothing and change no order.
- Queue failure returns a retryable response; worker failure retries and reaches
  the DLQ when persistent.
- Webhook-before-return, return-before-webhook, duplicate, concurrent, and
  out-of-order cases converge on one legal order state.
- Unpaid and async-failed Sessions never grant access; async success does.
- Wrong product, quantity, amount, currency, metadata, account, or mode is
  rejected.
- Repricing, delisting, renaming, or catalog removal after Checkout creation
  does not alter the purchased asset.
- Refunds and disputes block new return/reissue tokens but not a previously
  issued token.
- Token-key rotation preserves links signed by the previous key.
- Direct API-origin access without the CloudFront verification header fails.
- Session IDs, tokens, download URLs, webhook bodies, and customer data do not
  appear in logs, DynamoDB, or alarm payloads.
- Unit tests, typecheck, Lambda bundles, Terraform validation and plan, sandbox
  flows, and the controlled live drill pass before the old path is removed.

## Explicitly out of scope

- Existing customer or entitlement migration.
- Customer accounts or self-service purchase history.
- Custom email delivery or SES.
- Immediate revocation checks on every token redemption.
- WAF, Step Functions, or a permanent sandbox environment.
- Multiple products, quantities, carts, subscriptions, or license tiers beyond
  the current single-download offer.
