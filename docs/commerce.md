# Commerce architecture

The store sells full-resolution photograph downloads through Stripe-hosted
Checkout. This document describes the deployed request path and data model.
Operational procedures are in
[commerce-operations.md](commerce-operations.md); photograph storage is in
[photo-architecture.md](photo-architecture.md).

## Overview

```text
Browser -> CloudFront -> REST API -> Buyer Lambda -> Stripe Checkout
Stripe  -> CloudFront -> REST API -> Webhook Lambda -> DynamoDB
Download token -> CloudFront -> Buyer Lambda -> private S3 master
```

- The site is static. Commerce runs independently in three Node 22 Lambdas:
  Buyer, Webhook, and API Gateway Authorizer.
- The site build publishes a private catalog containing current prices and sale
  state. Checkout never trusts price or product data from the browser.
- DynamoDB holds durable order state and an immutable display snapshot of the
  purchase.
- Browser-return fulfillment and Stripe webhooks call the same idempotent
  entitlement operation.
- Signed download tokens are valid for seven days. Redemption reads no order or
  catalog state and returns a 15-minute presigned S3 URL.

## Ingress and routes

CloudFront sends `/api/*` to a Regional API Gateway REST API. Every method
requires `X-Commerce-Origin-Verify`, which CloudFront overwrites with one of two
Terraform-generated values. API Gateway validates the value before invoking a
cached Lambda Authorizer; Buyer and Webhook verify it again as defense in depth.
Both generated values remain accepted during rotation.

The values must not appear in HTML, browser JavaScript, application logs, access
logs, commits, or operational notes. API responses are non-cacheable, and the
same-origin browser flow requires no CORS policy.

| Method | Route | Behavior |
| --- | --- | --- |
| `POST` | `/api/checkout` | Create a pending order and Stripe Checkout Session, then return `303`. |
| `GET` | `/api/checkout` | Return `405`; never contact Stripe. |
| `POST` | `/api/stripe-webhook` | Verify the Stripe signature and update durable order state. |
| `GET` | `/api/fulfill?session_id=…` | Fulfill or retrieve the order for a Checkout return. |
| `GET` | `/api/download?t=…` | Verify a download token and return `302` to S3. |

Checkout is a native form POST. The handler accepts exactly one `photo_id` in a
form body no larger than 1 KB, then:

1. Resolves the photo in the private catalog.
2. Creates a conditional `pending` DynamoDB order with the catalog snapshot.
3. Creates one Stripe Checkout Session, using the order ID as the idempotency
   key and metadata reference.
4. Attaches the Session ID and expiry to the order.
5. Redirects the browser to Stripe.

The order exists before Stripe receives the request. If attaching the Session
fails after Stripe creates it, reconciliation recovers the Session by its order
metadata.

`GET /api/fulfill` retrieves current Stripe state and the durable order. It
returns a download link for an entitled order, `202` while a delayed payment is
pending, `404` for an unknown Session, and `410` for expired, closed, or revoked
orders. The purchase page polls a pending response for 30 seconds before showing
a durable recovery message.

## Catalog and photograph masters

Only photographs with a frontmatter `price` appear in
`downloads-catalog.json`. The site build writes the file to the private site
bucket; CloudFront returns `404` for its public path. Buyer reads it directly
through IAM and caches it for 60 seconds.

Each photograph has one full-resolution, metadata-minimized master and a
separate capture-metadata sidecar:

```text
photos/<photoId>            full-resolution master
metadata/<photoId>.json     capture metadata, including GPS
```

Buyer can read only `photos/*`. Re-exporting a photograph overwrites its stable
master so previously issued links serve the improved file. `photos:push`
requires confirmation before replacing different bytes, and S3 versioning keeps
the previous object recoverable for 90 days.

## Orders and entitlement

The DynamoDB table uses `orderId` as its partition key and has no secondary
indexes. Request-path reads are strongly consistent. Reconciliation scans the
table because it is an operator workflow rather than a request path.

```text
pending  -> entitled
pending  -> closed     (expired or failed)
pending  -> revoked
entitled -> revoked
```

Automated processing never leaves `revoked`. Restoring a won dispute requires
an operator command that rechecks Stripe and records the actor, time, and
reason. Conditional writes make duplicate and concurrent transitions
idempotent. Only `closed` orders receive a 30-day DynamoDB TTL.

Orders store payment references, expected amount, permanent photo ID, and the
album title, label, and preview shown at purchase. They do not store customer
email, address, payment-method data, complete Stripe events, download tokens, or
presigned URLs.

The signed entitlement contains only:

```text
version
orderId
photoId
expiresAt
```

The token is verified before parsing. Redemption uses `photoId` to locate the
master and performs one `HeadObject` so a deliberately deleted photograph
returns `410`. It does not reread DynamoDB, Stripe, or the catalog. Refunds and
disputes therefore block future fulfillment and reissue; tokens already issued
remain valid until their seven-day expiry.

## Stripe events

The webhook accepts only these event types:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

It verifies the signature against the current or overlapping previous signing
secret before parsing the event. It then retrieves current Stripe state instead
of trusting event order. A `2xx` response is sent only after the DynamoDB
transition commits; transient failures return `5xx` so Stripe retries.

The store does not initiate refunds. A Stripe- or Link-imposed refund or dispute
revokes the order. A won dispute remains revoked until an operator reviews and
restores it.

## Security and operations

- Buyer can read the catalog, create Checkout Sessions, update orders, read the
  token key, and presign only `photos/*`.
- Webhook can read its Stripe credentials and update orders. It cannot create
  Sessions, mint tokens, or read photograph masters.
- Authorizer can write only to its CloudWatch log group.
- Buyer, Webhook, and local development use separate KMS-encrypted SSM
  `SecureString` parameters. Stripe credentials never enter Terraform state or
  Lambda environment variables.
- Structured application logs allowlist fields and redact or hash identifiers.
  Request bodies, signatures, tokens, customer data, and presigned URLs are
  never logged.

API `5xx`, Webhook errors, and Webhook throttles raise alarms. Recovery is
manual through reconciliation, reissue, and dispute-restoration commands. See
[commerce-operations.md](commerce-operations.md) for the runbooks and secret
rotation procedures.
