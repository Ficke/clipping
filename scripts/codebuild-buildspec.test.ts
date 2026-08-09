import { describe, expect, test } from 'bun:test';
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
});
