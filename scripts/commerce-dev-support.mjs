import { assertStripeKeyMode, assertTableMode } from './commerce-operator.mjs';

const TABLE_PREFIX = 'adamficke-com-commerce-dev';

export function resolveDevTable(environment = process.env, pid = process.pid, now = Date.now()) {
  if (environment.COMMERCE_TABLE) {
    assertTableMode('test', environment.COMMERCE_TABLE);
    return { tableName: environment.COMMERCE_TABLE, ownsTemporaryTable: false };
  }
  const suffix = `${now.toString(36)}-${pid}`;
  return { tableName: `${TABLE_PREFIX}-${suffix}`, ownsTemporaryTable: true };
}

export function validateDevSecrets(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('The test commerce parameter must contain a JSON object.');
  }
  assertStripeKeyMode(fields.stripeApiKey, 'test');
  return fields;
}

/** Owns exactly one generated table and makes cleanup idempotent. */
export class TemporaryTableLifecycle {
  #created = false;
  #cleanup;

  constructor({ tableName, create, waitUntilReady, remove }) {
    this.tableName = tableName;
    this.create = create;
    this.waitUntilReady = waitUntilReady;
    this.remove = remove;
  }

  async start() {
    if (this.#created) throw new Error(`Temporary table ${this.tableName} is already started.`);
    // Reserve ownership before the request. If AWS creates the table but the
    // response is lost, the generated name is still ours and cleanup must be
    // attempted rather than silently orphaning it.
    this.#created = true;
    try {
      await this.create(this.tableName);
      await this.waitUntilReady(this.tableName);
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async stop() {
    if (!this.#created) return;
    if (!this.#cleanup) {
      this.#cleanup = this.remove(this.tableName).then(() => {
        this.#created = false;
      });
    }
    await this.#cleanup;
  }
}
