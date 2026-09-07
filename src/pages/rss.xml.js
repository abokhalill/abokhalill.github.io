import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
	const writeups = await getCollection('writeups', ({ data }) => !data.draft);
	return rss({
		title: 'Yousef Mahmoud',
		description:
			'Writing on compiler internals, cache geometry, and hardware costs that are real at runtime and invisible in the source.',
		/* The channel link is what a reader opens when you click the feed's title.
		   `context.site` alone is the bare domain, which 404s — the site lives
		   under the base path. */
		site: new URL(import.meta.env.BASE_URL, context.site),
		items: writeups
			.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
			.map((w) => ({
				title: w.data.title,
				description: w.data.dek,
				pubDate: w.data.date,
				link: `${import.meta.env.BASE_URL}${w.id}/`,
			})),
	});
}
