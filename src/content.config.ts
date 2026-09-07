import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const writeups = defineCollection({
	// Top level, not src/content/writeups. Astro 4 required collections to live
	// under src/content/; the Astro 5 loader takes any path, so those two
	// directories were carrying no meaning. The writing is what this repo is for
	// — it sits at the front door.
	loader: glob({ base: './writeups', pattern: '**/*.md' }),
	schema: z.object({
		title: z.string(),
		/** The standfirst. One sentence, italic, sits under the title. */
		dek: z.string(),
		date: z.coerce.date(),
		/** Share card in public/. Falls back to the site-wide card. */
		image: z.string().optional(),
		draft: z.boolean().default(false),
	}),
});

export const collections = { writeups };
