import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAlbumManager, type PreparedAlbum } from './photos-push-albums';
import { createPushCodeBuild, type SourceBundle } from './photos-push-codebuild';
import { createPushProcess } from './photos-push-process';
import { createPushPrompts } from './photos-push-prompts';
import { createPushStaging } from './photos-push-staging';

const repoRoot = path.resolve(import.meta.dir, '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const manifestRoot = 's3://adamficke-com-originals/manifests';
const buildBucket = 'adamficke-com-builds';
const mediaProject = 'adamficke-com-media';
const mediaBucket = 'adamficke-com-media';
const manifestBucket = 'adamficke-com-originals';
const originalsBucket = 'adamficke-com-originals';

interface PushArguments {
  album?: string;
  dryRun: boolean;
  assumeYes: boolean;
  forceLocal: boolean;
}

function parseArguments(values: string[]): PushArguments {
  const args = values.filter((arg) => arg !== '--');
  const dryRun = args.includes('--dry-run');
  const assumeYes = args.includes('--yes');
  const forceLocal = args.includes('--local');
  const flags = new Set(['--dry-run', '--yes', '--local']);
  const positional = args.filter((arg) => !flags.has(arg));
  if (positional.length > 1 || args.some((arg) => arg.startsWith('--') && !flags.has(arg))) {
    throw new Error('Usage: bun run photos:push -- [album-folder] [--dry-run] [--yes] [--local]');
  }
  return { album: positional[0], dryRun, assumeYes, forceLocal };
}

function requireAwsSession(): void {
  const result = spawnSync('aws', ['sts', 'get-caller-identity'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) throw new Error(`Could not run aws: ${result.error.message}`);
  if (result.status !== 0) throw new Error('AWS session is not valid. Run `aws login` first.');
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const interactive = (Boolean(process.stdin.isTTY) || process.env.PHOTOS_PUSH_PROMPT === '1')
    && !args.dryRun
    && !args.assumeYes;
  if (!args.dryRun) requireAwsSession();

  const commands = createPushProcess(repoRoot);
  const prompts = createPushPrompts({
    interactive,
    assumeYes: args.assumeYes,
    albumsRoot,
  });
  const albums = createAlbumManager({
    albumsRoot,
    manifestRoot,
    dryRun: args.dryRun,
    interactive,
    prompts,
    process: commands,
  });

  const source = albums.resolveSource(args.album);
  const preparedAlbums: PreparedAlbum[] = [];
  for (const albumDirectory of albums.albumDirectories(source)) {
    const prepared = await albums.prepareAlbum(albumDirectory);
    if (prepared) preparedAlbums.push(prepared);
  }
  if (!preparedAlbums.length) throw new Error(`No supported images found in ${source}`);

  const photoCount = preparedAlbums.reduce((total, album) => total + album.images.length, 0);
  const buildLocally = args.dryRun ? false : args.forceLocal || await prompts.askWhereToBuild(photoCount);
  const stagingRoot = mkdtempSync(path.join(os.tmpdir(), 'photos-master-'));
  const staging = createPushStaging({
    repoRoot,
    stagingRoot,
    originalsBucket,
    mediaBucket,
    manifestBucket,
    dryRun: args.dryRun,
    prompts,
    process: commands,
  });
  const codeBuild = createPushCodeBuild({
    manifestRoot,
    buildBucket,
    mediaProject,
    pollInterval: Number.parseInt(process.env.PHOTO_BUILD_POLL_INTERVAL_MS ?? '5000', 10),
    process: commands,
  });

  let sourceBundle: SourceBundle | undefined;
  try {
    for (const { albumDirectory, storyId, photoIds } of preparedAlbums) {
      const sourceManifestPath = staging.writeSourceManifest(storyId, photoIds);
      const staged = staging.stageAlbum(storyId, albumDirectory, sourceManifestPath);
      console.log(`\n${args.dryRun ? 'Previewing' : 'Publishing'} ${photoIds.size} master${photoIds.size === 1 ? '' : 's'} for ${storyId}`);
      await staging.publishMasters(staged, storyId, photoIds);

      const manifestArgs = [
        's3', 'cp', sourceManifestPath, `${manifestRoot}/${storyId}/source.json`,
        '--content-type', 'application/json', '--only-show-errors',
      ];
      if (args.dryRun) manifestArgs.push('--dryrun');
      await commands.runAsync('aws', manifestArgs);

      if (args.dryRun) {
        console.log(`Would build immutable media and write ${path.relative(repoRoot, albumDirectory)}/photos.json`);
      } else if (buildLocally) {
        await staging.publishMediaLocally(storyId, albumDirectory, staged, sourceManifestPath);
      } else {
        sourceBundle ??= codeBuild.createSourceBundle();
        await codeBuild.publishMedia(storyId, albumDirectory, sourceBundle);
      }
    }
  } finally {
    if (sourceBundle) rmSync(sourceBundle.directory, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`photos:push: ${message}`);
  process.exit(1);
}
