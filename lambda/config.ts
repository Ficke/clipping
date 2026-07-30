import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * Configuration comes from two places, split by sensitivity.
 *
 * Non-secret wiring (bucket names, the canonical site URL) arrives as Lambda
 * environment variables, where it is visible in the console and in Terraform.
 * Everything that would be damaging to leak lives in one KMS-encrypted SSM
 * `SecureString` parameter, fetched once per execution environment. Stripe keys
 * in particular must never sit in environment variables: they are readable by
 * anything that can describe the function.
 *
 * Parameter Store rather than Secrets Manager: both encrypt with KMS and gate on
 * IAM identically, but Secrets Manager bills $0.40 per secret per month for
 * rotation, replication, and resource policies this uses none of. At 283 bytes
 * against a 4 KB standard-tier limit, this is free.
 */

export interface Env {
  secretParam: string;
  originalsBucket: string;
  siteBucket: string;
  siteUrl: string;
  /** Verified SES identity. When unset, delivery emails are skipped. */
  fromEmail: string | undefined;
  /**
   * Shared secret CloudFront adds as a custom origin header. The Function URL is
   * reachable from the internet, so this is what keeps requests that skipped
   * CloudFront — and therefore skipped the canonical host, the access logs, and
   * the response headers policy — from being served.
   *
   * It sits here rather than in Parameter Store for two reasons: Terraform has
   * to know it anyway to configure the CloudFront origin, and reading it from an
   * environment variable means an unauthenticated request is refused without
   * spending a Parameter Store call. It authenticates a hop between two things
   * we own, not access to anyone's money.
   */
  edgeSecret: string;
}

export interface Secrets {
  /** Restricted API key (`rk_`), scoped to Checkout Sessions. */
  stripeApiKey: string;
  /** Signing secret for the webhook endpoint (`whsec_`). */
  stripeWebhookSecret: string;
  /** HMAC key for download entitlement tokens. Rotating it voids live links. */
  downloadTokenKey: string;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const required = (name: string): string => {
    const value = source[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  return {
    secretParam: required('COMMERCE_SECRET_PARAM'),
    originalsBucket: required('ORIGINALS_BUCKET'),
    siteBucket: required('SITE_BUCKET'),
    siteUrl: required('SITE_URL').replace(/\/$/, ''),
    fromEmail: source.FROM_EMAIL || undefined,
    edgeSecret: required('EDGE_SECRET'),
  };
}

const SECRET_FIELDS = [
  'stripeApiKey',
  'stripeWebhookSecret',
  'downloadTokenKey',
] as const;

export function parseSecrets(payload: string): Secrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    /* Terraform creates the parameter holding `{}`; a bare placeholder lands here. */
    throw new Error('Commerce secret is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Commerce secret is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const missing = SECRET_FIELDS.filter((field) => typeof record[field] !== 'string' || !record[field]);
  if (missing.length) {
    /* Names only. The values are the thing we are protecting. */
    throw new Error(`Commerce secret is missing: ${missing.join(', ')}`);
  }
  return Object.fromEntries(SECRET_FIELDS.map((field) => [field, record[field]])) as unknown as Secrets;
}

let cached: Promise<Secrets> | undefined;

/**
 * Cached for the life of the execution environment. A rotation therefore takes
 * effect as containers recycle rather than instantly; for the webhook secret
 * that means keeping both old and new registered in Stripe during a rotation.
 */
export function loadSecrets(env: Env, client = new SSMClient({})): Promise<Secrets> {
  cached ??= client
    /* WithDecryption, or a SecureString comes back as ciphertext. */
    .send(new GetParameterCommand({ Name: env.secretParam, WithDecryption: true }))
    .then((response) => {
      const value = response.Parameter?.Value;
      if (!value) throw new Error('Commerce secret parameter has no value');
      return parseSecrets(value);
    })
    .catch((error) => {
      /* Do not cache a failure: the next invocation should retry. */
      cached = undefined;
      throw error;
    });
  return cached;
}
