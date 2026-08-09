import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'deploy.yml'), 'utf8');
const buildspec = readFileSync(path.join(repoRoot, 'buildspec-site.yml'), 'utf8');

describe('site deployment contract', () => {
  test('runs the buildspec shipped in the deployed source archive', () => {
    expect(workflow).toContain('--source-location-override "adamficke-com-builds/source/${GITHUB_SHA}.zip"');
    expect(workflow).toContain('--buildspec-override buildspec-site.yml');
    expect(workflow).not.toContain('codebuild batch-get-projects');
  });

  test('uses the Node 24 AWS credential action', () => {
    expect(workflow).toContain(
      'uses: aws-actions/configure-aws-credentials@451ce2a72e8d729a59ebeaacab82dbce58e7af4c # v6',
    );
  });

  test('reports media cleanup separately from site deployment', () => {
    expect(buildspec).toContain('if ! MEDIA_BUCKET="$MEDIA_BUCKET" bun scripts/photos-gc.ts; then');
    expect(buildspec).toContain('WARNING: site deployed, but obsolete media cleanup failed');
  });
});
