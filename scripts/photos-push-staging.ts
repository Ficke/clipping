import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseMetadataSidecar, parseSourceManifest } from '../shared/media';
import { ensureMaster, putSidecar, sha256Hex } from './photo-master';
import type { PushProcess } from './photos-push-process';
import type { PushPrompts } from './photos-push-prompts';

interface StagingOptions {
  repoRoot: string;
  stagingRoot: string;
  originalsBucket: string;
  mediaBucket: string;
  manifestBucket: string;
  dryRun: boolean;
  prompts: PushPrompts;
  process: PushProcess;
}

export interface StagedAlbum {
  directory: string;
  metadataDirectory: string;
}

export interface PushStaging {
  writeSourceManifest(storyId: string, photoIds: Map<string, string>): string;
  stageAlbum(storyId: string, albumDirectory: string, sourceManifestPath: string): StagedAlbum;
  publishMasters(staged: StagedAlbum, storyId: string, photoIds: Map<string, string>): Promise<void>;
  publishMediaLocally(
    storyId: string,
    albumDirectory: string,
    staged: StagedAlbum,
    sourceManifestPath: string,
  ): Promise<void>;
}

export function createPushStaging({
  repoRoot,
  stagingRoot,
  originalsBucket,
  mediaBucket,
  manifestBucket,
  dryRun,
  prompts,
  process: commands,
}: StagingOptions): PushStaging {
  return {
    writeSourceManifest(storyId, photoIds) {
      const manifestPath = path.join(stagingRoot, `${storyId}-source.json`);
      const photos = [...photoIds].map(([file, photoId]) => ({ photoId, file }));
      const manifest = parseSourceManifest({ version: 1, album: storyId, photos }, 'generated source manifest');
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return manifestPath;
    },

    stageAlbum(storyId, albumDirectory, sourceManifestPath) {
      const directory = path.join(stagingRoot, storyId);
      const metadataDirectory = path.join(stagingRoot, `${storyId}-metadata`);
      mkdirSync(directory, { recursive: true });
      mkdirSync(metadataDirectory, { recursive: true });
      console.log(`\nPreparing metadata-minimized fulfillment files for ${storyId}`);
      commands.run('bun', [
        path.join(repoRoot, 'scripts', 'photos-sanitize.ts'),
        '--source', albumDirectory,
        '--output', directory,
        '--metadata', metadataDirectory,
        '--source-manifest', sourceManifestPath,
      ]);
      return { directory, metadataDirectory };
    },

    async publishMasters(staged, storyId, photoIds) {
      if (dryRun) {
        console.log(`Would publish ${photoIds.size} master${photoIds.size === 1 ? '' : 's'} and their metadata sidecars`);
        return;
      }

      const counts = { uploaded: 0, replaced: 0, reused: 0 };
      for (const [file, photoId] of photoIds) {
        const stagedFile = path.join(staged.directory, file);
        const call = {
          bucket: originalsBucket,
          file: stagedFile,
          photoId,
          album: storyId,
          filename: file,
          sourceHash: sha256Hex(stagedFile),
        };
        let result = ensureMaster(call);
        if (result.action === 'differs') {
          if (!await prompts.confirmReplacement(file, photoId, stagedFile)) {
            throw new Error(`Refusing to replace the master for ${file}`);
          }
          result = ensureMaster({ ...call, replace: true });
        }
        if (result.action !== 'differs') counts[result.action]++;

        const sidecar = path.join(staged.metadataDirectory, `${file}.json`);
        const parsed = parseMetadataSidecar(JSON.parse(readFileSync(sidecar, 'utf8')), sidecar);
        if (parsed.shot) putSidecar({ bucket: originalsBucket, photoId, body: sidecar });
      }
      console.log(`Masters: ${counts.uploaded} uploaded, ${counts.replaced} replaced, ${counts.reused} unchanged`);
    },

    async publishMediaLocally(storyId, albumDirectory, staged, sourceManifestPath) {
      const manifestPath = path.join(albumDirectory, 'photos.json');
      console.log(`Building ${storyId} locally`);
      await commands.runAsync('bun', [
        path.join(repoRoot, 'scripts', 'photos-build-media.ts'),
        '--source', staged.directory,
        '--source-manifest', sourceManifestPath,
        '--source-metadata', staged.metadataDirectory,
        '--album', storyId,
        '--manifest', manifestPath,
      ], { env: { MEDIA_BUCKET: mediaBucket, MANIFEST_BUCKET: manifestBucket } });
      console.log(`Created ${manifestPath}`);
    },
  };
}
