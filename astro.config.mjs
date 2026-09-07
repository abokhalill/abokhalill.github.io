// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { paperTheme, fileLabel } from './src/lib/paper-theme.js';

// Served from the root, which requires the repo to be named `abokhalill.github.io`
// — GitHub's "user site" convention. Renaming it back to anything else means
// setting this to '/<repo-name>' again.
const BASE = '/';

export default defineConfig({
	site: 'https://abokhalill.github.io',
	base: BASE,
	trailingSlash: 'always',
	// The site previously lived under /lshaz-writeup/. These keep the already
	// published links alive; Astro emits them as static meta-refresh pages, so
	// they cost two small files and no JavaScript. Safe to delete once the old
	// URLs stop showing up in logs.
	redirects: {
		'/lshaz-writeup/': '/',
		'/lshaz-writeup/writeups/abseil-deep-dive/': '/abseil/',
	},
	integrations: [sitemap({ filter: (page) => !page.includes('/404') && !page.includes('/lshaz-writeup') })],
	markdown: {
		shikiConfig: {
			theme: paperTheme,
			transformers: [fileLabel],
			wrap: false,
		},
	},
	build: { inlineStylesheets: 'always' },
});
