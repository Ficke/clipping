import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parsePriceDollars } from './photo-frontmatter.mjs';
import { photoIdFor } from '../src/lib/downloads.ts';

const repoRoot = path.resolve(import.meta.dir, '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const temporaryAlbums = [];

afterEach(() => {
  for (const album of temporaryAlbums.splice(0)) rmSync(album, { recursive: true, force: true });
});

function fixture() {
  const name = `2099-01-commerce-command-${process.pid}-${temporaryAlbums.length}`;
  const album = path.join(albumsRoot, name);
  temporaryAlbums.push(album);
  mkdirSync(album);
  const index = path.join(album, 'index.md');
  const photoHash = 'a'.repeat(64);
  const otherHash = 'b'.repeat(64);
  writeFileSync(index, [
    '---',
    `storyId: "${name}"`,
    'title: "Commerce Command"',
    'date: 2099-01-01',
    'location: "Nowhere"',
    'photos:',
    '  - file: photo.jpg',
    '    caption: "Keep me."',
    '  - file: other.jpg',
    '    caption: "Keep this visible."',
    '---',
    '',
  ].join('\n'));
  writeFileSync(path.join(album, 'photos.json'), JSON.stringify({
    version: 1,
    profile: 'photo-v1',
    album: name,
    photos: [
      { file: 'photo.jpg', sourceHash: photoHash },
      { file: 'other.jpg', sourceHash: otherHash },
    ],
  }));
  return { name, index, photoId: photoIdFor(photoHash) };
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
    expect(contents).toContain('caption: "Keep me."\n    forSale: true\n    price: 55');
    expect(contents.match(/price:/g)).toHaveLength(1);
  });

  test('delists from the store but retains the private catalog mapping', () => {
    const { name, index, photoId } = fixture();
    run('photos-store.mjs', [name, 'photo.jpg', '--price', '40']);
    const result = run('photos-store.mjs', [photoId, '--remove']);

    expect(result.status).toBe(0);
    const contents = readFileSync(index, 'utf8');
    expect(contents).not.toContain('forSale:');
    expect(contents).not.toContain('price:');
    expect(contents).not.toContain('catalog: false');
    expect(result.stdout).toContain('photo.jpg: not for sale');
  });

  test('resolves an opaque photo ID within an explicitly named album', () => {
    const { name, index, photoId } = fixture();
    const result = run('photos-store.mjs', [name, photoId, '--price', '45']);

    expect(result.status).toBe(0);
    expect(readFileSync(index, 'utf8')).toContain('forSale: true\n    price: 45');
  });

  test('purges and restores the private catalog explicitly', () => {
    const { name, index } = fixture();
    expect(run('photos-store.mjs', [name, 'photo.jpg', '--purge-catalog', '--yes']).status).toBe(0);
    expect(readFileSync(index, 'utf8')).toContain('catalog: false');

    expect(run('photos-store.mjs', [name, 'photo.jpg', '--restore-catalog']).status).toBe(0);
    expect(readFileSync(index, 'utf8')).not.toContain('catalog: false');
  });

  test('requires explicit confirmation before breaking private catalog fulfillment', () => {
    const { name, index } = fixture();
    const before = readFileSync(index, 'utf8');
    const result = run('photos-store.mjs', [name, 'photo.jpg', '--purge-catalog']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('interactive confirmation or --yes');
    expect(readFileSync(index, 'utf8')).toBe(before);
  });

  test('hides from the public site, delists, and remains recoverable', () => {
    const { name, index } = fixture();
    run('photos-store.mjs', [name, 'photo.jpg', '--price', '40']);
    expect(run('photos-site.mjs', [name, 'photo.jpg', '--hide']).status).toBe(0);

    let contents = readFileSync(index, 'utf8');
    expect(contents).toContain('hidden: true');
    expect(contents).not.toContain('forSale:');
    expect(contents).not.toContain('catalog: false');

    expect(run('photos-site.mjs', [name, 'photo.jpg', '--show']).status).toBe(0);
    contents = readFileSync(index, 'utf8');
    expect(contents).not.toContain('hidden:');
  });

  test('does not hide an explicit cover or the last visible photo', () => {
    const { name, index } = fixture();
    let contents = readFileSync(index, 'utf8').replace(
      'location: "Nowhere"',
      'location: "Nowhere"\ncover: photo.jpg',
    );
    writeFileSync(index, contents);

    let result = run('photos-site.mjs', [name, 'photo.jpg', '--hide']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('explicit album cover');

    contents = readFileSync(index, 'utf8').replace('cover: photo.jpg\n', '');
    writeFileSync(index, contents);
    expect(run('photos-site.mjs', [name, 'other.jpg', '--hide']).status).toBe(0);
    result = run('photos-site.mjs', [name, 'photo.jpg', '--hide']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('last visible photo');
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
