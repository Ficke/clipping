import { describe, expect, test } from 'bun:test';
import {
  constantTimeEquals,
  EDGE_SECRET_HEADER,
  fromEdge,
  header,
  method,
  problem,
  query,
  rawBody,
  redirect,
  type FunctionUrlEvent,
} from './http';

function request(overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    rawPath: '/api/checkout',
    rawQueryString: '',
    headers: {},
    requestContext: { http: { method: 'GET' } },
    ...overrides,
  };
}

describe('request parsing', () => {
  test('normalises the method', () => {
    expect(method(request({ requestContext: { http: { method: 'post' } } }))).toBe('POST');
  });

  test('reads the query string', () => {
    const event = request({ rawQueryString: 'sku=lost-coast%2FDSCF1250.jpg%2Fpersonal' });
    expect(query(event).get('sku')).toBe('lost-coast/DSCF1250.jpg/personal');
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
  });

  test('treats a missing body as empty', () => {
    expect(rawBody(request())).toBe('');
  });
});

describe('edge gating', () => {
  const secret = 's'.repeat(48);

  test('accepts a request carrying the shared secret', () => {
    expect(fromEdge(request({ headers: { [EDGE_SECRET_HEADER]: secret } }), secret)).toBe(true);
  });

  test('refuses a request that reached the Function URL directly', () => {
    expect(fromEdge(request(), secret)).toBe(false);
  });

  test('refuses a wrong secret, including a prefix of the right one', () => {
    expect(fromEdge(request({ headers: { [EDGE_SECRET_HEADER]: 's'.repeat(47) } }), secret)).toBe(false);
    expect(fromEdge(request({ headers: { [EDGE_SECRET_HEADER]: `${secret}x` } }), secret)).toBe(false);
  });

  test('compares unequal lengths without throwing', () => {
    expect(constantTimeEquals('short', 'much longer value')).toBe(false);
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
    expect(JSON.parse(problem(400, 'Missing sku.').body!)).toEqual({ error: 'Missing sku.' });
  });
});
