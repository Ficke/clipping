import { afterEach, describe, expect, test } from 'bun:test';
import { handler } from './authorizer';

const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:api123/commerce/POST/api/checkout';

afterEach(() => {
  delete process.env.COMMERCE_GATEWAY_TOKEN;
});

describe('commerce origin authorizer', () => {
  test('allows the exact gateway token across the API stage for cache reuse', async () => {
    process.env.COMMERCE_GATEWAY_TOKEN = 'a'.repeat(64);
    const result = await handler({
      type: 'TOKEN',
      authorizationToken: 'a'.repeat(64),
      methodArn: METHOD_ARN,
    });
    expect(result).toEqual({
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

  test('denies a missing, mismatched, or unconfigured token', async () => {
    for (const [expected, actual] of [
      ['a'.repeat(64), undefined],
      ['a'.repeat(64), 'b'.repeat(64)],
      ['', 'a'.repeat(64)],
    ] as const) {
      process.env.COMMERCE_GATEWAY_TOKEN = expected;
      const result = await handler({
        type: 'TOKEN',
        authorizationToken: actual,
        methodArn: METHOD_ARN,
      });
      expect(result.policyDocument.Statement[0]?.Effect).toBe('Deny');
    }
  });
});
