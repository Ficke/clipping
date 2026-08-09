# Store operations

These procedures are for testing purchases and recovering live orders. The
commands can read production payment data, so run them from a trusted machine
with an authenticated AWS session.

Treat Checkout Session IDs and download links like passwords. Do not paste them,
Stripe keys, webhook secrets, request bodies, or customer details into tickets,
chat, commits, logs, or operational notes.

## Recovering orders after an alarm

Reconciliation compares open orders in DynamoDB with their current state in
Stripe. It can recover a Checkout Session that was created but not attached to
its order, complete a paid order, close a failed order, or revoke a refunded or
disputed order.

Begin with a dry run:

```sh
aws login
bun run commerce:reconcile -- --mode live --dry-run
```

The command checks every open order unless you add `--order ord_…`. Review the
result before running it again without `--dry-run`.

- `REPAIRED` describes a change that was made, or that would be made in a dry
  run.
- `UNCHANGED` means the records already agree or the payment is still pending.
- `REVIEW` means automation stopped because a won dispute needs a person to
  approve restoration.
- `FAILED` means a dependency or integrity check failed. Investigate the error
  before running the command again.

## Sending a new download link

Only accept a request that comes as a reply from the address that received the
Stripe or Link receipt. Reconcile that order before creating another link:

```sh
aws login
bun run commerce:reconcile -- --mode live --order ord_… --dry-run
bun run commerce:link -- cs_live_…
```

The link command checks Stripe and the stored order again. It refuses purchases
that are unpaid, closed, refunded, or disputed. Send the printed link directly
to the verified buyer and do not save it elsewhere.

## Restoring a won dispute

An open, lost, or refunded dispute must remain revoked. If Stripe marks a
dispute as won, reconcile the order first. A `REVIEW` result means it is eligible
for a manual decision.

After checking the payment and dispute in Stripe, restore the order with:

```sh
bun run commerce:restore -- ord_… \
  --actor operator-name \
  --reason 'Stripe dispute won and reviewed on YYYY-MM-DD' \
  --mode live
```

The command retrieves the Stripe records again before making the change. It
also records who restored the order, when they did it, and why. Finish with a
single-order dry reconciliation. Only send a new link if the buyer asked for
one.

## Testing a purchase locally

The local checkout test uses the real Buyer and Webhook handlers with Stripe
test mode and a temporary DynamoDB table. It reads test credentials from
`/adamficke-com/commerce-test` in SSM and uses the private photo bucket for the
final download. It does not deploy the site or Terraform, and it refuses live
Stripe keys.

You will need AWS access to the test parameter and originals bucket, Stripe CLI
access to the same test account, and at least one priced photo in the local site
build.

In the first terminal, ask Stripe CLI to forward the events the webhook handles:

```sh
stripe login
stripe listen \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.refunded,charge.dispute.created,charge.dispute.closed \
  --forward-to http://localhost:8787/api/stripe-webhook
```

Stripe CLI prints a signing secret beginning with `whsec_`. Enter it through a
hidden prompt in a second terminal so it does not end up in shell history:

```sh
read -s STRIPE_WEBHOOK_SECRET
export STRIPE_WEBHOOK_SECRET
aws login
bun run build
bun run commerce:dev
```

`commerce:dev` prints the name of its temporary DynamoDB table. Export that
non-secret name in a third terminal before running test-mode operator commands:

```sh
export COMMERCE_TABLE=adamficke-com-commerce-dev-…
```

Open `http://localhost:8787/store/` and buy an item with Stripe's test card
`4242 4242 4242 4242`. Use any future expiration date and any three-digit CVC.
The webhook should return `200`, and the purchase page should eventually show a
working download.

Finish by checking that Stripe and DynamoDB agree:

```sh
bun run commerce:reconcile -- --mode test --dry-run
```

The order should be reported as unchanged. Stop `commerce:dev` with Ctrl-C and
confirm that it deletes the temporary table. If the process was killed before
cleanup, use the exact deletion command it printed at startup after checking the
table name.

## Rotating the API verification value

Terraform creates and stores both API verification values. CloudFront sends one
while the API accepts both, which allows either value to be replaced without
interrupting purchases. Never print or copy either value.

Move traffic to `next`, wait for the CloudFront deployment to finish, then
replace the retired `current` value:

```sh
terraform -chdir=infra apply -var='commerce_origin_verify_active=next'
terraform -chdir=infra apply \
  -var='commerce_origin_verify_active=next' \
  -replace=random_password.commerce_origin_verify
```

To rotate in the other direction, set `commerce_origin_verify_active` to
`current`, wait for CloudFront, and replace
`random_password.commerce_origin_verify_next`. Keep the variable set to
`current` on the replacement apply as well.

## Rotating the Stripe webhook secret

Start the rotation in Stripe with an overlap period so the old secret remains
valid. Update `/adamficke-com/commerce-webhook` with the new secret in
`stripeWebhookSecret` and the old one in `stripeWebhookSecretPrevious`. Preserve
the existing `stripeReadApiKey`.

Wait at least five minutes for the Lambda secret cache, then send a signed test
event and confirm that it produces the expected order update. After Stripe ends
the overlap period, remove `stripeWebhookSecretPrevious`, wait another five
minutes, and test again.

If delivery fails, restore the last working two-secret document while the old
secret is still active. Reconcile any order whose webhook may have been missed.
