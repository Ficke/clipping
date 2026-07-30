/**
 * Runs the commerce Lambda on localhost so the money path can be exercised
 * without a `terraform apply` between every edit. The local counterpart to the
 * deployed function, the way photos-media-dev.mjs is to the CodeBuild job.
 *
 *   bun run commerce:dev                                  # serves :8787
 *   bun run commerce:listen                               # stripe -> :8787
 *   open http://localhost:8787/api/checkout?sku=<sku>
 *
 * It runs the real handler, so what passes here is the code that runs in
 * production. Keys come from Secrets Manager exactly as they do on the deployed
 * Lambda — nothing is written to disk — so this needs `aws login` first.
 *
 * It reads the *test* secret (`adamficke-com-commerce-test`), not the production
 * one. Those are separate secrets on purpose: the deployed Lambda's IAM policy
 * names only the production secret, so a laptop never holds a live key and a
 * local checkout can never take real money. Point COMMERCE_SECRET_ID elsewhere
 * to override, though it refuses outright to run against a live key.
 *
 * `stripe listen` may reissue its signing secret per session; export
 * STRIPE_WEBHOOK_SECRET to override just that field for a run.
 *
 * The catalog is read from `dist/`, so `bun run build` has to have happened —
 * but no deploy, which is what lets a photo be put on sale and bought locally.
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
 * The handler reads its environment at import time, so all of this has to be set
 * before the dynamic import below.
 */
const DEFAULT_SECRET_ID = 'adamficke-com-commerce-test';

process.env.COMMERCE_SECRET_ID ??= DEFAULT_SECRET_ID;
process.env.ORIGINALS_BUCKET ??= 'adamficke-com-originals';
process.env.SITE_BUCKET ??= 'adamficke-com-site';
process.env.SITE_URL ??= `http://localhost:${PORT}`;
process.env.EDGE_SECRET = EDGE_SECRET;

/*
 * This never runs on EC2, so the instance-metadata fallback can only ever be a
 * dead end. Left enabled, an unresolvable profile hangs for tens of seconds
 * waiting on 169.254.169.254 instead of saying the credentials are wrong.
 */
process.env.AWS_EC2_METADATA_DISABLED ??= 'true';

const secretId = process.env.COMMERCE_SECRET_ID;
const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');

/*
 * Read the secret for real, up front, for one reason the handler cannot do for
 * us: refuse to run against live keys. Nothing else about the path changes —
 * the value below is what Secrets Manager returned, and the handler still parses
 * and validates it itself.
 */
let fields;
try {
  const stored = await new SecretsManagerClient({ maxAttempts: 2 }).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  fields = JSON.parse(stored.SecretString ?? '{}');
} catch (error) {
  console.error(`commerce:dev: could not read ${secretId} — ${error.message}`);
  console.error(error.name === 'ResourceNotFoundException'
    ? '             It does not exist yet. `cd infra && terraform apply` creates it empty,\n'
      + '             then put test keys in it — see the README\'s "Selling downloads".'
    : '             Check your AWS session: `aws login`.');
  process.exit(1);
}

if (/^[sr]k_live/.test(fields.stripeApiKey ?? '')) {
  console.error(`commerce:dev: ${secretId} holds a LIVE Stripe key — refusing to run.`);
  console.error(secretId === DEFAULT_SECRET_ID
    ? `             Put test keys in ${DEFAULT_SECRET_ID}, and roll that live key: it is in the wrong secret.`
    : `             Unset COMMERCE_SECRET_ID to use ${DEFAULT_SECRET_ID}.`);
  process.exit(1);
}

/* `stripe listen` may reissue its signing secret per session. */
if (process.env.STRIPE_WEBHOOK_SECRET) {
  fields.stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  console.log('commerce:dev: using STRIPE_WEBHOOK_SECRET from the environment');
}

SecretsManagerClient.prototype.send = async () => ({ SecretString: JSON.stringify(fields) });
console.log(`commerce:dev: secrets from ${secretId}`);

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
