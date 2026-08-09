import { readFileSync } from 'node:fs';

/** Normalize only transport differences that do not change a YAML buildspec. */
export function normalizeBuildspec(input: string): string {
  return `${input.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
}

export function assertBuildspecsMatch(expected: string, live: string): void {
  const normalizedExpected = normalizeBuildspec(expected);
  const normalizedLive = normalizeBuildspec(live);
  if (normalizedExpected === normalizedLive) return;

  const expectedLines = normalizedExpected.split('\n');
  const liveLines = normalizedLive.split('\n');
  const line = expectedLines.findIndex((value, index) => value !== liveLines[index]) + 1;
  const expectedLine = expectedLines[line - 1] ?? '(end of file)';
  const liveLine = liveLines[line - 1] ?? '(end of file)';
  throw new Error(
    `Live CodeBuild buildspec differs from buildspec-site.yml at line ${line}. `
      + `Expected ${JSON.stringify(expectedLine)}; received ${JSON.stringify(liveLine)}. `
      + 'Apply Terraform before deploying source changes.',
  );
}

if (import.meta.main) {
  const [expectedPath, livePath] = process.argv.slice(2);
  if (!expectedPath || !livePath) {
    throw new Error('Usage: bun scripts/codebuild-buildspec.ts <expected-buildspec> <live-buildspec>');
  }
  assertBuildspecsMatch(readFileSync(expectedPath, 'utf8'), readFileSync(livePath, 'utf8'));
  console.log('PASS: live CodeBuild buildspec matches buildspec-site.yml');
}
