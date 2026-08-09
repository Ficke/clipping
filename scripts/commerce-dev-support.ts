import { assertStripeKeyMode, assertTableMode } from './commerce-operator';

const TABLE_PREFIX = 'adamficke-com-commerce-dev';

type Environment = Readonly<Record<string, string | undefined>>;

export interface DevSecrets extends Record<string, unknown> {
  stripeApiKey: string;
}

export function resolveDevTable(
  environment: Environment = process.env,
  pid = process.pid,
  now = Date.now(),
): { tableName: string; ownsTemporaryTable: boolean } {
  if (environment.COMMERCE_TABLE) {
    assertTableMode('test', environment.COMMERCE_TABLE);
    return { tableName: environment.COMMERCE_TABLE, ownsTemporaryTable: false };
  }
  const suffix = `${now.toString(36)}-${pid}`;
  return { tableName: `${TABLE_PREFIX}-${suffix}`, ownsTemporaryTable: true };
}

export function validateDevSecrets(fields: unknown): DevSecrets {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('The test commerce parameter must contain a JSON object.');
  }
  const record = fields as Record<string, unknown>;
  const stripeApiKey = assertStripeKeyMode(record.stripeApiKey, 'test');
  return { ...record, stripeApiKey };
}

type TableOperation = (tableName: string) => Promise<void>;

export interface TemporaryTableLifecycleOptions {
  tableName: string;
  create: TableOperation;
  waitUntilReady: TableOperation;
  remove: TableOperation;
}

/** Owns exactly one generated table and makes cleanup idempotent. */
export class TemporaryTableLifecycle {
  readonly tableName: string;
  readonly create: TableOperation;
  readonly waitUntilReady: TableOperation;
  readonly remove: TableOperation;

  #created = false;
  #cleanup: Promise<void> | undefined;

  constructor({ tableName, create, waitUntilReady, remove }: TemporaryTableLifecycleOptions) {
    this.tableName = tableName;
    this.create = create;
    this.waitUntilReady = waitUntilReady;
    this.remove = remove;
  }

  async start(): Promise<void> {
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

  async stop(): Promise<void> {
    if (!this.#created) return;
    if (!this.#cleanup) {
      this.#cleanup = this.remove(this.tableName).then(() => {
        this.#created = false;
      });
    }
    await this.#cleanup;
  }
}
