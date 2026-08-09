import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Committed photo manifests, which are the record of what media is in use. */
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

/** Every derivative tree a live album still points at. */
export function livePrefixes(manifests) {
  const live = new Set();
  for (const manifest of manifests) {
    if (!validProfile(manifest.profile)) continue;
    for (const photo of manifest.photos ?? []) {
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
export function treesFromKeys(keys) {
  const trees = new Set();
  for (const key of keys) {
    const match = /^(media\/([a-z0-9][a-z0-9-]*)\/([a-f0-9]{2})\/([a-f0-9]{64})\/)/.exec(key);
    if (match && match[3] === match[4].slice(0, 2)) trees.add(match[1]);
  }
  return [...trees].sort();
}

/**
 * Trees present in the bucket that no album references.
 *
 * Compare bucket contents with live manifests so every unreferenced tree is
 * found, including a photograph removed from its album entirely.
 */
export function orphanedTrees(manifests, keys) {
  const live = livePrefixes(manifests);
  return treesFromKeys(keys).filter((prefix) => !live.has(prefix));
}
