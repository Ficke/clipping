import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const albums = defineCollection({
  loader: glob({ pattern: '*/index.md', base: './content/albums' }),
  schema: z.object({
    storyId: z.string().min(1),
    title: z.string(),
    date: z.coerce.date(),
    location: z.string().min(1),
    cover: z.string(),
    order: z.array(z.string()).optional(),
    description: z.string().optional(),
    captions: z.record(z.string(), z.string()).default({}),
    alt: z.record(z.string(), z.string()).default({}),
    draft: z.boolean().default(false),
  }),
});

export const collections = { albums };
