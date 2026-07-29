/**
 * Runs the commerce Lambda on localhost so the money path can be exercised
 * without a `terraform apply` between every edit. The local counterpart to the
 * deployed function, the way photos-media-dev.mjs is to the CodeBuild job.
 *
 *   bun run commerce:dev                                  # serves :8787
 *   bun run commerce:listen                               # stripe -> :8787
 *   open http://localhost:8787/api/checkout?sku=<sku>
 *
 * It runs the real handler against real AWS and real Stripe test keys, so what
 * passes here is the same code path that runs in production. That means it needs
 * `aws login` first, and Stripe *test* keys in the environment:
 *
 *   export STRIPE_API_KEY=rk_test_…       # restricted key, Checkout write
 *   export STRIPE_WEBHOOK_SECRET=whsec_…  # printed by `stripe listen`
 *
 * The catalog is read from the site bucket, so `bun run build` and a deploy (or
 * a manual `aws s3 cp dist/downloads-catalog.json s3://…`) have to have happened
 * for a SKU to be purchasable.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8787);
const EDGE_SECRET = randomBytes(24).toString('hex');

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`commerce:dev: ${name} is not set — see the comment at the top of this script`);
    process.exit(1);
  }
  return value;
}

const stripeApiKey = required('STRIPE_API_KEY');
if (stripeApiKey.startsWith('rk_live') || stripeApiKey.startsWith('sk_live')) {
  console.error('commerce:dev: refusing to run against a live Stripe key');
  process.exit(1);
}

/*
 * The handler reads its environment at import time, so this has to be set before
 * the dynamic import below. Secrets normally come from Secrets Manager; locally
 * they are faked by pointing the loader at a value we already hold.
 */
process.env.COMMERCE_SECRET_ID ??= 'adamficke-com-commerce';
process.env.ORIGINALS_BUCKET ??= 'adamficke-com-originals';
process.env.SITE_BUCKET ??= 'adamficke-com-site';
process.env.SITE_URL ??= `http://localhost:${PORT}`;
process.env.EDGE_SECRET = EDGE_SECRET;

/* Stand in for Secrets Manager without reaching for it. */
const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
SecretsManagerClient.prototype.send = async () => ({
  SecretString: JSON.stringify({
    stripeApiKey,
    stripeWebhookSecret: required('STRIPE_WEBHOOK_SECRET'),
    downloadTokenKey: process.env.DOWNLOAD_TOKEN_KEY ?? 'local-development-token-key',
  }),
});

const { handler } = await import('../lambda/index.ts');

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    const body = Buffer.concat(chunks);

    const result = await handler({
      rawPath: url.pathname,
      rawQueryString: url.searchParams.toString(),
      /* CloudFront adds this in production; add it here so the gate passes. */
      headers: { ...request.headers, 'x-edge-secret': EDGE_SECRET },
      requestContext: { http: { method: request.method } },
      body: body.length ? body.toString('utf8') : undefined,
      isBase64Encoded: false,
    }).catch((error) => {
      console.error(error);
      return { statusCode: 500, body: JSON.stringify({ error: String(error) }) };
    });

    console.log(`${request.method} ${url.pathname} -> ${result.statusCode}`);
    response.writeHead(result.statusCode, result.headers ?? {});
    response.end(result.body ?? '');
  });
}).listen(PORT, () => {
  console.log(`commerce:dev listening on http://localhost:${PORT}`);
  console.log('  stripe listen --forward-to localhost:%d/api/stripe/webhook', PORT);
});
