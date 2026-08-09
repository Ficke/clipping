import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';

describe('source language policy', () => {
  test('authored executable code contains no JavaScript', () => {
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
      .filter((file) => file && existsSync(path.join(repoRoot, file)))
      .sort();
    expect(tracked).toEqual([]);
  });
});
