import { timingSafeEqual } from 'node:crypto';

interface TokenAuthorizerEvent {
  type: 'TOKEN';
  authorizationToken?: string;
  methodArn: string;
}

interface AuthorizerPolicy {
  principalId: string;
  policyDocument: {
    Version: '2012-10-17';
    Statement: Array<{
      Action: 'execute-api:Invoke';
      Effect: 'Allow' | 'Deny';
      Resource: string;
    }>;
  };
}

/**
 * API Gateway validates the CloudFront token against an exact regular
 * expression before this function runs. Repeat the comparison here so a
 * configuration drift cannot turn the authorizer into an unconditional allow.
 * Never log the submitted or expected token.
 */
export async function handler(event: TokenAuthorizerEvent): Promise<AuthorizerPolicy> {
  const expected = process.env.COMMERCE_GATEWAY_TOKEN ?? '';
  const allowed = Boolean(expected)
    && Boolean(event.authorizationToken)
    && timingSafeTextEqual(event.authorizationToken!, expected);

  return policy(allowed ? 'Allow' : 'Deny', event.methodArn);
}

function policy(effect: 'Allow' | 'Deny', methodArn: string): AuthorizerPolicy {
  const [apiArn, stage] = methodArn.split('/');
  const resource = apiArn && stage ? `${apiArn}/${stage}/*/api/*` : methodArn;
  return {
    principalId: 'cloudfront-origin',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
    },
  };
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
