import { describe, expect, test } from 'bun:test';
import {
  header,
  hasExpectedOrigin,
  method,
  methodNotAllowed,
  path,
  problem,
  query,
  rawBody,
  rawBodyBytes,
  redirect,
  type HttpApiEvent,
  type RestApiEvent,
} from './http';

function request(overrides: Partial<HttpApiEvent> = {}): HttpApiEvent {
  return {
    rawPath: '/api/checkout',
    rawQueryString: '',
    headers: {},
    requestContext: { http: { method: 'GET' } },
    ...overrides,
  };
}

function restRequest(overrides: Partial<RestApiEvent> = {}): RestApiEvent {
  return {
    path: '/api/checkout',
    httpMethod: 'GET',
    headers: {},
    requestContext: { requestId: 'rest-request-1' },
    ...overrides,
  };
}

describe('request parsing', () => {
  test('normalises the method', () => {
    expect(method(request({ requestContext: { http: { method: 'post' } } }))).toBe('POST');
    expect(method(restRequest({ httpMethod: 'post' }))).toBe('POST');
  });

  test('normalises the path across proxy payload versions', () => {
    expect(path(request())).toBe('/api/checkout');
    expect(path(restRequest())).toBe('/api/checkout');
  });

  test('reads the query string', () => {
    const event = request({ rawQueryString: 'photo_id=photo_1234567890abcdef12345678' });
    expect(query(event).get('photo_id')).toBe('photo_1234567890abcdef12345678');
  });

  test('preserves duplicate REST API query fields', () => {
    const event = restRequest({
      queryStringParameters: { photo_id: 'last' },
      multiValueQueryStringParameters: { photo_id: ['first', 'last'] },
    });
    expect(query(event).getAll('photo_id')).toEqual(['first', 'last']);
  });

  test('finds a header regardless of case', () => {
    const event = request({ headers: { 'Stripe-Signature': 't=1,v1=abc' } });
    expect(header(event, 'stripe-signature')).toBe('t=1,v1=abc');
  });

  test('returns the exact bytes of a plain body', () => {
    expect(rawBody(request({ body: '{"id":"evt_1"}' }))).toBe('{"id":"evt_1"}');
  });

  test('decodes a base64 body without re-encoding it', () => {
    const payload = '{"id":"evt_1","note":"café — ünïcode"}';
    const event = request({
      body: Buffer.from(payload, 'utf8').toString('base64'),
      isBase64Encoded: true,
    });
    expect(rawBody(event)).toBe(payload);
    expect(rawBodyBytes(event)).toEqual(Buffer.from(payload));

    const restEvent = restRequest({
      body: Buffer.from(payload, 'utf8').toString('base64'),
      isBase64Encoded: true,
    });
    expect(rawBody(restEvent)).toBe(payload);
    expect(rawBodyBytes(restEvent)).toEqual(Buffer.from(payload));
  });

  test('treats a missing body as empty', () => {
    expect(rawBody(request())).toBe('');
  });

  test('checks the CloudFront origin header without depending on casing', () => {
    const event = request({ headers: { 'X-Commerce-Origin': 'expected-value' } });
    expect(hasExpectedOrigin(event, 'x-commerce-origin', 'expected-value')).toBe(true);
    expect(hasExpectedOrigin(event, 'x-commerce-origin', 'different-value')).toBe(false);
  });
});

describe('responses', () => {
  test('never lets a payment response be cached', () => {
    for (const response of [problem(404, 'Not found.'), redirect('https://checkout.stripe.com/c/pay/cs_test')]) {
      expect(response.headers?.['cache-control']).toBe('no-store, private');
    }
  });

  test('redirects with 303 by default so a browser follows it as a GET', () => {
    expect(redirect('https://example.test/').statusCode).toBe(303);
    expect(redirect('https://example.test/', 302).statusCode).toBe(302);
  });

  test('carries a message and nothing else', () => {
    expect(JSON.parse(problem(400, 'Missing photo_id.').body!)).toEqual({ error: 'Missing photo_id.' });
  });

  test('returns an Allow header for known paths with the wrong method', () => {
    expect(methodNotAllowed('POST')).toEqual({
      statusCode: 405,
      headers: {
        allow: 'POST',
        'cache-control': 'no-store, private',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ error: 'Method not allowed.' }),
    });
  });
});
