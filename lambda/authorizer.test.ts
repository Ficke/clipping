import { afterEach, describe, expect, test } from 'bun:test';
import { handler } from './authorizer';

const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:api123/commerce/POST/api/checkout';
const CURRENT = 'a'.repeat(48);
const NEXT = 'b'.repeat(48);

afterEach(() => {
  delete process.env.ORIGIN_VERIFY_HEADER_VALUES;
});

function authorize(authorizationToken: string | undefined) {
  return handler({ type: 'TOKEN', authorizationToken, methodArn: METHOD_ARN });
}

describe('commerce origin authorizer', () => {
  test('allows the origin value across the API stage for cache reuse', async () => {
    process.env.ORIGIN_VERIFY_HEADER_VALUES = CURRENT;

    expect(await authorize(CURRENT)).toEqual({
      principalId: 'cloudfront-origin',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'execute-api:Invoke',
          Effect: 'Allow',
          Resource: 'arn:aws:execute-api:us-east-1:123456789012:api123/commerce/*/api/*',
        }],
      },
    });
  });

  /* CloudFront sends one value; both stay valid so propagation cannot 403. */
  test('allows either value while a rotation propagates', async () => {
    process.env.ORIGIN_VERIFY_HEADER_VALUES = `${CURRENT},${NEXT}`;

    for (const submitted of [CURRENT, NEXT]) {
      const result = await authorize(submitted);
      expect(result.policyDocument.Statement[0]?.Effect).toBe('Allow');
    }
    expect((await authorize('c'.repeat(48))).policyDocument.Statement[0]?.Effect).toBe('Deny');
  });

  test('denies a missing, mismatched, or unconfigured value', async () => {
    for (const [configured, submitted] of [
      [CURRENT, undefined],
      [CURRENT, NEXT],
      ['', CURRENT],
      [`${CURRENT},${NEXT}`, ''],
      /* A separator alone must not degrade into an empty accepted value. */
      [',', ''],
      [',', 'anything'],
    ] as const) {
      process.env.ORIGIN_VERIFY_HEADER_VALUES = configured;
      const result = await authorize(submitted);
      expect(result.policyDocument.Statement[0]?.Effect).toBe('Deny');
    }
  });
});
