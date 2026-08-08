const ORDER_ID = /^ord_[a-f0-9]{32}$/;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9_]+$/;
const PRODUCTION_TABLE = /-commerce-orders$/;

export class OperatorInputError extends Error {}

export function argsWithoutSeparator(argv) {
  return argv.filter((arg) => arg !== '--');
}

export function parseReconcileArgs(argv) {
  const args = argsWithoutSeparator(argv);
  const values = parseOptions(args, new Set(['--mode', '--order']), new Set(['--dry-run']));
  const mode = values.get('--mode');
  const orderId = values.get('--order');
  if (mode !== 'test' && mode !== 'live') {
    throw new OperatorInputError('Usage: bun run commerce:reconcile -- --mode test|live [--dry-run] [--order ord_…]');
  }
  if (orderId && !ORDER_ID.test(orderId)) throw new OperatorInputError('Order ID is malformed.');
  return { mode, orderId, dryRun: values.has('--dry-run') };
}

export function parseRestoreArgs(argv) {
  const args = argsWithoutSeparator(argv);
  const orderId = args.shift();
  if (!orderId || !ORDER_ID.test(orderId)) throw restoreUsage();
  const values = parseOptions(args, new Set(['--actor', '--reason', '--mode']), new Set());
  const mode = values.get('--mode');
  const actor = bounded(values.get('--actor'), 'Actor', 200);
  const reason = bounded(values.get('--reason'), 'Reason', 1_000);
  if ((mode !== 'test' && mode !== 'live') || !actor || !reason) throw restoreUsage();
  return { orderId, actor, reason, mode };
}

export function parseLinkArgs(argv) {
  const args = argsWithoutSeparator(argv);
  if (args.length !== 1 || !SESSION_ID.test(args[0])) {
    throw new OperatorInputError('Usage: bun run commerce:link -- cs_test_… | cs_live_…');
  }
  const sessionId = args[0];
  return { sessionId, mode: sessionId.startsWith('cs_test_') ? 'test' : 'live' };
}

export function tableForMode(mode, environment = process.env) {
  const tableName = environment.COMMERCE_TABLE
    ?? (mode === 'live' ? 'adamficke-com-commerce-orders' : undefined);
  if (!tableName) throw new OperatorInputError('COMMERCE_TABLE is required in test mode.');
  assertTableMode(mode, tableName);
  return tableName;
}

export function assertTableMode(mode, tableName) {
  if (mode === 'test' && PRODUCTION_TABLE.test(tableName)) {
    throw new OperatorInputError(`Refusing to use production-shaped table ${tableName} in test mode.`);
  }
}

export function assertStripeKeyMode(key, mode) {
  if (!new RegExp(`^(?:sk|rk)_${mode}_`).test(key)) {
    throw new OperatorInputError(`Configured Stripe key is not ${mode} mode.`);
  }
  return key;
}

export function parameterNames(mode, environment = process.env) {
  return {
    buyer: environment.COMMERCE_SECRET_PARAM
      ?? (mode === 'test' ? '/adamficke-com/commerce-test' : '/adamficke-com/commerce'),
    webhook: environment.COMMERCE_WEBHOOK_SECRET_PARAM ?? '/adamficke-com/commerce-webhook',
  };
}

function parseOptions(args, valueFlags, booleanFlags) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
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

function bounded(value, label, maximum) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maximum) throw new OperatorInputError(`${label} must be at most ${maximum} characters.`);
  if (/\r|\n|\0/.test(trimmed)) throw new OperatorInputError(`${label} must be one line.`);
  return trimmed;
}

function restoreUsage() {
  return new OperatorInputError(
    'Usage: bun run commerce:restore -- ord_… --actor <value> --reason <value> --mode test|live',
  );
}
