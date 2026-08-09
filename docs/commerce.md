# Store design

The store adds paid downloads to an otherwise static Astro site. Stripe Checkout
collects the payment, DynamoDB keeps the order record, and three Lambda functions
connect those services to the site. There is no application server or public
admin interface running alongside the static pages.

This guide explains how a purchase works and where the security boundaries are.
For testing, recovery, and customer support, see [Store
operations](commerce-operations.md).

## From purchase to download

```text
Browser -> CloudFront -> API Gateway -> Buyer Lambda -> Stripe Checkout
Stripe  -> CloudFront -> API Gateway -> Webhook Lambda -> DynamoDB
Download link -> Buyer Lambda -> private photo master in S3
```

The site build creates a private catalog from every live photo with a price. A
purchase form sends only the photo ID. The Buyer Lambda finds the current price
and display information in the catalog, creates a pending order, and then opens
a Stripe Checkout Session. Price and product details from the browser are never
trusted.

After payment, either the Stripe webhook or the browser's return from Checkout
can complete the order. Both paths call the same operation, which is safe to run
more than once. DynamoDB keeps the order and a snapshot of the photo as it
appeared when purchased. It does not store addresses, payment details, download
tokens, or temporary S3 URLs.

## API routes

| Method | Route | What it does |
| --- | --- | --- |
| `POST` | `/api/checkout` | Creates an order and sends the buyer to Stripe Checkout. |
| `POST` | `/api/stripe-webhook` | Applies payment, refund, and dispute updates from Stripe. |
| `GET` | `/api/fulfill?session_id=…` | Returns the result when a buyer comes back from Checkout. |
| `GET` | `/api/download?t=…` | Exchanges a download token for a temporary S3 URL. |

CloudFront adds a private verification header before forwarding these requests
to API Gateway. The gateway and the Lambda handlers both check it. The header
value must never appear in browser code, logs, commits, or operational notes.

## Order states

Every order begins as `pending`. A successful payment moves it to `entitled`.
An expired or failed Checkout Session moves it to `closed`, while a refund or
dispute moves it to `revoked`.

Repeated or out-of-order Stripe events do not repeat the transition. The
handlers read the current Stripe state and use conditional DynamoDB writes. A
revoked order cannot be restored automatically. Even when a dispute is won, an
operator must review the Stripe record and run the restoration command.

## Download links

An entitled order gets a signed download token that lasts seven days. When the
buyer uses it, the Buyer Lambda confirms that the photo master still exists and
returns an S3 URL that lasts 15 minutes.

Token redemption does not read the order, catalog, or Stripe. As a result, a
refund or dispute prevents new links from being issued but cannot cancel a token
that was already sent to the buyer. It expires on its original schedule.

## Access to production data

The Buyer Lambda can read the private catalog, create Checkout Sessions, update
orders, sign download tokens, and create temporary URLs for photo masters. The
Webhook Lambda can read payment state and update orders, but it cannot create
Checkout Sessions, sign tokens, or read the masters. The Authorizer Lambda can
only write its own logs.

Stripe credentials and signing keys live in encrypted SSM parameters. They are
not stored in Terraform state or Lambda environment variables. Application logs
exclude request bodies, secrets, customer data, download tokens, and temporary
S3 URLs.
