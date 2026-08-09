# Commerce

How the store works: ingress, the order lifecycle, Stripe event handling, and
the AWS surface behind it. Photograph storage and identity are in
[photo-architecture.md](photo-architecture.md); the runbooks are in
[commerce-operations.md](commerce-operations.md).

Status: the infrastructure is deployed, the production webhook is registered,
and a full live drill has run end to end — purchase, entitlement, download,
refund, revocation. No real customer order has been placed.

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

**Why not a Lambda Function URL.** One with `authorization_type = NONE` spends
invocation capacity before any application header check. Lambda origin access
control avoids that, but signed POSTs impose `x-amz-content-sha256`
requirements a native HTML form cannot meet:
[AWS Lambda URL origin guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html).
The REST token gate preserves the native form body while rejecting direct
bypass before integration.

Route throttles remain useful best-effort traffic shaping, not security or
capacity ceilings:

| Route | Rate | Burst |
| --- | --- | --- |
| `POST /api/checkout` | 2 | 5 |
| `POST /api/stripe-webhook` | 10 | 20 |
| `GET /api/fulfill` | 5 | 10 |
| `GET /api/download` | 10 | 20 |

Unsupported methods are rejected by the gateway; handlers reject them too.
Handlers still accept HTTP API payload v2 as well as the REST proxy v1 they now
receive; that path is dead and can be removed. JSON and form bodies are
base64-preserved by the REST API so Stripe signatures and native form bytes are
not re-encoded.

**Reserved concurrency requires at least 110 account units,** because AWS
retains 100 for functions without reservations. Against the applied regional
quota of 1000, Buyer holds 5, Webhook 3, and Authorizer 2, leaving 990
unreserved. Reserved concurrency is both an exclusive minimum and a maximum, so
a valid Buyer burst can throttle Buyer but cannot consume Webhook, Authorizer,
or unrelated-function capacity.

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

## Order model

An on-demand DynamoDB table with point-in-time recovery. Partition key is the
local order ID. **No global secondary indexes** — every request-path read is a
strongly consistent `GetItem`. Reconciliation scans, which is free at this
table's size.

```text
orderId                  partition key
state                    pending | entitled | closed | revoked
closeReason              expired | failed, when state is closed
livemode
photoId                  permanent photograph identity; names the S3 master
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

### Photograph masters

See [photo-architecture.md](photo-architecture.md) for how these are produced.

One object per photograph, named by its permanent ID, with capture metadata
archived beside it under a prefix the buyer Lambda cannot reach:

```text
photos/<photoId>            full-resolution sanitized master
metadata/<photoId>.json     full capture metadata, including GPS
```

The key carries no extension, so `Content-Type` and `Content-Disposition` are
stored on the object at upload time and the presign needs no override.

Re-exporting a photograph overwrites its master, which is the point: every
already-issued download link starts serving the better file. Because that
reaches past buyers, `photos:push` reports the old and new size and hash and
requires confirmation before replacing bytes. Bucket versioning is the undo.

Note that `catalog.ts` and `src/lib/downloads.ts` both hard-pin the catalog
version — two places to change.

The buyer Lambda's `s3:GetObject` grant narrows from `albums/*` to `photos/*`.

### Download tokens

```text
version
orderId
photoId
expiresAt
```

HMAC-SHA-256 over the encoded payload, verified before parsing, with a single
key. The format is versioned so a key ring can be introduced later; there is no
rotation procedure today, and rotating voids live links by design. Recovery from
a rotation is the existing `commerce:link` reissue.

**Redemption reads no order state.** The S3 key is the photo ID and the
attachment filename is stored on the object, so no catalog lookup and no
DynamoDB read are involved. A token is a seven-day bearer capability that
expires on its own. The one `HeadObject` before presigning exists so a
deliberately deleted photograph reports `410` rather than handing over a URL
that fails at S3.

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
  key read, `s3:GetObject` signing limited to `photos/*`. Not `metadata/*`,
  which holds capture GPS.
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
singleton was unset, so a dedicated role holds it. Its only account-wide
permission is log-group discovery; stream and event permissions are limited to
the commerce REST access-log group.

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
less than the API alarm and reconciliation do. Seven standard-resolution
commerce alarms remain.

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

## Frozen contracts

### HTTP

- `POST /api/checkout`: form-urlencoded body no larger than 1 KB, containing
  exactly one `photo_id`; returns a non-cacheable `303`.
- `POST /api/stripe-webhook`: signed Stripe JSON no larger than 256 KB.
- `GET /api/fulfill?session_id=…`: `200`, retryable `202`, unknown `404`, or
  indistinguishable expired/closed/revoked `410`.
- `GET /api/download?t=…`: validates a stateless token and returns `302` to S3.
- All REST methods require the derived CloudFront gateway token before
  integration; Buyer and Webhook also require the original origin-verification
  header. Routes use no CORS and return `Cache-Control: no-store, private`.

### Catalog and fulfillment

- `photoId` is `photo_` followed by 24 lowercase hexadecimal characters, minted
  once and never derived from the bytes.
- The master object key is `photos/<photoId>`, and its capture metadata is
  archived to `metadata/<photoId>.json`.
- Catalog v3 contains `photoId`, `storyId`, `file`, `priceCents`, `albumTitle`,
  `label`, `previewSrc`, `width`, and `height`. Only photographs on sale are
  published, so presence in the catalog is the offer.
- Token version 1 contains only `version`, `orderId`, `photoId`, and
  `expiresAt`; redemption reads no catalog, Stripe object, or DynamoDB row. It
  makes one `HeadObject` so a deleted photograph returns `410`.

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

## Explicitly out of scope

- Customer accounts or self-service purchase history.
- Voluntary or seller-initiated refunds.
- Custom email delivery or SES.
- Download-token key rotation without voiding live links.
- Revocation checks at token redemption.
- Scheduled reconciliation, WAF, Step Functions, SQS, or a permanent sandbox
  environment.
- Multiple products, quantities, carts, subscriptions, or license tiers beyond
  the current single-download offer.
