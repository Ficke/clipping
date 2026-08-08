import { createHash } from 'node:crypto';

export type LogLevel = 'info' | 'warn' | 'error';

export interface OutcomeLog {
  outcome: string;
  route?: string;
  requestId?: string;
  status?: number;
  identifierHash?: string;
  errorCategory?: string;
}

/** Hash bearer-like identifiers before they reach application logs. */
export function hashIdentifier(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 16);
}

/**
 * Emit only an allowlisted structured record. Never pass raw errors, request
 * bodies, Stripe objects, tokens, Session IDs, or presigned URLs to this API.
 */
export function logOutcome(level: LogLevel, record: OutcomeLog): void {
  const output = JSON.stringify(record);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.info(output);
}

export function errorCategory(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return 'UnknownError';
}
