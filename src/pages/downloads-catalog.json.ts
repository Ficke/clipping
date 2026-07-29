import type { APIRoute } from 'astro';
import { buildCatalog } from '../lib/catalog';

/**
 * The commerce Lambda reads this object out of the site bucket to decide what
 * is for sale and at what price. Publishing it with the site — rather than
 * bundling it into the Lambda — is what keeps putting an album on sale a
 * content deploy instead of a code deploy.
 *
 * It contains nothing private: prices, album titles, captions, and the
 * filenames already listed in album frontmatter.
 */
export const GET: APIRoute = async () => {
  const catalog = await buildCatalog();
  return new Response(JSON.stringify(catalog, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
};
