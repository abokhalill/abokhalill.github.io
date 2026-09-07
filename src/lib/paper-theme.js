/**
 * Paper — a near-monochrome syntax theme.
 *
 * The listings on this site are evidence, not decoration. Rainbow highlighting
 * spends the reader's attention on lexical categories when what matters is
 * field names, types and offsets. So: three tones of ink, one warm neutral for
 * literals, and nothing else. Colour on this site is reserved for hazards.
 */

/* Every value below clears 4.5:1 against the listing ground (#f4f2ec) — checked,
   not eyeballed. Comments and punctuation recede by tone, never below AA. */
const INK = '#1d1b16'; //  14.5:1 — the code itself, set in a single ink
const INK_FAINT = '#6e6a5c'; //   4.8:1 — punctuation and operators: structure, not content
const COMMENT = '#726c5e'; //   4.7:1 — commentary, a step back from the code
const LITERAL = '#5c5340'; //   6.8:1 — strings and numbers: one warm neutral

/** @type {import('shiki').ThemeRegistrationRaw} */
export const paperTheme = {
	name: 'paper',
	type: 'light',
	colors: {
		'editor.background': '#f4f2ec',
		'editor.foreground': INK,
	},
	/* An earlier version of this theme tried to invert the usual emphasis — field
	   names darkest, type machinery a step back — on the grounds that the essay
	   is about which fields sit next to which. It doesn't survive contact with
	   the C++ grammar: `mutex_sleep_spins[2]` scopes as a variable while
	   `spinloop_iterations{0}` and `once` do not, so identical declarations came
	   out in different inks and read as a rendering bug.

	   So: the code is set in one ink, the way a listing in a paper is. Only three
	   things step back from it — commentary, literals, and punctuation — and each
	   for a reason a reader can state. Nothing depends on how thoroughly a
	   TextMate grammar happens to tag a construct.

	   No bold and no italic anywhere: only the roman weights of Plex Mono are
	   self-hosted, so either would be synthesised by the browser, and a faux
	   oblique monospace is exactly the sloppiness a light ground exposes. */
	settings: [
		{ scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: COMMENT } },
		{ scope: ['string', 'string.quoted', 'constant.character'], settings: { foreground: LITERAL } },
		{ scope: ['constant.numeric', 'constant.language', 'constant.other'], settings: { foreground: LITERAL } },
		{ scope: ['punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator', 'keyword.operator'], settings: { foreground: INK_FAINT } },
	],
};

/**
 * Reads ```lang file="path/to/thing.h" off the fence and hangs it on the <pre>
 * as a data attribute. The label is then drawn by CSS, so this ships no JS —
 * see .listing[data-file]::before in site.css.
 */
export const fileLabel = {
	name: 'file-label',
	pre(node) {
		const raw = this.options?.meta?.__raw;
		if (!raw) return;
		const file = raw.match(/file="([^"]+)"/)?.[1];
		if (file) node.properties['data-file'] = file;
	},
};
