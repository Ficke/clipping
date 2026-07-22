import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = path.join(repoRoot, 'node_modules');
const localCache = path.join(nodeModules, '.astro');
const sharedCache = 's3://adamficke-com-originals/cache/astro';

if (!existsSync(nodeModules)) {
  fail('Dependencies are missing; run bun install first');
}

console.log(`Pulling ${sharedCache} -> ${localCache}`);
run('aws', ['s3', 'sync', sharedCache, localCache, '--size-only', '--delete']);

console.log('\nBuilding the site to generate missing image transforms');
run('bun', ['run', 'build']);

console.log(`\nPushing ${localCache} -> ${sharedCache}`);
run('aws', ['s3', 'sync', localCache, sharedCache, '--size-only']);

console.log('\nShared Astro image cache is warm. Nothing was deployed or committed.');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  console.error(`photos:prewarm: ${message}`);
  process.exit(1);
}
