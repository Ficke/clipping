import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Committed photo manifests, which are the record of what media exists. */
export function loadManifests(albumsRoot) {
  return readdirSync(albumsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(albumsRoot, entry.name, 'photos.json'))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => {
      try {
        return JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (error) {
        throw new Error(`Could not read ${manifestPath}: ${error.message}`);
      }
    });
}

export function mediaPrefix(profile, sourceHash) {
  return `media/${profile}/${sourceHash.slice(0, 2)}/${sourceHash}/`;
}

export function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function validProfile(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

/**
 * Every derivative tree one photograph has ever had, live and obsolete. A
 * re-export leaves the old tree behind under its old hash, so deleting by the
 * current hash alone would strand the earlier ones.
 */
export function derivativePrefixes(manifests, photoId) {
  const prefixes = new Set();
  for (const manifest of manifests) {
    const profile = manifest.profile;
    for (const photo of manifest.photos ?? []) {
      if (photo.photoId === photoId && validProfile(profile) && validHash(photo.sourceHash)) {
        prefixes.add(mediaPrefix(profile, photo.sourceHash));
      }
    }
    for (const entry of manifest.obsoleteMedia ?? []) {
      if (entry.photoId === photoId && validProfile(entry.profile) && validHash(entry.sourceHash)) {
        prefixes.add(mediaPrefix(entry.profile, entry.sourceHash));
      }
    }
  }
  return [...prefixes].sort();
}
