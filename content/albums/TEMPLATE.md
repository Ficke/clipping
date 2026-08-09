# Album fields

`photos:push` creates `index.md`; this file documents the result. It is not
published because the content collection loads only `*/index.md`.

```markdown
---
storyId: "place-name"
title: "Place Name"
date: 2026-08-14
published: 2026-08-16
location: "Emigrant Wilderness"
cover: photo_bbbbbbbbbbbbbbbbbbbbbbbb
description: "Optional search and social description."
draft: true
photos:
  - file: DSCF1234.jpg
    photoId: photo_aaaaaaaaaaaaaaaaaaaaaaaa
  - file: DSCF1250.jpg
    photoId: photo_bbbbbbbbbbbbbbbbbbbbbbbb
    caption: "Fog moves across the ridge."
    alt: "A dark ridge disappearing into low fog."
    price: 40
  - file: DSCF1300.jpg
    photoId: photo_cccccccccccccccccccccccc
    removed: 2026-09-01
  - file: DSCF1400.jpg
    photoId: photo_dddddddddddddddddddddddd
    removed: 2026-09-01
    deleted: 2026-09-08
---

Optional album prose appears after the opening photograph.
```

## Conventions

- `storyId` is the permanent album identity. It keys storage, the manifest, and
  the public URL. Do not change it after the first push.
- `title` and `location` are display text. `date` is when the photographs were
  made; `published` controls site and feed ordering.
- `photos` is the display order. `photos:push` adds new files while preserving
  photo IDs, captions, alt text, prices, lifecycle dates, and hand-set order.
- `photoId` is the permanent identity for one photograph. It names the private
  master and connects the photo to orders. Let `photos:push` create it.
- `caption` is optional visible context. `alt` should describe what the image
  communicates to someone who cannot see it; do not repeat camera settings.
- `price` is an optional USD amount. Its presence puts a live photograph on
  sale. Use `photos:store` to list, reprice, or delist a photo.
- `cover` is an optional photo ID for the home-page card and social preview. It
  defaults to the first live photo.
- `description` overrides the generated search and social description.
- `draft: true` keeps the album unpublished. Remove the field when it is ready.
- `removed` and `deleted` are dated lifecycle records owned by `photos:remove`,
  `photos:restore`, and `photos:delete`. Do not edit them by hand.

The album directory is a working label and may be renamed. Filenames may also
change without changing photo identity. Do not delete a local file to remove a
photograph: `photos:push` will stop rather than discard its record. Use
`photos:remove` first, and use `photos:delete` only when the retained master
should also be destroyed.

`photos.json` is a generated build contract. Commit it with `index.md`, but do
not edit it manually.
