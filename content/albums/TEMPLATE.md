# Album template

Copy this into `content/albums/YYYY-MM-slug/index.md`, delete what you don't
use, and follow the conventions below so every album reads the same way.
(This file isn't published — the site only picks up `*/index.md`.)

```markdown
---
title: "Place Name"
date: 2026-08-14
cover: 01-DSCF1234.jpg
# --- everything below is optional ---
captions:
  02-DSCF1250.jpg: "One descriptive sentence about the photo."
description: "Custom search/social blurb for this album."
draft: true
---

Album text (optional): a short introduction rendered above the photos.
The story of the trip — route, conditions, who you were with, anything
worth remembering. One to three short paragraphs; plain markdown.
```

## Conventions

- **Title is the place, nothing else.** No dates ("Yosemite, April '25") and
  no event names — the date renders automatically above the title from the
  `date` field, and flavor belongs in the album text.
- **Album text** is optional. When you use it, tell the story of the trip —
  never just restate the date or the title.
- **Captions** are optional, one descriptive sentence per photo. No camera
  settings — the EXIF line under each photo shows those automatically.
- **Filenames** are lowercase-extension JPEGs with a numeric prefix
  (`01-`, `02-`, …) — that prefix is the display order.
- **Folder name** is `YYYY-MM-slug`; the slug becomes the URL. Never rename
  a folder after publishing.
- **`draft: true`** while you're arranging; delete the line to publish.
