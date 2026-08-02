/**
 * Runs the commerce Lambda on localhost so the money path can be exercised
 * without a `terraform apply` between every edit. The local counterpart to the
 * deployed function, the way photos-media-dev.mjs is to the CodeBuild job.
 *
 *   bun run commerce:dev                                  # serves :8787
 *   open http://localhost:8787/api/checkout?photo_id=<photo_id>
 *
 * It runs the real handler, so what passes here is the code that runs in
 * production. Keys come from Parameter Store exactly as they do on the deployed
 * Lambda — nothing is written to disk — so this needs `aws login` first.
 *
 * It reads the *test* parameter (`/adamficke-com/commerce-test`), not the
 * production one. Those are separate parameters on purpose: the deployed
 * Lambda's IAM policy names only the production one, so a laptop never holds a
 * live key and a local checkout can never take real money. Point
 * COMMERCE_SECRET_PARAM elsewhere to override, though it refuses outright to
 * run against a live key.
 *
 * The catalog is read from `dist/`, so `bun run build` has to have happened —
 * but no deploy, which is what lets a photo be put on sale and bought locally.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.COMMERCE_PORT ?? process.env.PORT ?? 8787);

/*
 * The handler reads its environment at import time, so all of this has to be set
 * before the dynamic import below.
 */
const DEFAULT_SECRET_PARAM = '/adamficke-com/commerce-test';

process.env.COMMERCE_SECRET_PARAM ??= DEFAULT_SECRET_PARAM;
const ownsTemporaryTable = !process.env.COMMERCE_TABLE;
process.env.COMMERCE_TABLE ??= `adamficke-com-commerce-dev-${process.pid}`;
process.env.ORIGINALS_BUCKET ??= 'adamficke-com-originals';
process.env.SITE_BUCKET ??= 'adamficke-com-site';
process.env.SITE_URL ??= `http://localhost:${PORT}`;
process.env.ORIGIN_VERIFY_HEADER_NAME ??= 'x-commerce-origin';
process.env.ORIGIN_VERIFY_HEADER_VALUE ??= 'local-commerce-origin';

/*
 * This never runs on EC2, so the instance-metadata fallback can only ever be a
 * dead end. Left enabled, an unresolvable profile hangs for tens of seconds
 * waiting on 169.254.169.254 instead of saying the credentials are wrong.
 */
process.env.AWS_EC2_METADATA_DISABLED ??= 'true';

const secretParam = process.env.COMMERCE_SECRET_PARAM;
const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');

/*
 * Read the secret for real, up front, for one reason the handler cannot do for
 * us: refuse to run against live keys. Nothing else about the path changes —
 * the value below is what Parameter Store returned, and the handler still parses
 * and validates it itself.
 */
let fields;
try {
  const stored = await new SSMClient({ maxAttempts: 2 }).send(
    new GetParameterCommand({ Name: secretParam, WithDecryption: true }),
  );
  fields = JSON.parse(stored.Parameter?.Value ?? '{}');
} catch (error) {
  /* SSM returns ParameterNotFound with no message body, so lead with the name. */
  const missing = error.name === 'ParameterNotFound';
  console.error(`commerce:dev: could not read ${secretParam} — ${missing ? 'no such parameter' : error.message}`);
  console.error(missing
    ? '             `cd infra && terraform apply` creates it holding {}, then put\n'
      + '             test keys in it — see the README\'s "Selling downloads".'
    : '             Check your AWS session: `aws login`.');
  process.exit(1);
}

if (/^[sr]k_live/.test(fields.stripeApiKey ?? '')) {
  console.error(`commerce:dev: ${secretParam} holds a LIVE Stripe key — refusing to run.`);
  console.error(secretParam === DEFAULT_SECRET_PARAM
    ? `             Put test keys in ${DEFAULT_SECRET_PARAM}, and roll that live key: it is in the wrong parameter.`
    : `             Unset COMMERCE_SECRET_PARAM to use ${DEFAULT_SECRET_PARAM}.`);
  process.exit(1);
}

SSMClient.prototype.send = async () => ({ Parameter: { Value: JSON.stringify(fields) } });
console.log(`commerce:dev: secrets from ${secretParam}`);

const {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} = await import('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
const dynamo = new DynamoDBClient({ maxAttempts: 2 });
if (ownsTemporaryTable) {
  await dynamo.send(new CreateTableCommand({
    TableName: process.env.COMMERCE_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'orderId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
  }));
  await waitUntilTableExists({ client: dynamo, maxWaitTime: 60 }, { TableName: process.env.COMMERCE_TABLE });
  console.log(`commerce:dev: temporary table ${process.env.COMMERCE_TABLE}`);
  console.log(`  cleanup: aws dynamodb delete-table --table-name ${process.env.COMMERCE_TABLE}`);
}

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
const { handleWebhook } = await import('../lambda/webhook.ts');
const { DynamoOrderRepository } = await import('../lambda/order-repository.ts');
const { STRIPE_API_VERSION } = await import('../lambda/integration.ts');
const { default: Stripe } = await import('stripe');
const webhookStripe = new Stripe(fields.stripeApiKey, { apiVersion: STRIPE_API_VERSION });
const webhookOrders = new DynamoOrderRepository(
  process.env.COMMERCE_TABLE,
  DynamoDBDocumentClient.from(dynamo),
);

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
  if (pathname === '/downloads-catalog.json') {
    response.writeHead(404, { 'cache-control': 'no-store' });
    return response.end('Not found.');
  }
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

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    const body = Buffer.concat(chunks);

    if (!url.pathname.startsWith('/api/')) return serveStatic(url, response);

    const lambdaEvent = {
      rawPath: url.pathname,
      rawQueryString: url.searchParams.toString(),
      headers: {
        ...request.headers,
        [process.env.ORIGIN_VERIFY_HEADER_NAME]: process.env.ORIGIN_VERIFY_HEADER_VALUE,
      },
      requestContext: { http: { method: request.method } },
      body: body.length ? body.toString('utf8') : undefined,
      isBase64Encoded: false,
    };
    const invocation = url.pathname.replace(/\/$/, '') === '/api/stripe-webhook'
      ? handleWebhook(lambdaEvent, {
          originHeaderName: process.env.ORIGIN_VERIFY_HEADER_NAME,
          originHeaderValue: process.env.ORIGIN_VERIFY_HEADER_VALUE,
          orders: webhookOrders,
          loadSecrets: async () => ({
            stripeReadApiKey: fields.stripeApiKey,
            stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
          }),
          stripeFor: () => webhookStripe,
        })
      : handler(lambdaEvent);
    const result = await invocation.catch((error) => {
      console.error(error);
      return { statusCode: 500, body: JSON.stringify({ error: 'Local commerce request failed.' }) };
    });

    console.log(`${request.method} ${url.pathname} -> ${result.statusCode}`);
    response.writeHead(result.statusCode, result.headers ?? {});
    response.end(result.body ?? '');
  });
});

server.listen(PORT, () => {
  console.log(`commerce:dev serving dist/ and the store on http://localhost:${PORT}`);
  if (!existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
    console.log('  note:      dist/ is empty — run `bun run build`');
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.log('  webhook:   set STRIPE_WEBHOOK_SECRET from `stripe listen` before testing events');
  }
});

let cleaning = false;
async function cleanup(signal) {
  if (cleaning) return;
  cleaning = true;
  await new Promise((resolve) => server.close(resolve));
  if (ownsTemporaryTable) {
    try {
      await dynamo.send(new DeleteTableCommand({ TableName: process.env.COMMERCE_TABLE }));
      console.log(`commerce:dev: deleted temporary table ${process.env.COMMERCE_TABLE}`);
    } catch (error) {
      console.error(`commerce:dev: could not delete ${process.env.COMMERCE_TABLE}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (signal) process.exit();
}

process.once('SIGINT', () => void cleanup('SIGINT'));
process.once('SIGTERM', () => void cleanup('SIGTERM'));
