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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.COMMERCE_PORT ?? process.env.PORT ?? 8787);
const EDGE_SECRET = randomBytes(24).toString('hex');

/*
 * Test keys come from .env.local, which is gitignored — so there is no step to
 * forget and no key sitting in shell history. Live keys never belong here; they
 * only ever live in Secrets Manager.
 */
const envFile = path.join(repoRoot, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match || line.trimStart().startsWith('#')) continue;
    process.env[match[1]] ??= match[2].trim().replace(/^["']|["']$/g, '');
  }
  console.log('commerce:dev: loaded .env.local');
}

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

/*
 * Serve the catalog from the last `bun run build` instead of the site bucket, so
 * a photo can be put on sale and bought locally without deploying first. Only
 * this one object is intercepted; presigning a download still goes to real S3,
 * which is why redeeming a download link needs `aws login`.
 */
const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
const localCatalog = path.join(repoRoot, 'dist', 'downloads-catalog.json');
const realSend = S3Client.prototype.send;
S3Client.prototype.send = function send(command, ...rest) {
  if (command instanceof GetObjectCommand && command.input.Key === 'downloads-catalog.json') {
    if (!existsSync(localCatalog)) {
      throw new Error(`commerce:dev: ${localCatalog} is missing — run \`bun run build\` first`);
    }
    const body = readFileSync(localCatalog, 'utf8');
    return Promise.resolve({ Body: { transformToString: async () => body } });
  }
  return realSend.call(this, command, ...rest);
};

const { handler } = await import('../lambda/index.ts');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve `dist/` the way CloudFront does, so the store and the site share one
 * origin locally exactly as they do in production — a relative `/api/checkout`
 * link just works. Mirrors the viewer-request function in infra/main.tf:
 * a trailing slash or an extensionless path resolves to index.html.
 */
function serveStatic(url, response) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  else if (!path.extname(pathname)) pathname += '/index.html';

  const dist = path.join(repoRoot, 'dist');
  const file = path.resolve(dist, `.${pathname}`);
  /* Never serve outside dist/, however the path was written. */
  if (!file.startsWith(dist + path.sep) || !existsSync(file)) {
    const notFound = path.join(dist, '404.html');
    const body = existsSync(notFound)
      ? readFileSync(notFound)
      : 'Not found — run `bun run build` first.';
    response.writeHead(404, { 'content-type': MIME['.html'] });
    return response.end(body);
  }

  response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
}

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    const body = Buffer.concat(chunks);

    if (!url.pathname.startsWith('/api/')) return serveStatic(url, response);

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
  console.log(`commerce:dev serving dist/ and the store on http://localhost:${PORT}`);
  console.log(`  webhooks:  stripe listen --forward-to localhost:${PORT}/api/stripe/webhook`);
  if (!existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
    console.log('  note:      dist/ is empty — run `bun run build`');
  }
});
