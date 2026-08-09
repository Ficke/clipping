import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import { generatePhotoId } from '../shared/ids';
import {
  frontmatterValue,
  readPhotosBlock,
  serializePhotos,
  splitFrontmatter,
  type FrontmatterPhoto,
} from './photo-frontmatter';
import type { PushProcess } from './photos-push-process';
import { slugify, type AlbumFormAnswers, type AlbumFormDefaults, type PushPrompts } from './photos-push-prompts';

const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const unsupportedPhotoExtensions = new Set([
  '.bmp', '.dng', '.gif', '.heic', '.heif', '.raf', '.raw', '.tif', '.tiff',
]);
const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export interface PreparedAlbum {
  albumDirectory: string;
  images: string[];
  storyId: string;
  photoIds: Map<string, string>;
}

interface AlbumManagerOptions {
  albumsRoot: string;
  manifestRoot: string;
  dryRun: boolean;
  interactive: boolean;
  prompts: PushPrompts;
  process: PushProcess;
}

export interface AlbumManager {
  resolveSource(input?: string): string;
  albumDirectories(source: string): string[];
  prepareAlbum(albumDirectory: string): Promise<PreparedAlbum | undefined>;
}

export function createAlbumManager({
  albumsRoot,
  manifestRoot,
  dryRun,
  interactive,
  prompts,
  process: commands,
}: AlbumManagerOptions): AlbumManager {
  function assertStoryIdAvailable(storyId: string): void {
    const listing = commands.capture('aws', ['s3', 'ls', `${manifestRoot}/${storyId}/`], { allowFailure: true });
    if (listing) {
      throw new Error(`s3 already has ${manifestRoot}/${storyId}/ — choose a different storyId or remove the prefix`);
    }
  }

  async function reconcilePhotos(contents: string, images: string[], album: string): Promise<{
    contents: string;
    entries: FrontmatterPhoto[];
  }> {
    const { lines, body } = splitFrontmatter(contents, album);
    const { entries, span } = readPhotosBlock(lines);
    const known = new Map(entries.map((entry) => [entry.file, entry]));
    const removed = entries.filter((entry) => entry.removed);
    const live = entries.filter((entry) => !entry.removed);
    const vanished = live.filter((entry) => !images.includes(entry.file));
    if (vanished.length) {
      throw new Error(`${album}: ${vanished.map((entry) => entry.file).join(', ')} ${vanished.length === 1 ? 'is' : 'are'} missing from the album folder. `
        + 'Run `bun run photos:remove` to take a photograph out of an album, or put the file back.');
    }

    const added = images.filter((file) => !known.has(file));
    const configured = await prompts.configureNewPhotos(added);
    const mint = (file: string): FrontmatterPhoto => configured.get(file) ?? { file, photoId: generatePhotoId() };
    const wasFilenameOrdered = live.length === 0
      || live.map((entry) => entry.file).join('\0') === sortFilenames(live.map((entry) => entry.file)).join('\0');
    const next = wasFilenameOrdered
      ? sortFilenames([...live.map((entry) => entry.file), ...added]).map((file) => known.get(file) ?? mint(file))
      : [...live, ...added.map(mint)];

    if (added.length) {
      console.log(`  adding ${added.length}: ${added.join(', ')}${wasFilenameOrdered ? '' : ' (appended — reorder if needed)'}`);
    }

    const rebuilt = [...lines];
    const entriesOut = [...next, ...removed];
    const block = serializePhotos(entriesOut);
    if (span) rebuilt.splice(span[0], span[1] - span[0], ...block);
    else rebuilt.push(...block);
    return { contents: `---\n${rebuilt.join('\n')}\n---\n${body}`, entries: entriesOut };
  }

  async function scaffoldIndex(albumDirectory: string, images: string[]): Promise<{
    contents: string;
    storyId: string;
    entries: FrontmatterPhoto[];
  }> {
    const folder = path.basename(albumDirectory);
    const match = folder.match(/^(?:(\d{4})-(\d{2})-)?(.+)$/);
    if (!match) throw new Error(`Cannot derive album defaults from folder name: ${folder}`);
    const [, year, month, rawSlug] = match;
    const title = rawSlug!
      .split(/[-_]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toLocaleUpperCase('en') + word.slice(1))
      .join(' ');
    const fallbackDate = year ? `${year}-${month}-01` : new Date().toISOString().slice(0, 10);
    const date = await photoDate(path.join(albumDirectory, images[0]!)) ?? fallbackDate;
    const defaults: AlbumFormDefaults = {
      storyId: slugify(rawSlug!),
      title,
      date,
      location: '',
      cover: images[0]!,
    };
    if (!defaults.storyId) throw new Error(`Cannot derive a storyId from folder name: ${folder}`);
    const answers: AlbumFormAnswers = interactive
      ? await prompts.runAlbumForm(albumDirectory, images, defaults)
      : defaults;
    if (!dryRun) assertStoryIdAvailable(answers.storyId);

    const lines = [
      `storyId: ${JSON.stringify(answers.storyId)}`,
      `title: ${JSON.stringify(answers.title)}`,
      `date: ${answers.date}`,
      `published: ${new Date().toISOString().slice(0, 10)}`,
      `location: ${JSON.stringify(answers.location)}`,
    ];
    if (answers.cover !== images[0]) lines.push(`cover: ${answers.cover}`);
    if (answers.description) lines.push(`description: ${JSON.stringify(answers.description)}`);
    if (answers.draft) lines.push('draft: true');
    const entries = answers.photos ?? images.map((file) => ({ file, photoId: generatePhotoId() }));
    lines.push(...serializePhotos(entries));
    return { contents: `---\n${lines.join('\n')}\n---\n`, storyId: answers.storyId, entries };
  }

  return {
    resolveSource(input) {
      if (!input) return albumsRoot;
      const candidate = input.includes(path.sep) || path.isAbsolute(input)
        ? path.resolve(process.cwd(), input)
        : path.join(albumsRoot, input);
      const relative = path.relative(albumsRoot, candidate);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
        throw new Error('Album folder must be a direct child of content/albums');
      }
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
        throw new Error(`Album folder does not exist: ${candidate}`);
      }
      return candidate;
    },

    albumDirectories(source) {
      return source === albumsRoot
        ? readdirSync(albumsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(albumsRoot, entry.name))
        : [source];
    },

    async prepareAlbum(albumDirectory) {
      const entries = readdirSync(albumDirectory, { withFileTypes: true });
      const nestedImages = entries
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => findImageFiles(path.join(albumDirectory, entry.name)));
      if (nestedImages.length) throw new Error(`Images must be directly inside ${albumDirectory}, not nested in subfolders`);

      const candidates = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
        .filter((file) => supportedExtensions.has(path.extname(file).toLowerCase()));
      const unsupported = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
        .filter((file) => unsupportedPhotoExtensions.has(path.extname(file).toLowerCase()));
      if (unsupported.length) {
        throw new Error(`Unsupported photo format in ${albumDirectory}: ${unsupported.join(', ')}. Export as JPEG, PNG, WebP, or AVIF.`);
      }
      if (!candidates.length) return undefined;

      const normalizedNames = new Map<string, string>();
      for (const file of candidates) {
        const extension = path.extname(file);
        const normalized = `${file.slice(0, -extension.length)}${extension.toLowerCase()}`;
        const key = normalized.toLocaleLowerCase('en');
        const collision = normalizedNames.get(key);
        if (collision) throw new Error(`Filename collision after normalization: ${collision} and ${file}`);
        normalizedNames.set(key, file);
      }

      const images = candidates.map((file) => {
        const extension = path.extname(file);
        const normalized = `${file.slice(0, -extension.length)}${extension.toLowerCase()}`;
        if (file !== normalized) {
          console.log(`${dryRun ? 'Would rename' : 'Renaming'} ${file} -> ${normalized}`);
          if (!dryRun) renameCaseSafely(albumDirectory, file, normalized);
        }
        return normalized;
      }).sort((left, right) => filenameCollator.compare(left, right) || left.localeCompare(right));

      const indexPath = path.join(albumDirectory, 'index.md');
      if (!existsSync(indexPath)) {
        const scaffold = await scaffoldIndex(albumDirectory, images);
        console.log(`${dryRun ? 'Would create' : 'Creating'} ${indexPath}`);
        if (!dryRun) writeFileSync(indexPath, scaffold.contents);
        return { albumDirectory, images, storyId: scaffold.storyId, photoIds: liveIds(scaffold.entries) };
      }

      const existing = readFileSync(indexPath, 'utf8');
      const storyId = frontmatterValue(existing, 'storyId');
      if (!storyId) throw new Error(`${indexPath} has no storyId`);
      assertStoryIdShape(storyId, indexPath);
      const reconciled = await reconcilePhotos(existing, images, path.basename(albumDirectory));
      if (reconciled.contents !== existing) {
        console.log(`${dryRun ? 'Would update' : 'Updating'} photos in ${indexPath}`);
        if (!dryRun) writeFileSync(indexPath, reconciled.contents);
      }
      return { albumDirectory, images, storyId, photoIds: liveIds(reconciled.entries) };
    },
  };
}

function liveIds(entries: FrontmatterPhoto[]): Map<string, string> {
  return new Map(entries.filter((entry) => !entry.removed).map((entry) => [entry.file, entry.photoId]));
}

function sortFilenames(files: string[]): string[] {
  return [...files].sort((left, right) => filenameCollator.compare(left, right) || left.localeCompare(right));
}

function renameCaseSafely(directory: string, sourceName: string, destinationName: string): void {
  const source = path.join(directory, sourceName);
  const destination = path.join(directory, destinationName);
  const temporary = path.join(directory, `.${sourceName}.photos-push-${process.pid}`);
  renameSync(source, temporary);
  try {
    renameSync(temporary, destination);
  } catch (error) {
    renameSync(temporary, source);
    throw error;
  }
}

function assertStoryIdShape(storyId: string, indexPath: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(storyId)) {
    throw new Error(`${indexPath}: storyId ${JSON.stringify(storyId)} must be lowercase letters and digits in hyphen-separated words`);
  }
}

async function photoDate(file: string): Promise<string | undefined> {
  try {
    const metadata = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
    const date = metadata?.DateTimeOriginal ?? metadata?.CreateDate;
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return undefined;
    const year = String(date.getUTCFullYear()).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch {
    return undefined;
  }
}

function findImageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) return findImageFiles(child);
    return supportedExtensions.has(path.extname(entry.name).toLowerCase()) ? [child] : [];
  });
}
