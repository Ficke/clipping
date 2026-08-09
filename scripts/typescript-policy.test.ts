import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Temporary migration allowlist. Every conversion should remove an entry;
 * adding a new authored JavaScript file must fail CI.
 */
const LEGACY_JAVASCRIPT = [
  'scripts/commerce-dev.mjs',
  'scripts/commerce-link.mjs',
  'scripts/commerce-reconcile.mjs',
  'scripts/commerce-restore.mjs',
] as const;

describe('source language policy', () => {
  test('authored JavaScript is limited to the shrinking migration allowlist', () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const result = Bun.spawnSync(['git', 'ls-files', '*.js', '*.mjs', '*.cjs'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not inspect tracked source files: ${result.stderr.toString().trim()}`);
    }

    const tracked = result.stdout.toString().trim().split('\n')
      // Repository-assistant skills are vendored tooling, not application source.
      .filter((file) => file && !file.startsWith('.claude/') && existsSync(path.join(repoRoot, file)))
      .sort();
    expect(tracked).toEqual([...LEGACY_JAVASCRIPT].sort());
  });
});
