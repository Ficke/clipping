# Photo publishing

The full-resolution photos do not live in Git. They are private files in S3 and
are also the files delivered to buyers. The repository only keeps the writing
for each album and a generated manifest describing the public image sizes.

This separation keeps the original files private and makes ordinary site builds
fast. Changing a caption or page layout does not require downloading and
processing the photo archive again.

## What belongs in the repository

Every album has two files:

- `index.md` contains the title, photo order, captions, alternative text,
  prices, and removal history. This is the file you edit.
- `photos.json` records dimensions and URLs for the generated images. The photo
  tools create it. Commit it with the album, but do not edit it by hand.

Both files live in `content/albums/<folder>/`. The site can build entirely from
these committed files.

S3 keeps the private master at `photos/<photoId>`. Metadata removed from that
master, including location and camera details, is archived separately at
`metadata/<photoId>.json`. Public images use content-based URLs, so changing the
master creates new URLs while an unchanged photo continues to use its existing
ones.

## Publishing an album

Always preview a publish first:

```sh
bun run photos:push -- <album-folder> --dry-run
```

If the preview is correct, run the command again without `--dry-run`. For a new
album, the command asks for its title, dates, location, cover, and store prices.
It assigns permanent IDs to the album and its photos, removes private metadata
from the uploaded masters, and builds the public image sizes.

The command offers two ways to build the images. CodeBuild creates them from the
committed revision and is the default. A local build is faster while you are
working and uses the files in your current checkout. Choose `local` at the
prompt, or pass `--local`:

```sh
bun run photos:push -- <album-folder> --local
```

The album's `storyId` and each photo's `photoId` stay with them permanently.
Folder names, filenames, titles, captions, order, and cover choice can all
change without changing those IDs.

## Updating an album

Download the current masters before changing an existing album:

```sh
bun run photos:pull -- <album>
```

Make your edits, then use the same dry-run and publish commands. If you replace
the contents of an existing photo, `photos:push` asks you to confirm the change.
Past buyers will receive the new master. S3 keeps the previous version for 90
days.

## Deploying site changes

The site deploys whenever a change reaches `main`. The build reads `index.md`
and `photos.json`, publishes the static pages, and refreshes any cached pages
that may have changed.

Once the new site is available, the deployment tries to remove public images
that are no longer used by an album. If that cleanup fails, the site remains
deployed and CodeBuild records a warning. The next deployment tries the cleanup
again.

## Removing a photo

Removing a photo from an album is different from deleting its master. Use:

```sh
bun run photos:remove -- <album> <photo-id-or-file>
```

The photo disappears from the album and store, but people who already bought it
can still download the master. To put it back, run `photos:restore`, followed by
`photos:push` to rebuild any public images that have been cleaned up.

Permanent deletion removes the master and archived metadata. It is only allowed
after the photo has been removed:

```sh
bun run photos:sales -- <photo-id>
bun run photos:delete -- <photo-id>
```

Check the sales record first because deletion stops past purchases from working.
The deleted S3 objects remain recoverable through version history for 90 days.

Never represent a removal by deleting the local image. `photos:push` treats a
missing live photo as an error so that an accidental file deletion cannot break
its identity or purchase history.

## How photos reach the site

CloudFront serves the static site from one private bucket and the public image
sizes from another. It never exposes the master bucket. After a purchase, a
valid download token can be exchanged for a short-lived S3 URL to one master.
