import { timingSafeEqual } from 'node:crypto';

/**
 * The Lambda Function URL payload (format 2.0) and the small amount of HTTP
 * plumbing the routes need. Kept separate from the routes so both can be
 * tested without an AWS client in scope.
 */

export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  requestContext: { requestId?: string; http: { method: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export function method(event: FunctionUrlEvent): string {
  return event.requestContext.http.method.toUpperCase();
}

export function query(event: FunctionUrlEvent): URLSearchParams {
  return new URLSearchParams(event.rawQueryString ?? '');
}

/**
 * Stripe signs the exact bytes it sent, so the body must be recovered without
 * re-encoding. Function URLs base64 the body whenever they consider it binary,
 * which includes any request without a recognized text content type.
 */
export function rawBody(event: FunctionUrlEvent): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

export function rawBodyBytes(event: FunctionUrlEvent): Buffer {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');
}

export function header(event: FunctionUrlEvent, name: string): string | undefined {
  /* Function URLs lower-case header names, but do not depend on that. */
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function hasExpectedOrigin(
  event: FunctionUrlEvent,
  name: string,
  expected: string,
): boolean {
  const actual = header(event, name);
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeTextEqual(actual, expected);
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

const NO_STORE = {
  'cache-control': 'no-store, private',
} as const;

export function json(statusCode: number, data: unknown): FunctionUrlResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...NO_STORE },
    body: JSON.stringify(data),
  };
}

/** 303, so a browser follows a POST-initiated redirect as a GET. */
export function redirect(location: string, statusCode = 303): FunctionUrlResult {
  return { statusCode, headers: { location, ...NO_STORE } };
}

/**
 * Error responses carry a human sentence and nothing else. Stack traces, IDs
 * that failed to parse, and bucket names go to CloudWatch, not to the client.
 */
export function problem(statusCode: number, message: string): FunctionUrlResult {
  return json(statusCode, { error: message });
}

export function methodNotAllowed(allow: string): FunctionUrlResult {
  const response = problem(405, 'Method not allowed.');
  response.headers = { ...response.headers, allow };
  return response;
}
