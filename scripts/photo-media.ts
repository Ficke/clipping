import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  isMediaProfile,
  isSourceHash,
  parsePhotoManifest,
  type PhotoManifest,
} from '../shared/media';

export interface MediaReferenceManifest {
  profile: string;
  photos: readonly { sourceHash: string }[];
}

/** Committed photo manifests, which are the record of what media is in use. */
export function loadManifests(albumsRoot: string): PhotoManifest[] {
  return readdirSync(albumsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(albumsRoot, entry.name, 'photos.json'))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => {
      try {
        return parsePhotoManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error(`Could not read ${manifestPath}`);
      }
    });
}

export function mediaPrefix(profile: string, sourceHash: string): string {
  return `media/${profile}/${sourceHash.slice(0, 2)}/${sourceHash}/`;
}

export const validHash = isSourceHash;
export const validProfile = isMediaProfile;

/** Every derivative tree a live album still points at. */
export function livePrefixes(manifests: readonly MediaReferenceManifest[]): Set<string> {
  const live = new Set<string>();
  for (const manifest of manifests) {
    if (!validProfile(manifest.profile)) continue;
    for (const photo of manifest.photos) {
      if (validHash(photo.sourceHash)) live.add(mediaPrefix(manifest.profile, photo.sourceHash));
    }
  }
  return live;
}

/**
 * Group media object keys into their `media/<profile>/<ab>/<hash>/` trees.
 * Anything that does not parse is left out rather than guessed at, so an
 * unexpected key is never a deletion candidate.
 */
export function treesFromKeys(keys: Iterable<string>): string[] {
  const trees = new Set<string>();
  for (const key of keys) {
    const match = /^(media\/([a-z0-9][a-z0-9-]*)\/([a-f0-9]{2})\/([a-f0-9]{64})\/)/.exec(key);
    if (match?.[1] && match[3] === match[4]?.slice(0, 2)) trees.add(match[1]);
  }
  return [...trees].sort();
}

/** Trees present in the bucket that no album references. */
export function orphanedTrees(
  manifests: readonly MediaReferenceManifest[],
  keys: Iterable<string>,
): string[] {
  const live = livePrefixes(manifests);
  return treesFromKeys(keys).filter((prefix) => !live.has(prefix));
}
