import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertBuildspecsMatch, normalizeBuildspec } from './codebuild-buildspec';

describe('CodeBuild buildspec preflight', () => {
  test('normalizes line endings and terminal blank lines from AWS CLI output', () => {
    expect(normalizeBuildspec('version: 0.2\n')).toBe('version: 0.2\n');
    expect(normalizeBuildspec('version: 0.2\r\n\r\n')).toBe('version: 0.2\n');
    expect(() => assertBuildspecsMatch('version: 0.2\n', 'version: 0.2\n\n')).not.toThrow();
  });

  test('refuses a substantive difference in the active buildspec', () => {
    expect(() => assertBuildspecsMatch(
      'MEDIA_BUCKET="$MEDIA_BUCKET" bun scripts/photos-gc.ts\n',
      'MEDIA_BUCKET="$MEDIA_BUCKET" bun scripts/photos-gc.mjs\n',
    )).toThrow('photos-gc.ts');
  });

  test('provisions Bun before the deploy preflight invokes it', () => {
    const workflow = readFileSync(path.resolve(import.meta.dir, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
    const bunSetup = workflow.indexOf('uses: oven-sh/setup-bun@v2');
    const preflight = workflow.indexOf('bun scripts/codebuild-buildspec.ts');
    expect(bunSetup).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(bunSetup);
  });
});
