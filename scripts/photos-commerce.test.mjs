import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parsePriceDollars } from './photo-frontmatter.mjs';

const repoRoot = path.resolve(import.meta.dir, '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const temporaryAlbums = [];
const PHOTO_ID = 'photo_aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_ID = 'photo_bbbbbbbbbbbbbbbbbbbbbbbb';

afterEach(() => {
  for (const album of temporaryAlbums.splice(0)) rmSync(album, { recursive: true, force: true });
});

function fixture() {
  const name = `2099-01-commerce-command-${process.pid}-${temporaryAlbums.length}`;
  const album = path.join(albumsRoot, name);
  temporaryAlbums.push(album);
  mkdirSync(album);
  const index = path.join(album, 'index.md');
  writeFileSync(index, [
    '---',
    `storyId: "${name}"`,
    'title: "Commerce Command"',
    'date: 2099-01-01',
    'location: "Nowhere"',
    'photos:',
    '  - file: photo.jpg',
    `    photoId: ${PHOTO_ID}`,
    '    caption: "Keep me."',
    '  - file: other.jpg',
    `    photoId: ${OTHER_ID}`,
    '    caption: "Keep this visible."',
    '---',
    '',
  ].join('\n'));
  writeFileSync(path.join(album, 'photos.json'), JSON.stringify({
    version: 1,
    profile: 'photo-v1',
    album: name,
    photos: [
      { photoId: PHOTO_ID, file: 'photo.jpg', sourceHash: 'a'.repeat(64) },
      { photoId: OTHER_ID, file: 'other.jpg', sourceHash: 'b'.repeat(64) },
    ],
  }));
  return { name, index };
}

function run(script, commandArgs) {
  return spawnSync('bun', [path.join(import.meta.dir, script), ...commandArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('photo commerce commands', () => {
  test('lists and reprices an existing photo without touching its caption', () => {
    const { name, index } = fixture();
    expect(run('photos-store.mjs', [name, 'photo.jpg', '--price', '39.50']).status).toBe(0);
    expect(run('photos-store.mjs', [name, 'photo.jpg', '--price', '$55']).status).toBe(0);

    const contents = readFileSync(index, 'utf8');
    expect(contents).toContain('caption: "Keep me."\n    price: 55');
    expect(contents.match(/price:/g)).toHaveLength(1);
  });

  test('delisting leaves the photograph in the album', () => {
    const { name, index } = fixture();
    run('photos-store.mjs', [name, 'photo.jpg', '--price', '40']);
    const result = run('photos-store.mjs', [PHOTO_ID, '--delist']);

    expect(result.status).toBe(0);
    const contents = readFileSync(index, 'utf8');
    expect(contents).not.toContain('price:');
    expect(contents).not.toContain('removed:');
    expect(result.stdout).toContain('photo.jpg (photo_aaaaaaaaaaaaaaaaaaaaaaaa): not for sale');
  });

  test('resolves an opaque photo ID within an explicitly named album', () => {
    const { name, index } = fixture();
    const result = run('photos-store.mjs', [name, PHOTO_ID, '--price', '45']);

    expect(result.status).toBe(0);
    expect(readFileSync(index, 'utf8')).toContain('price: 45');
  });

  test('removing takes a photograph out of the album and the store, reversibly', () => {
    const { name, index } = fixture();
    run('photos-store.mjs', [name, 'photo.jpg', '--price', '40']);
    expect(run('photos-remove.mjs', [name, 'photo.jpg']).status).toBe(0);

    let contents = readFileSync(index, 'utf8');
    expect(contents).toMatch(/removed: \d{4}-\d{2}-\d{2}/);
    expect(contents).not.toContain('price:');

    expect(run('photos-remove.mjs', [name, 'photo.jpg', '--restore']).status).toBe(0);
    contents = readFileSync(index, 'utf8');
    expect(contents).not.toContain('removed:');
    expect(contents).toContain('caption: "Keep me."');
  });

  test('a removed photograph cannot be put back on sale until it is restored', () => {
    const { name } = fixture();
    run('photos-remove.mjs', [name, 'photo.jpg']);
    const result = run('photos-store.mjs', [name, 'photo.jpg', '--price', '40']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('restore it before selling it');
  });

  test('does not remove an explicit cover or the last photograph', () => {
    const { name, index } = fixture();
    let contents = readFileSync(index, 'utf8').replace(
      'location: "Nowhere"',
      'location: "Nowhere"\ncover: photo.jpg',
    );
    writeFileSync(index, contents);

    let result = run('photos-remove.mjs', [name, 'photo.jpg']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('explicit album cover');

    contents = readFileSync(index, 'utf8').replace('cover: photo.jpg\n', '');
    writeFileSync(index, contents);
    expect(run('photos-remove.mjs', [name, 'other.jpg']).status).toBe(0);
    result = run('photos-remove.mjs', [name, 'photo.jpg']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('last photograph');
  });

  /* Deleting bytes must not be reachable from a photograph still on the site. */
  test('deleting refuses until the photograph has been removed', () => {
    const { name, index } = fixture();
    const before = readFileSync(index, 'utf8');
    const result = run('photos-delete.mjs', [name, 'photo.jpg', '--yes']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('photos:remove');
    expect(readFileSync(index, 'utf8')).toBe(before);
  });

  test('dry runs and invalid prices never mutate content', () => {
    const { name, index } = fixture();
    const before = readFileSync(index, 'utf8');
    expect(run('photos-store.mjs', [name, 'photo.jpg', '--price', '45', '--dry-run']).status).toBe(0);
    expect(run('photos-store.mjs', [name, 'photo.jpg', '--price', '12.345']).status).not.toBe(0);
    expect(readFileSync(index, 'utf8')).toBe(before);
  });

  test('accepts only bounded two-decimal USD prices', () => {
    expect(parsePriceDollars('40')).toBe(40);
    expect(parsePriceDollars('$39.50')).toBe(39.5);
    expect(() => parsePriceDollars('0')).toThrow(/between/);
    expect(() => parsePriceDollars('12.345')).toThrow(/two decimal/);
  });
});
