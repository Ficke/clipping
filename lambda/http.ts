import { timingSafeEqual } from 'node:crypto';

/** HTTP API and Lambda Function URL payload format 2.0. */
export interface HttpApiEvent {
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  requestContext: { requestId?: string; http: { method: string } };
  body?: string | null;
  isBase64Encoded?: boolean;
}

/** REST API Lambda proxy payload format 1.0. */
export interface RestApiEvent {
  path: string;
  httpMethod: string;
  headers?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  requestContext: { requestId?: string; [key: string]: unknown };
  body?: string | null;
  isBase64Encoded?: boolean;
}

/**
 * The legacy Function URL, HTTP API, and REST API all use Lambda proxy events.
 * REST proxy v1 is the only format now reaching these handlers. The v2 branch is
 * left over from the HTTP API and Function URL, both since removed, and can go.
 */
export type FunctionUrlEvent = HttpApiEvent | RestApiEvent;

export interface FunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export function method(event: FunctionUrlEvent): string {
  return isHttpApiEvent(event)
    ? event.requestContext.http.method.toUpperCase()
    : event.httpMethod.toUpperCase();
}

export function path(event: FunctionUrlEvent): string {
  return isHttpApiEvent(event) ? event.rawPath : event.path;
}

export function requestId(event: FunctionUrlEvent): string | undefined {
  return event.requestContext.requestId;
}

export function query(event: FunctionUrlEvent): URLSearchParams {
  if (isHttpApiEvent(event)) return new URLSearchParams(event.rawQueryString ?? '');

  const params = new URLSearchParams();
  if (event.multiValueQueryStringParameters) {
    for (const [name, values] of Object.entries(event.multiValueQueryStringParameters)) {
      for (const value of values ?? []) params.append(name, value);
    }
    return params;
  }
  for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) params.append(name, value);
  }
  return params;
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
  /* Proxy event sources differ in header casing; do not depend on any of them. */
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function isHttpApiEvent(event: FunctionUrlEvent): event is HttpApiEvent {
  return 'rawPath' in event;
}

/**
 * Any accepted value passes. Two are live at once so rotating the header does
 * not depend on CloudFront finishing propagation before the handlers change.
 * Every candidate is compared, without an early exit, so the work does not
 * reveal which one matched.
 */
export function hasExpectedOrigin(
  event: FunctionUrlEvent,
  name: string,
  accepted: readonly string[],
): boolean {
  const actual = header(event, name);
  if (!actual) return false;
  let matched = false;
  for (const expected of accepted) {
    if (expected.length === actual.length && timingSafeTextEqual(actual, expected)) matched = true;
  }
  return matched;
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
