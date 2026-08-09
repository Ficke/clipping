import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PushProcess } from './photos-push-process';

const terminalBuildStatuses = new Set(['FAILED', 'FAULT', 'STOPPED', 'SUCCEEDED', 'TIMED_OUT']);

export interface SourceBundle {
  directory: string;
  key: string;
}

interface CodeBuildOptions {
  manifestRoot: string;
  buildBucket: string;
  mediaProject: string;
  pollInterval: number;
  process: PushProcess;
}

export interface PushCodeBuild {
  createSourceBundle(): SourceBundle;
  publishMedia(storyId: string, albumDirectory: string, sourceBundle: SourceBundle): Promise<void>;
}

export function createPushCodeBuild({
  manifestRoot,
  buildBucket,
  mediaProject,
  pollInterval,
  process: commands,
}: CodeBuildOptions): PushCodeBuild {
  async function waitForBuild(buildId: string): Promise<string> {
    while (true) {
      const status = commands.capture('aws', [
        'codebuild', 'batch-get-builds', '--ids', buildId,
        '--query', 'builds[0].buildStatus', '--output', 'text',
      ]);
      if (terminalBuildStatuses.has(status)) return status;
      await delay(pollInterval);
    }
  }

  return {
    createSourceBundle() {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'photos-push-'));
      const archive = path.join(directory, 'source.zip');
      const commit = commands.capture('git', ['rev-parse', 'HEAD']);
      commands.run('git', ['archive', '--format=zip', `--output=${archive}`, 'HEAD']);
      const key = `source/${commit}.zip`;
      console.log(`\nUploading build source to s3://${buildBucket}/${key}`);
      commands.run('aws', ['s3', 'cp', archive, `s3://${buildBucket}/${key}`, '--only-show-errors']);
      return { directory, key };
    },

    async publishMedia(storyId, albumDirectory, sourceBundle) {
      console.log(`Starting ${mediaProject} for ${storyId}`);
      const buildId = commands.capture('aws', [
        'codebuild', 'start-build',
        '--project-name', mediaProject,
        '--source-type-override', 'S3',
        '--source-location-override', `${buildBucket}/${sourceBundle.key}`,
        '--environment-variables-override', `name=ALBUM_ID,value=${storyId},type=PLAINTEXT`,
        '--query', 'build.id', '--output', 'text',
      ]);
      console.log(`Waiting for ${buildId}`);
      const status = await waitForBuild(buildId);
      if (status !== 'SUCCEEDED') throw new Error(`Media build ${buildId} finished with ${status}`);

      const manifestPath = path.join(albumDirectory, 'photos.json');
      commands.run('aws', [
        's3', 'cp', `${manifestRoot}/${storyId}/photos.json`, manifestPath,
        '--only-show-errors',
      ]);
      console.log(`Created ${manifestPath}`);
    },
  };
}
