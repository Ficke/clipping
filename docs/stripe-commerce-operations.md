# Stripe commerce operations

This runbook covers the durable commerce implementation described in
[`stripe-commerce-architecture.md`](stripe-commerce-architecture.md). Source
completion is not deployment: check
[`stripe-commerce-implementation.md`](stripe-commerce-implementation.md) before
using a live-mode command.

## Safety rules

- Treat Checkout Session IDs and download links as bearer capabilities. Do not
  paste them into tickets, chat, commits, logs, or the implementation ledger.
- Never copy API keys or webhook signing secrets into this repository. The
  commands read KMS-encrypted SSM parameters; `commerce:dev` accepts only a test
  Stripe key.
- Always pass `--mode test|live` to reconciliation and restoration. Test-mode
  commands require `COMMERCE_TABLE` and refuse a production-shaped table name.
- Start recovery with a dry run. Restoration is the only operator command that
  can move a revoked order back to `entitled`, and Stripe must show a won
  dispute, no refund, and no current dispute.
- `commerce:dev` creates a tagged, uniquely named DynamoDB table and deletes it
  on `SIGINT`, `SIGTERM`, startup failure, or normal shutdown. If the process is
  killed ungracefully, use the printed cleanup command after verifying the exact
  table name.

## M5 ingress correction gates

The deployed HTTP API route throttle is best-effort and did not prevent a direct
burst from invoking and throttling Buyer. Do not register the production
webhook or activate storefront v3 until both correction apply gates below pass.
Terraform apply, webhook registration, storefront activation, live Stripe
actions, fulfillment upload/backfill, and site deployment remain separate
approval gates.

### Prerequisites

1. Authenticate with `aws login` and confirm the branch/worktree are clean.
2. Read the implementation ledger and architecture gates again.
3. Confirm the us-east-1 Lambda concurrency quota is at least 110. Requesting
   the increase from 10 is a separate account-change approval. Do not apply the
   reservation source while the quota is lower: AWS retains 100 units for
   unreserved functions, and the correction allocates the remaining ten as
   Buyer 6, Webhook 3, and Authorizer 1.
4. Inspect the API Gateway account's regional `cloudWatchRoleArn`. REST access
   logs require this singleton setting. Reuse an appropriate existing role; if
   it is absent, add a dedicated logging role and review its account-level delta
   explicitly. Never overwrite an unrelated role merely to satisfy the stage.
5. Rebuild Buyer, Webhook, and Authorizer bundles and run the complete code and
   Terraform validation gate.

For every plan, recover the existing origin-verification value from encrypted
Terraform state into a history-disabled process and pass it through
`TF_VAR_commerce_origin_verify_header_value`. Never print it, save a plan that
contains it, write plaintext state to disk, or rotate it to make planning
easier. Terraform derives the separate fixed-width gateway token in memory.

### Gate A — additive protected ingress

Keep `commerce_rest_cutover_enabled = false`. Generate and review a fresh
authenticated plan. It may add the Regional REST API, five explicit methods,
the cached exact-token authorizer, Authorizer Lambda/role/logs/alarms, REST
access logs and alarm, route-scoped invocation permissions, and reserved
concurrency. It may update the Buyer/Webhook bundles for REST payload v1
compatibility. It must not change CloudFront routing or destroy the deployed
HTTP API, legacy Lambda runtime, parameters, table, or any other rollback rail.
Stop for exact-plan approval.

After an approved apply, verify configuration and zero drift, then exercise the
new REST endpoint directly without involving Stripe:

- A burst with the gateway header absent returns an authorization failure and
  produces zero Authorizer, Buyer, and Webhook invocations.
- A burst with a same-length incorrect gateway value does the same.
- A single request carrying both correct in-memory CloudFront headers and an
  intentionally malformed checkout body reaches Buyer and returns the expected
  non-cacheable `400` without loading Stripe secrets, writing DynamoDB, or
  contacting Stripe.
- REST proxy webhook fixtures preserve exact base64-decoded bytes; do not send a
  production webhook or populate its SSM shell at this gate.
- Buyer, Webhook, and Authorizer reservations are exactly 6, 3, and 1, and all
  new IAM, logs, alarms, methods, gateway responses, and permissions match the
  reviewed source.

### Gate B — CloudFront origin cutover

Only after Gate A passes, change the committed default of
`commerce_rest_cutover_enabled` to `true`, rebuild, and review another exact
plan. Its intended operational change is the CloudFront commerce origin domain
and stage path plus the derived gateway-token header. It must retain the
original handler-verification header and must not delete the HTTP API or legacy
runtime. Stop for separate apply approval.

After an approved cutover, wait until CloudFront reports `Deployed`, then repeat
the safe malformed checkout/fulfillment probes through the public site. Repeat
the direct missing/wrong-token bursts and verify zero Lambda invocation delta.
Confirm the deployed function reservations and account unreserved pool are
exactly 6/3/1/100, and send a malformed non-secret webhook probe concurrently
with a safe invalid Buyer burst to confirm the isolated path remains available.
Finish with a zero-drift Terraform plan using the same in-memory origin value,
then clear the environment and exit the history-disabled shell.

Rollback is a separately reviewed change setting
`commerce_rest_cutover_enabled` back to `false`, which points CloudFront at the
still-deployed HTTP API. Do not delete the failed REST path during the rollback;
preserve evidence and diagnose it first.

## Local sandbox acceptance

This exercise uses a real Stripe sandbox, the real Buyer and Webhook handlers,
and a temporary DynamoDB table in AWS. It never uses a live Stripe key and does
not deploy the site or Terraform. Run it before the storefront cutover and
after changes to checkout, fulfillment, webhooks, recovery, or token handling.

Prerequisites:

- An authenticated AWS session that can read
  `/adamficke-com/commerce-test`, create/delete the temporary table, and presign
  the originals bucket.
- A valid test secret containing `stripeApiKey`, `stripeProductId`, and
  `downloadTokenKey`. Its restricted Stripe test key needs Checkout Sessions
  write plus Payment Intents, Charges and Refunds, Payment Disputes, and Events
  read permissions. Keep this key in test mode.
- Stripe CLI authenticated to the same sandbox.
- A catalog v3 build with at least one sellable photo. Following the final S3
  redirect also requires that photo's `fulfillment/<assetRef>` object; do not
  run the fulfillment backfill merely to complete this code-only checkpoint.

### Start the environment

Terminal 1 forwards only the events the handler accepts. The signing secret is
the one printed by [`stripe listen`](https://docs.stripe.com/stripe-cli/use-cli),
not a Dashboard endpoint secret:

```sh
stripe login
stripe listen \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.refunded,charge.dispute.created,charge.dispute.closed \
  --forward-to http://localhost:8787/api/stripe-webhook
```

Copy the displayed `whsec_…` into a hidden prompt in terminal 2; do not put the
value in shell history:

```sh
read -s STRIPE_WEBHOOK_SECRET
export STRIPE_WEBHOOK_SECRET
aws login
bun run build
bun run commerce:dev
```

The server prints its temporary table name. In terminal 3, set only that
non-secret name so operator commands address the same sandbox orders:

```sh
export COMMERCE_TABLE=adamficke-com-commerce-dev-…
```

Open `http://localhost:8787/store/`. Before paying, verify the generated page
uses a `POST` form and has no purchase link, and verify invalid requests stay
local:

```sh
curl -i http://localhost:8787/api/checkout
curl -i -X POST -H 'content-type: application/x-www-form-urlencoded' \
  --data 'photo_id=bad&price=1' http://localhost:8787/api/checkout
```

Both requests must be rejected without a Stripe request in the CLI stream.

### Successful purchase and reissue

1. Buy a sandbox item using card `4242 4242 4242 4242`, any future expiry,
   three-digit CVC, and postal code.
2. Confirm the browser reaches `/purchase/`, polling converges to the download
   view, and `stripe listen` reports `200` for `checkout.session.completed`.
3. Confirm the Session is `mode=payment`, has a populated PaymentIntent, and its
   integration currency amount matches the catalog. Inspect this in the sandbox
   Dashboard without copying the Session object into logs.
4. Follow the download. A `302` to S3 proves token redemption; the final object
   succeeds only after its immutable fulfillment asset has been uploaded.
5. Run `bun run commerce:link -- cs_test_…` from terminal 3. Confirm it prints a
   fresh seven-day link, then clear the terminal if it is recorded.
6. Run `bun run commerce:reconcile -- --mode test --dry-run`. The paid order
   should be `UNCHANGED already_entitled`, and the command must exit zero.

### Refund revocation

Use a separate successful sandbox purchase. Simulate the external fact by
refunding that sandbox payment in the Dashboard; this is a test of inbound
revocation, not a production refund procedure.

1. Confirm `charge.refunded` reaches the local webhook with `200`.
2. Confirm browser-return fulfillment is unavailable and
   `commerce:link` refuses a new link.
3. Confirm a token issued before the refund still redirects until its seven-day
   expiry; redemption is intentionally stateless.
4. Run test-mode reconciliation. It should leave the already-revoked order
   unchanged and exit zero.

### Dispute and restoration

Use another sandbox purchase with Stripe's documented
[dispute test card](https://docs.stripe.com/testing?testing-method=card-numbers)
`4000 0000 0000 0259`.

1. Confirm `charge.dispute.created` is accepted and future fulfillment/reissue
   is refused.
2. In the sandbox Dashboard, submit `winning_evidence` as the dispute's
   additional information. Wait for `charge.dispute.closed`.
3. Run reconciliation. The order must report
   `REVIEW won_dispute_requires_manual_restore`; reconciliation never restores
   automatically.
4. After reviewing the Stripe facts, restore explicitly:

   ```sh
   bun run commerce:restore -- ord_… \
     --actor operator-name \
     --reason 'sandbox won-dispute drill' \
     --mode test
   ```

5. Confirm `commerce:link` can issue a fresh link again and the DynamoDB order
   records `restoredAt`, `restoredBy`, and `restorationReason`.

Stop `commerce:dev` with Ctrl-C and verify that it prints deletion of the exact
temporary table. Unset `STRIPE_WEBHOOK_SECRET` and `COMMERCE_TABLE` afterward.
Record only pass/fail evidence in the implementation ledger—never IDs, tokens,
signatures, presigned URLs, or customer data.

## Reconciliation after an alarm

Reconciliation scans every non-closed order using current Stripe facts. It is
manual by design; there is no scheduled sweep.

```sh
aws login
bun run commerce:reconcile -- --mode live --dry-run
bun run commerce:reconcile -- --mode live
```

Use `--order ord_…` for a single known order. Outcomes mean:

- `REPAIRED`: the command attached a recovered Session, entitled a paid order,
  closed an expired/failed order, or revoked a refunded/disputed order.
- `UNCHANGED`: current durable and Stripe state already agree, payment remains
  legitimately pending, or no matching Session has appeared yet.
- `REVIEW`: automation stopped at a won dispute; follow the restoration
  procedure below.
- `FAILED`: a dependency or integrity check failed. The command continues the
  scan but exits non-zero. Do not bypass the check; investigate and rerun.

A dry run performs every Stripe read and integrity check but no DynamoDB write.
Its `REPAIRED` lines describe writes the non-dry command would make.

## Manual download reissue

Accept a reissue request only through a reply to the Stripe/Link receipt. From a
trusted machine:

```sh
aws login
bun run commerce:reconcile -- --mode live --order ord_… --dry-run
bun run commerce:link -- cs_live_…
```

The command re-reads current payment, Charge, refund, dispute, and durable-order
state. It refuses unpaid, closed, revoked, refunded, or disputed purchases. Send
the resulting link only to the verified receipt correspondent; do not store it.

## Dispute review and restoration

Every opened or closed dispute revokes the order. Review the dispute in Stripe.
A lost, open, or refunded order stays revoked. After Stripe records the dispute
as won and reconciliation reports `REVIEW`, run:

```sh
bun run commerce:restore -- ord_… \
  --actor operator-name \
  --reason 'Stripe dispute won; reviewed YYYY-MM-DD' \
  --mode live
```

The command independently retrieves the Session, expanded Charge, and disputes.
It conditionally restores only a currently revoked order and writes the audit
fields. Then run a single-order dry reconciliation and, only if requested,
manual reissue.

## Link escalation response

Keep the support address in Stripe business settings monitored. Respond to Link
escalations within 48 hours. The store does not offer voluntary refunds, but
Stripe or Link can impose one; never suppress or reverse that event locally.
After any externally imposed refund or dispute, verify webhook delivery and run
single-order reconciliation if the durable state did not change.

## Webhook signing-secret rotation

The webhook parameter contains `stripeReadApiKey`, `stripeWebhookSecret`, and an
optional `stripeWebhookSecretPrevious`. Rotation uses the overlap field because
Lambda caches successful SSM reads for up to five minutes.

1. Begin a signing-secret roll in Stripe with an overlap period. Keep the old
   secret active.
2. Update `/adamficke-com/commerce-webhook` so the new secret is current and the
   old secret is `stripeWebhookSecretPrevious`. Preserve the read key. Use a
   hidden shell variable or an approved secret-management UI; never put literal
   values in the command history.
3. Wait at least five minutes, then deliver a signed test event through the
   production endpoint and confirm a `2xx` plus the expected durable write.
4. After Stripe's overlap ends, remove `stripeWebhookSecretPrevious`, wait five
   minutes, and verify another signed event.
5. If delivery fails, restore the last known-good two-secret document while the
   old Stripe secret remains active. Run reconciliation for any affected order.

Never record either signing secret, an event body, or a full event identifier in
the implementation ledger.

The live Buyer key needs only Checkout Sessions write. The separate live
Webhook/operator read key needs Checkout Sessions, Payment Intents, Charges and
Refunds, Payment Disputes, and Events read permissions. Do not add write access
to the read key.
