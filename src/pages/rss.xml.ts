import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { formatDate, getAlbums, slugOf } from '../lib/albums';

export async function GET(context: APIContext) {
  const albums = await getAlbums();
  return rss({
    title: 'Adam Ficke — Photography',
    description: 'Photo stories from trips and time outdoors by Adam Ficke.',
    site: context.site!,
    items: albums.map((album) => ({
      title: album.data.title,
      pubDate: album.data.date,
      link: `/photography/${slugOf(album)}/`,
      description: album.data.description
        ?? `${album.data.title} — ${album.data.location}, ${formatDate(album.data.date)}.`,
    })),
  });
}
