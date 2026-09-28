import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inlines charts from figures/ into the page.
 *
 * In a writeup:   ![](/figures/fig1-regex-cycles-per-row.svg)
 *
 * The SVG files stay exactly as generated. At build time their own <style>
 * block is dropped and the site's figure styles apply instead (see .fig in
 * site.css), because the generated styles disagree with the site on every
 * axis: a blue series, a sans-serif face, an off-white panel, and a dark-mode
 * rule that — once inlined — would turn the charts dark on a light page.
 * Inlining rather than <img> is what lets them use the page's own webfonts.
 *
 * The caption is just the figure number. Alt text, if given, is appended after
 * it. The SVG's own aria-label stays on the <svg> for screen readers.
 */
const DIR = join(process.cwd(), 'figures');

export function rehypeFigures() {
	return (tree) => walk(tree);
}

function walk(node) {
	if (!node.children) return;
	node.children = node.children.map((child) => {
		const img = soleFigureImage(child);
		return img ? figure(img) : (walk(child), child);
	});
}

// A paragraph whose only content is one /figures/*.svg image.
function soleFigureImage(node) {
	if (node.type !== 'element' || node.tagName !== 'p') return null;
	const kids = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
	const [img] = kids;
	if (kids.length !== 1 || img.tagName !== 'img') return null;
	const src = String(img.properties?.src ?? '');
	return src.startsWith('/figures/') && src.endsWith('.svg') ? img : null;
}

function figure(img) {
	const file = img.properties.src.slice('/figures/'.length);
	let svg = readFileSync(join(DIR, file), 'utf8');
	svg = svg.replace(/<style>[\s\S]*?<\/style>/, '');
	const width = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /)?.[1];
	svg = svg.replace(/(<svg\b[^>]*?)\s+width="[^"]*"\s+height="[^"]*"/, '$1');
	const caption = String(img.properties.alt || '');
	return {
		type: 'element',
		tagName: 'figure',
		properties: { className: ['fig'] },
		children: [
			{
				type: 'element',
				tagName: 'div',
				properties: { className: ['fig__art'], style: width ? `--fig-w:${width}px` : undefined },
				children: [{ type: 'raw', value: svg }],
			},
			{
				type: 'element',
				tagName: 'figcaption',
				properties: {},
				children: caption ? [{ type: 'text', value: caption }] : [],
			},
		],
	};
}
