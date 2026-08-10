import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const workflowsDirectory = path.resolve(import.meta.dir, '..', '.github', 'workflows');

describe('workflow supply-chain policy', () => {
  test('pins every external action to a full commit SHA', () => {
    for (const file of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = readFileSync(path.join(workflowsDirectory, file), 'utf8');
      const references = [...workflow.matchAll(/^\s*-\s+uses:\s+[^@\s]+@([^\s#]+)/gm)];
      expect(references.length, `${file} should use at least one external action`).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference[1], `${file} contains an unpinned action`).toMatch(/^[a-f0-9]{40}$/);
      }
    }
  });
});
