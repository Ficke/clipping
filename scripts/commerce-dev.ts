/**
 * Serve the built site and production commerce handler on localhost:8787.
 * The server reads the test SSM parameter, rejects live Stripe keys, and uses a
 * temporary DynamoDB table. Run `aws login` and `bun run build` first.
 */

import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveDevTable,
  TemporaryTableLifecycle,
  validateDevSecrets,
  type DevSecrets,
} from './commerce-dev-support.ts';
import type { FunctionUrlEvent, FunctionUrlResult } from '../lambda/http';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.COMMERCE_PORT ?? process.env.PORT ?? 8787);
const HOST = '127.0.0.1';
const MAX_REQUEST_BODY_BYTES = 1_048_576;

/*
 * The handler reads its environment at import time, so all of this has to be set
 * before the dynamic import below.
 */
const DEFAULT_SECRET_PARAM = '/adamficke-com/commerce-test';

process.env.COMMERCE_SECRET_PARAM ??= DEFAULT_SECRET_PARAM;
let tableConfig;
try {
  tableConfig = resolveDevTable();
} catch (error) {
  console.error(`commerce:dev: ${error instanceof Error ? error.message : 'Invalid table configuration.'}`);
  process.exit(1);
}
const { ownsTemporaryTable, tableName } = tableConfig;
process.env.COMMERCE_TABLE = tableName;
process.env.ORIGINALS_BUCKET ??= 'adamficke-com-originals';
process.env.SITE_BUCKET ??= 'adamficke-com-site';
process.env.SITE_URL ??= `http://localhost:${PORT}`;
process.env.ORIGIN_VERIFY_HEADER_NAME ??= 'x-commerce-origin';
process.env.ORIGIN_VERIFY_HEADER_VALUES ??= 'local-commerce-origin';

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
let fields: DevSecrets;
try {
  const stored = await new SSMClient({ maxAttempts: 2 }).send(
    new GetParameterCommand({ Name: secretParam, WithDecryption: true }),
  );
  fields = JSON.parse(stored.Parameter?.Value ?? '{}');
} catch (error) {
  /* SSM returns ParameterNotFound with no message body, so lead with the name. */
  const missing = typeof error === 'object' && error !== null && 'name' in error && error.name === 'ParameterNotFound';
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`commerce:dev: could not read ${secretParam} — ${missing ? 'no such parameter' : message}`);
  console.error(missing
    ? '             `cd infra && terraform apply` creates it holding {}, then put\n'
      + '             test keys in it — see docs/commerce-operations.md.'
    : '             Check your AWS session: `aws login`.');
  process.exit(1);
}

if (/^[sr]k_live/.test(fields?.stripeApiKey ?? '')) {
  console.error(`commerce:dev: ${secretParam} holds a LIVE Stripe key — refusing to run.`);
  console.error(secretParam === DEFAULT_SECRET_PARAM
    ? `             Put test keys in ${DEFAULT_SECRET_PARAM}, and roll that live key: it is in the wrong parameter.`
    : `             Unset COMMERCE_SECRET_PARAM to use ${DEFAULT_SECRET_PARAM}.`);
  process.exit(1);
}
try {
  validateDevSecrets(fields);
} catch (error) {
  console.error(`commerce:dev: ${error instanceof Error ? error.message : 'Invalid test secret.'}`);
  process.exit(1);
}

Object.assign(SSMClient.prototype, {
  send: async () => ({ Parameter: { Value: JSON.stringify(fields) } }),
});
console.log(`commerce:dev: secrets from ${secretParam}`);

const {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} = await import('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
const dynamo = new DynamoDBClient({ maxAttempts: 2 });
interface Termination { signal?: 'SIGINT' | 'SIGTERM'; error?: Error }
let tableLifecycle: TemporaryTableLifecycle | undefined;
let requestedTermination: Termination | undefined;
let resolveStopping!: (termination: Termination) => void;
const stopping = new Promise<Termination>((resolve) => { resolveStopping = resolve; });
const stopServer = (termination: Termination): void => {
  requestedTermination ??= termination;
  resolveStopping(requestedTermination);
};
process.once('SIGINT', () => stopServer({ signal: 'SIGINT' }));
process.once('SIGTERM', () => stopServer({ signal: 'SIGTERM' }));
let server: Server | undefined;

try {
if (ownsTemporaryTable) {
  tableLifecycle = new TemporaryTableLifecycle({
    tableName: process.env.COMMERCE_TABLE,
    create: async (name) => { await dynamo.send(new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'orderId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
      Tags: [
        { Key: 'application', Value: 'adamficke-com' },
        { Key: 'purpose', Value: 'local-commerce-acceptance' },
      ],
    })); },
    waitUntilReady: async (name) => { await waitUntilTableExists(
      { client: dynamo, maxWaitTime: 60 },
      { TableName: name },
    ); },
    remove: async (name) => { await dynamo.send(new DeleteTableCommand({ TableName: name })); },
  });
  await tableLifecycle.start();
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
Object.assign(S3Client.prototype, { send(command: unknown, ...rest: unknown[]) {
  if (command instanceof GetObjectCommand && command.input.Key === 'downloads-catalog.json') {
    if (!existsSync(localCatalog)) {
      throw new Error(`commerce:dev: ${localCatalog} is missing — run \`bun run build\` first`);
    }
    const body = readFileSync(localCatalog, 'utf8');
    return Promise.resolve({ Body: { transformToString: async () => body } });
  }
  return Reflect.apply(realSend, this, [command, ...rest]);
} });

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

const MIME: Record<string, string> = {
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
function serveStatic(url: URL, response: ServerResponse): void {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/downloads-catalog.json') {
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end('Not found.');
    return;
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
    response.end(body);
    return;
  }

  response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
}

const originHeaderName = process.env.ORIGIN_VERIFY_HEADER_NAME!;
const originHeaderValues = process.env.ORIGIN_VERIFY_HEADER_VALUES!.split(',');

const activeServer = server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let bodyTooLarge = false;
  request.on('data', (chunk: Buffer) => {
    if (bodyTooLarge) return;
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
      bodyTooLarge = true;
      chunks.length = 0;
      response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      response.end('Request body too large.');
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', async () => {
    if (bodyTooLarge) return;
    const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
    const body = Buffer.concat(chunks);

    if (!url.pathname.startsWith('/api/')) return serveStatic(url, response);

    const requestHeaders: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      requestHeaders[name] = Array.isArray(value) ? value.join(',') : value;
    }
    const lambdaEvent: FunctionUrlEvent = {
      rawPath: url.pathname,
      rawQueryString: url.searchParams.toString(),
      headers: {
        ...requestHeaders,
        [originHeaderName]: originHeaderValues[0],
      },
      requestContext: { http: { method: request.method ?? 'GET' } },
      body: body.length ? body.toString('utf8') : undefined,
      isBase64Encoded: false,
    };
    const invocation = url.pathname.replace(/\/$/, '') === '/api/stripe-webhook'
      ? handleWebhook(lambdaEvent, {
          originHeaderName,
          originHeaderValues,
          orders: webhookOrders,
          loadSecrets: async () => ({
            stripeReadApiKey: fields.stripeApiKey,
            stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
          }),
          stripeFor: () => webhookStripe,
        })
      : handler(lambdaEvent);
    const result: FunctionUrlResult = await invocation.catch((error) => {
      console.error(`commerce:dev: request failed (${error instanceof Error ? error.name : 'UnknownError'})`);
      return { statusCode: 500, body: JSON.stringify({ error: 'Local commerce request failed.' }) } satisfies FunctionUrlResult;
    });

    console.log(`${request.method} ${url.pathname} -> ${result.statusCode}`);
    response.writeHead(result.statusCode, result.headers ?? {});
    response.end(result.body ?? '');
  });
});

await new Promise<void>((resolve, reject) => {
  const startupError = (error: Error) => reject(error);
  activeServer.once('error', startupError);
  activeServer.listen(PORT, HOST, () => {
    activeServer.off('error', startupError);
    resolve();
  });
});
console.log(`commerce:dev serving dist/ and the store on http://${HOST}:${PORT}`);
if (!existsSync(path.join(repoRoot, 'dist', 'index.html'))) {
  console.log('  note:      dist/ is empty — run `bun run build`');
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.log('  webhook:   set STRIPE_WEBHOOK_SECRET from `stripe listen` before testing events');
}
activeServer.once('error', (error) => stopServer({ error }));
const termination = await stopping;
if (termination.error) throw termination.error;
} catch (error) {
  console.error(`commerce:dev: stopped after ${error instanceof Error ? error.name : 'UnknownError'}`);
  process.exitCode = 1;
} finally {
  const closingServer = server;
  if (closingServer?.listening) await new Promise<void>((resolve) => closingServer.close(() => resolve()));
  if (tableLifecycle) {
    try {
      await tableLifecycle.stop();
      console.log(`commerce:dev: deleted temporary table ${process.env.COMMERCE_TABLE}`);
    } catch (error) {
      console.error(`commerce:dev: could not delete ${process.env.COMMERCE_TABLE}: ${error instanceof Error ? error.name : 'UnknownError'}`);
      process.exitCode = 1;
    }
  }
}
