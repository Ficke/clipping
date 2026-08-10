import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { generatePhotoId } from '../shared/ids';
import { frontmatterValue, parsePriceDollars, type FrontmatterPhoto } from './photo-frontmatter';
import { sha256Hex } from './photo-master';

export interface AlbumFormDefaults {
  storyId: string;
  title: string;
  date: string;
  location: string;
  cover: string;
}

export interface AlbumFormAnswers extends AlbumFormDefaults {
  description?: string;
  draft?: boolean;
  photos?: FrontmatterPhoto[];
}

export interface PushPrompts {
  configureNewPhotos(files: string[]): Promise<Map<string, FrontmatterPhoto>>;
  confirmReplacement(file: string, photoId: string, stagedFile: string, existingSize: number): Promise<boolean>;
  askWhereToBuild(photoCount: number): Promise<boolean>;
  runAlbumForm(albumDirectory: string, images: string[], defaults: AlbumFormDefaults): Promise<AlbumFormAnswers>;
}

interface PromptOptions {
  interactive: boolean;
  assumeYes: boolean;
  albumsRoot: string;
  defaultPriceDollars?: number;
}

export function createPushPrompts({
  interactive,
  assumeYes,
  albumsRoot,
  defaultPriceDollars = 40,
}: PromptOptions): PushPrompts {
  async function askPhotoSale(rl: Interface, file: string): Promise<FrontmatterPhoto> {
    const photoId = generatePhotoId();
    while (true) {
      const answer = (await rl.question(`  ${file} sale price USD [not for sale] `)).trim();
      if (!answer || /^n(o)?$/i.test(answer)) return { file, photoId };
      try {
        return { file, photoId, priceDollars: parsePriceDollars(answer) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  ${message}; enter a price such as ${defaultPriceDollars}, or press Enter`);
      }
    }
  }

  async function ask(rl: Interface, label: string, fallback: string): Promise<string> {
    const shown = `  ${label.padEnd(11)}[${fallback}] `;
    const answer = (await rl.question(shown)).trim();
    return answer || fallback;
  }

  async function askRequired(rl: Interface, label: string, fallback: string): Promise<string> {
    while (true) {
      const answer = await ask(rl, label, fallback);
      if (answer) return answer;
      console.log(`  ${label} is required`);
    }
  }

  async function askCover(rl: Interface, images: string[], fallback: string): Promise<string> {
    while (true) {
      const answer = await ask(rl, 'cover', fallback);
      if (images.includes(answer)) return answer;
      console.log(`  no such photo: ${answer}`);
    }
  }

  function existingStoryIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of readdirSync(albumsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const indexPath = path.join(albumsRoot, entry.name, 'index.md');
      if (!existsSync(indexPath)) continue;
      const storyId = frontmatterValue(readFileSync(indexPath, 'utf8'), 'storyId');
      if (storyId) ids.add(storyId);
    }
    return ids;
  }

  async function askUnique(
    rl: Interface,
    label: string,
    fallback: string,
    defaults: AlbumFormDefaults,
  ): Promise<string> {
    const taken = existingStoryIds();
    let suggestion = fallback;
    if (taken.has(suggestion)) suggestion = `${fallback}-${defaults.date.slice(0, 4)}`;
    while (true) {
      const answer = slugify(await ask(rl, label, suggestion));
      if (!answer) {
        console.log('  storyId is required');
        continue;
      }
      if (taken.has(answer)) {
        console.log(`  "${answer}" is already used by another album`);
        continue;
      }
      console.log(`               → /photography/${answer}/`);
      return answer;
    }
  }

  return {
    async configureNewPhotos(files) {
      const configured = new Map<string, FrontmatterPhoto>();
      if (!interactive || !files.length) return configured;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(`\nStore settings for ${files.length} new photo${files.length === 1 ? '' : 's'}:`);
        for (const file of files) configured.set(file, await askPhotoSale(rl, file));
      } finally {
        rl.close();
      }
      return configured;
    },

    async confirmReplacement(file, photoId, stagedFile, existingSize) {
      const size = statSync(stagedFile).size;
      console.log(`\n${file} (${photoId}) already has a master with different bytes.`);
      console.log('  replacing it serves the new file to everyone who has already bought it');
      console.log(`  current: ${existingSize} bytes`);
      console.log(`  new: ${size} bytes, sha256 ${sha256Hex(stagedFile)}`);
      console.log('  the previous bytes stay recoverable for 90 days through bucket versioning');
      if (assumeYes) return true;
      if (!interactive) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question('  replace it? [no] ')).trim());
      } finally {
        rl.close();
      }
    },

    async askWhereToBuild(photoCount) {
      if (!interactive) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(`\nBuild media for ${photoCount} photo${photoCount === 1 ? '' : 's'}:`);
        console.log('  codebuild  reproducible, builds from HEAD');
        console.log('  local      faster, builds from your working tree');
        while (true) {
          const answer = (await rl.question('  where      [codebuild] ')).trim().toLowerCase();
          if (!answer || answer === 'codebuild') return false;
          if (answer === 'local') return true;
          console.log('  answer "codebuild" or "local"');
        }
      } finally {
        rl.close();
      }
    },

    async runAlbumForm(albumDirectory, images, defaults) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(`\n${path.basename(albumDirectory)} → new album, ${images.length} photo${images.length === 1 ? '' : 's'}`);
        const answers: AlbumFormAnswers = { ...defaults };
        answers.storyId = await askUnique(rl, 'storyId', defaults.storyId, defaults);
        answers.title = await askRequired(rl, 'title', defaults.title);
        answers.date = await askRequired(rl, 'date', defaults.date);
        answers.cover = await askCover(rl, images, defaults.cover);
        answers.location = await askRequired(rl, 'location', '');
        answers.description = (await rl.question('  description  [] ')).trim();
        answers.draft = /^y(es)?$/i.test((await rl.question('  draft        [no] ')).trim());
        console.log('\nStore settings:');
        answers.photos = [];
        for (const file of images) answers.photos.push(await askPhotoSale(rl, file));
        return answers;
      } finally {
        rl.close();
      }
    },
  };
}

export function slugify(value: string): string {
  return value
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
