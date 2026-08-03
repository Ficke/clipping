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
 * rotation, replication, and resource policies this uses none of. The payload
 * is well inside the 4 KB standard-tier limit, so this is free.
 */

export interface Env {
  secretParam: string;
  tableName: string;
  originalsBucket: string;
  siteBucket: string;
  siteUrl: string;
  allowLegacyGetCheckout: boolean;
  originHeaderName: string;
  originHeaderValue: string;
}

export interface WebhookEnv {
  secretParam: string;
  tableName: string;
  originHeaderName: string;
  originHeaderValue: string;
}

export interface Secrets {
  /** Restricted API key (`rk_`), scoped to Checkout Sessions. */
  stripeApiKey: string;
  /**
   * Environment-specific Stripe Product carrying the Managed Payments tax
   * classification. It is not secret, but keeping it beside the key prevents a
   * sandbox function from ever naming a live Product (or vice versa).
   */
  stripeProductId: string;
  /** HMAC key for download entitlement tokens. Rotating it voids live links. */
  downloadTokenKey: string;
}

export interface WebhookSecrets {
  /** Restricted live-mode key with read-only access to commerce objects. */
  stripeReadApiKey: string;
  /** Current endpoint signing secret. */
  stripeWebhookSecret: string;
  /** Previous secret accepted only during an intentional overlap window. */
  stripeWebhookSecretPrevious?: string;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const required = (name: string): string => {
    const value = source[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const legacyGet = required('COMMERCE_ALLOW_LEGACY_GET_CHECKOUT');
  if (legacyGet !== 'true' && legacyGet !== 'false') {
    throw new Error('COMMERCE_ALLOW_LEGACY_GET_CHECKOUT must be true or false');
  }
  return {
    secretParam: required('COMMERCE_SECRET_PARAM'),
    tableName: required('COMMERCE_TABLE'),
    originalsBucket: required('ORIGINALS_BUCKET'),
    siteBucket: required('SITE_BUCKET'),
    siteUrl: required('SITE_URL').replace(/\/$/, ''),
    allowLegacyGetCheckout: legacyGet === 'true',
    originHeaderName: required('ORIGIN_VERIFY_HEADER_NAME'),
    originHeaderValue: required('ORIGIN_VERIFY_HEADER_VALUE'),
  };
}

export function readWebhookEnv(source: NodeJS.ProcessEnv = process.env): WebhookEnv {
  const required = (name: string): string => {
    const value = source[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  return {
    secretParam: required('COMMERCE_WEBHOOK_SECRET_PARAM'),
    tableName: required('COMMERCE_TABLE'),
    originHeaderName: required('ORIGIN_VERIFY_HEADER_NAME'),
    originHeaderValue: required('ORIGIN_VERIFY_HEADER_VALUE'),
  };
}

const SECRET_FIELDS = [
  'stripeApiKey',
  'stripeProductId',
  'downloadTokenKey',
] as const;

export function parseSecrets(payload: string): Secrets {
  return parseSecretObject(payload, SECRET_FIELDS, (record) => {
    if (!/^prod_[A-Za-z0-9]+$/.test(record.stripeProductId)) {
      throw new Error('Commerce secret stripeProductId is not a Stripe Product ID');
    }
  });
}

const WEBHOOK_SECRET_FIELDS = [
  'stripeReadApiKey',
  'stripeWebhookSecret',
] as const;

export function parseWebhookSecrets(payload: string): WebhookSecrets {
  const parsed = parseSecretObject(payload, WEBHOOK_SECRET_FIELDS);
  const record = JSON.parse(payload) as Record<string, unknown>;
  const previous = record.stripeWebhookSecretPrevious;
  if (previous !== undefined && (typeof previous !== 'string' || !previous)) {
    throw new Error('Commerce webhook secret stripeWebhookSecretPrevious is invalid');
  }
  return { ...parsed, ...(typeof previous === 'string' && { stripeWebhookSecretPrevious: previous }) };
}

function parseSecretObject<const Fields extends readonly string[]>(
  payload: string,
  fields: Fields,
  validate?: (record: Record<Fields[number], string>) => void,
): Record<Fields[number], string> {
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
  const missing = fields.filter((field) => typeof record[field] !== 'string' || !record[field]);
  if (missing.length) {
    /* Names only. The values are the thing we are protecting. */
    throw new Error(`Commerce secret is missing: ${missing.join(', ')}`);
  }
  const result = Object.fromEntries(fields.map((field) => [field, record[field]])) as Record<Fields[number], string>;
  validate?.(result);
  return result;
}

const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const cached = new Map<string, { loadedAt: number; value: Promise<unknown> }>();

/**
 * Cached for the life of the execution environment. A rotation therefore takes
 * effect as containers recycle rather than instantly.
 */
export function loadSecrets(
  env: Env,
  client = new SSMClient({}),
  now = Date.now(),
): Promise<Secrets> {
  return loadParameter(env.secretParam, parseSecrets, client, now);
}

export function loadWebhookSecrets(
  parameterName: string,
  client = new SSMClient({}),
  now = Date.now(),
): Promise<WebhookSecrets> {
  return loadParameter(parameterName, parseWebhookSecrets, client, now);
}

function loadParameter<T>(
  parameterName: string,
  parse: (payload: string) => T,
  client: SSMClient,
  now: number,
): Promise<T> {
  const hit = cached.get(parameterName);
  if (hit && now - hit.loadedAt < SECRET_CACHE_TTL_MS) return hit.value as Promise<T>;

  const value = client
    /* WithDecryption, or a SecureString comes back as ciphertext. */
    .send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))
    .then((response) => {
      const value = response.Parameter?.Value;
      if (!value) throw new Error('Commerce secret parameter has no value');
      return parse(value);
    })
    .catch((error) => {
      /* Do not cache a failure: the next invocation should retry. */
      cached.delete(parameterName);
      throw error;
    });
  cached.set(parameterName, { loadedAt: now, value });
  return value;
}

/** Resets the module cache. Tests only. */
export function forgetSecrets(): void {
  cached.clear();
}
