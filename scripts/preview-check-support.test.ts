import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parsePreviewArguments,
  previewUrl,
  PRODUCTION_CSP,
} from './preview-check-support';

describe('preview tooling', () => {
  test('parses one route and an explicit set of flags', () => {
    expect(parsePreviewArguments(['/album/', '--csp'], {
      defaultRoute: '/',
      allowedFlags: ['--csp'],
    })).toEqual({ route: '/album/', flags: new Set(['--csp']) });
    expect(() => parsePreviewArguments(['album'], { defaultRoute: '/' })).toThrow('must start with');
    expect(() => parsePreviewArguments(['--unknown'], { defaultRoute: '/' })).toThrow('Unknown option');
  });

  test('keeps routes on the configured preview origin', () => {
    expect(new URL(previewUrl('/album?existing=1', true)).pathname).toBe('/album');
    expect(new URL(previewUrl('/album?existing=1', true)).searchParams.has('ga-debug')).toBe(true);
    expect(() => previewUrl('//example.com/')).toThrow('must stay on');
  });

  test('replays the exact production content security policy', () => {
    const terraform = readFileSync(path.resolve(import.meta.dir, '..', 'infra', 'main.tf'), 'utf8');
    const block = terraform.match(/content_security_policy = join\("; ", \[([\s\S]*?)\n\s*\]\)/)?.[1];
    if (!block) throw new Error('Could not find content_security_policy in infra/main.tf');
    const directives = [...block.matchAll(/^\s*"([^"]+)",/gm)].map((match) => match[1]);
    expect(PRODUCTION_CSP).toBe(directives.join('; '));
  });
});
