# Album frontmatter

When you publish a new album, `photos:push` creates its `index.md`. The example
below shows every supported field. This template is only a reference and does
not appear on the site.

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

Optional album prose goes here.
```

## Album fields

`storyId` is the album's permanent identity and determines its public URL. Let
`photos:push` create it, then leave it unchanged. The album folder can be renamed
without affecting the URL.

`title` and `location` are shown on the site. `date` records when the photos were
made. `published` controls where the album appears on the home page and in the
feed. If `published` is omitted, the site uses `date` instead.

`cover` is the permanent photo ID used for the home page and social preview. If
you omit it, the first live photo becomes the cover. `description` provides
custom text for search results and social previews. Set `draft: true` while an
album is not ready to appear on the site, then remove it or set it to `false`
when the album is ready.

Any Markdown after the frontmatter appears as the album's introductory prose.

## Photo fields

Each entry in `photos` begins with its local filename and permanent `photoId`.
Let `photos:push` assign the ID. You can rename or reorder the files later
without changing it.

`caption` is optional text shown with the image. Use `alt` to describe what the
image communicates to someone who cannot see it. A `price` in US dollars puts a
live photo in the store. Use `bun run photos:store` when you need to add, change,
or remove a price.

The `removed` and `deleted` dates record the photo's lifecycle. The
`photos:remove`, `photos:restore`, and `photos:delete` commands manage them. Do
not edit these dates yourself.

The generated `photos.json` belongs with `index.md` in the album folder. Commit
both files, but only edit `index.md`.
