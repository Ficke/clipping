import {
  checkoutSessionMode,
  isCheckoutSessionId,
  isOrderId,
  type CheckoutSessionId,
  type CommerceMode,
  type OrderId,
} from '../shared/ids';

const PRODUCTION_TABLE = /-commerce-orders$/;

type Environment = Readonly<Record<string, string | undefined>>;
type OptionValue = string | true;

export interface ReconcileArgs {
  mode: CommerceMode;
  orderId?: OrderId;
  dryRun: boolean;
}

export interface RestoreArgs {
  orderId: OrderId;
  actor: string;
  reason: string;
  mode: CommerceMode;
}

export interface LinkArgs {
  sessionId: CheckoutSessionId;
  mode: CommerceMode;
}

export class OperatorInputError extends Error {}

export function argsWithoutSeparator(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== '--');
}

export function parseReconcileArgs(argv: readonly string[]): ReconcileArgs {
  const args = argsWithoutSeparator(argv);
  const values = parseOptions(args, new Set(['--mode', '--order']), new Set(['--dry-run']));
  const mode = stringValue(values.get('--mode'));
  const orderId = stringValue(values.get('--order'));
  if (mode !== 'test' && mode !== 'live') {
    throw new OperatorInputError('Usage: bun run commerce:reconcile -- --mode test|live [--dry-run] [--order ord_…]');
  }
  if (orderId && !isOrderId(orderId)) throw new OperatorInputError('Order ID is malformed.');
  return { mode, ...(orderId ? { orderId } : {}), dryRun: values.has('--dry-run') };
}

export function parseRestoreArgs(argv: readonly string[]): RestoreArgs {
  const args = argsWithoutSeparator(argv);
  const orderId = args.shift();
  if (!isOrderId(orderId)) throw restoreUsage();
  const values = parseOptions(args, new Set(['--actor', '--reason', '--mode']), new Set());
  const mode = stringValue(values.get('--mode'));
  const actor = bounded(stringValue(values.get('--actor')), 'Actor', 200);
  const reason = bounded(stringValue(values.get('--reason')), 'Reason', 1_000);
  if ((mode !== 'test' && mode !== 'live') || !actor || !reason) throw restoreUsage();
  return { orderId, actor, reason, mode };
}

export function parseLinkArgs(argv: readonly string[]): LinkArgs {
  const args = argsWithoutSeparator(argv);
  const sessionId = args[0];
  if (args.length !== 1 || !isCheckoutSessionId(sessionId)) {
    throw new OperatorInputError('Usage: bun run commerce:link -- cs_test_… | cs_live_…');
  }
  return { sessionId, mode: checkoutSessionMode(sessionId)! };
}

export function tableForMode(mode: CommerceMode, environment: Environment = process.env): string {
  const tableName = environment.COMMERCE_TABLE
    ?? (mode === 'live' ? 'adamficke-com-commerce-orders' : undefined);
  if (!tableName) throw new OperatorInputError('COMMERCE_TABLE is required in test mode.');
  assertTableMode(mode, tableName);
  return tableName;
}

export function assertTableMode(mode: CommerceMode, tableName: string): void {
  if (mode === 'test' && PRODUCTION_TABLE.test(tableName)) {
    throw new OperatorInputError(`Refusing to use production-shaped table ${tableName} in test mode.`);
  }
}

export function assertStripeKeyMode(key: unknown, mode: CommerceMode): string {
  if (typeof key !== 'string' || !new RegExp(`^(?:sk|rk)_${mode}_`).test(key)) {
    throw new OperatorInputError(`Configured Stripe key is not ${mode} mode.`);
  }
  return key;
}

export function parameterNames(mode: CommerceMode, environment: Environment = process.env): {
  buyer: string;
  webhook: string;
} {
  return {
    buyer: environment.COMMERCE_SECRET_PARAM
      ?? (mode === 'test' ? '/adamficke-com/commerce-test' : '/adamficke-com/commerce'),
    webhook: environment.COMMERCE_WEBHOOK_SECRET_PARAM ?? '/adamficke-com/commerce-webhook',
  };
}

function parseOptions(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
): Map<string, OptionValue> {
  const values = new Map<string, OptionValue>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (values.has(flag)) throw new OperatorInputError(`Duplicate argument: ${flag}`);
    if (booleanFlags.has(flag)) {
      values.set(flag, true);
      continue;
    }
    if (!valueFlags.has(flag)) throw new OperatorInputError(`Unknown argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new OperatorInputError(`Missing value for ${flag}.`);
    values.set(flag, value);
    index += 1;
  }
  return values;
}

function stringValue(value: OptionValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bounded(value: string | undefined, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maximum) throw new OperatorInputError(`${label} must be at most ${maximum} characters.`);
  if (/\r|\n|\0/.test(trimmed)) throw new OperatorInputError(`${label} must be one line.`);
  return trimmed;
}

function restoreUsage(): OperatorInputError {
  return new OperatorInputError(
    'Usage: bun run commerce:restore -- ord_… --actor <value> --reason <value> --mode test|live',
  );
}
