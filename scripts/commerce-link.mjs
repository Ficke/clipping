/**
 * Mint a fresh download entitlement for a paid, non-refunded purchase.
 * This is deliberately a local operator command: there is no public admin API.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { S3Client } from '@aws-sdk/client-s3';
import Stripe from 'stripe';
import { loadCatalog } from '../lambda/catalog.ts';
import { parseSecrets } from '../lambda/config.ts';
import { STRIPE_API_VERSION } from '../lambda/integration.ts';
import { reissueDownload } from '../lambda/reissue.ts';

const sessionId = process.argv[2];
if (!sessionId || !/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(sessionId)) {
  console.error('Usage: bun run commerce:link -- cs_test_… | cs_live_…');
  process.exit(1);
}
const mode = sessionId.startsWith('cs_test_') ? 'test' : 'live';

process.env.AWS_EC2_METADATA_DISABLED ??= 'true';

const secretParam = process.env.COMMERCE_SECRET_PARAM
  ?? (mode === 'test' ? '/adamficke-com/commerce-test' : '/adamficke-com/commerce');
const siteBucket = process.env.SITE_BUCKET ?? 'adamficke-com-site';
const siteUrl = (process.env.SITE_URL
  ?? (mode === 'test' ? 'http://localhost:8787' : 'https://adamficke.com')).replace(/\/$/, '');

let secrets;
try {
  const stored = await new SSMClient({ maxAttempts: 2 }).send(
    new GetParameterCommand({ Name: secretParam, WithDecryption: true }),
  );
  secrets = parseSecrets(stored.Parameter?.Value ?? '{}');
} catch (error) {
  console.error(`commerce:link: could not read ${secretParam}: ${error.message}`);
  console.error('               Check your AWS session with `aws login`.');
  process.exit(1);
}

if (!new RegExp(`^[sr]k_${mode}_`).test(secrets.stripeApiKey)) {
  console.error(`commerce:link: ${secretParam} does not contain a ${mode} Stripe key.`);
  process.exit(1);
}

try {
  const stripe = new Stripe(secrets.stripeApiKey, { apiVersion: STRIPE_API_VERSION });
  const catalog = await loadCatalog(siteBucket, new S3Client({ maxAttempts: 2 }));
  const fulfillment = await reissueDownload(sessionId, {
    stripe,
    catalog,
    siteUrl,
    downloadTokenKey: secrets.downloadTokenKey,
  });

  console.log(`Purchase: ${fulfillment.item?.albumTitle} — ${fulfillment.item?.file}`);
  console.log(`Expires:  ${new Date(fulfillment.expiresAt * 1000).toLocaleString()}`);
  console.log(`Link:     ${fulfillment.downloadUrl}`);
} catch (error) {
  console.error(`commerce:link: refused to issue a link: ${error.message}`);
  process.exit(1);
}
