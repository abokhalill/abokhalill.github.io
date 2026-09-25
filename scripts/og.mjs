/**
 * Renders the share cards in public/ — one per writeup, plus the site-wide card.
 *
 * These are committed as static PNGs rather than generated during the build. A
 * site with two pages does not need an image pipeline, and putting a headless
 * browser in devDependencies would make every `npm ci` — including the one that
 * runs on every deploy — download a browser it will never use.
 *
 * So this is deliberately not wired into `npm run build`. Run it by hand after
 * adding a writeup, or after changing the site's colours or type:
 *
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/og.mjs
 *   git checkout package.json package-lock.json   # drop the temporary install
 *
 * A writeup gets its own card when its frontmatter names one, e.g.
 * `image: og-abseil.png`. Anything without one falls back to the site card.
 */

import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = pathToFileURL(join(ROOT, 'src/fonts')).href;
const CONTENT = join(ROOT, 'writeups');
const OUT = join(ROOT, 'public');

/**
 * Pulls a handful of scalar keys out of frontmatter. Not a YAML parser — it
 * handles quoted and bare scalars on one line, which is all these keys ever are.
 * If a value ever needs to span lines, pass it here explicitly instead.
 */
function frontmatter(md) {
	const block = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!block) return {};
	const out = {};
	for (const line of block[1].split(/\r?\n/)) {
		const m = line.match(/^([a-z_]+):\s*(.+?)\s*$/i);
		if (!m) continue;
		out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
	}
	return out;
}

const escape = (s) =>
	String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const card = ({ kicker, title, foot, titleSize }) => `
<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'SS4';src:url('${FONTS}/source-serif-4-var.woff2') format('woff2-variations');font-weight:400 700}
@font-face{font-family:'PM';src:url('${FONTS}/plex-mono-400.woff2') format('woff2');font-weight:400}
@font-face{font-family:'PM';src:url('${FONTS}/plex-mono-500.woff2') format('woff2');font-weight:500}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1200px;height:630px;background:#faf9f6;font-family:'SS4',serif;
  font-optical-sizing:auto;-webkit-font-smoothing:antialiased;
  padding:58px 72px 58px 128px;display:flex;flex-direction:column}
/* The same corner the site is built on: a masthead rule meeting a vertical axis. */
.mast{display:flex;justify-content:space-between;align-items:baseline;
  font-family:'PM',monospace;font-size:17px;letter-spacing:.05em;
  padding-bottom:14px;border-bottom:1px solid #c9c5b8;margin-left:-64px;padding-left:64px}
.name{color:#14130f;font-weight:500;text-transform:uppercase}
.url{color:#6f6a5d}
.col{flex:1;margin-left:-64px;padding-left:64px;border-left:1px solid #e4e1d8;
  display:flex;flex-direction:column;padding-top:52px}
.kicker{font-family:'PM',monospace;font-size:16px;font-weight:500;letter-spacing:.11em;
  text-transform:uppercase;color:#6f6a5d;font-variant-numeric:tabular-nums lining-nums}
h1{font-size:${titleSize}px;line-height:1.14;letter-spacing:-.019em;font-weight:600;
  color:#14130f;margin-top:26px;max-width:1000px;text-wrap:pretty;font-variation-settings:'wght' 600}
.foot{margin-top:auto;font-family:'PM',monospace;font-size:17px;line-height:1.5;
  color:#6f6a5d;font-variant-numeric:tabular-nums lining-nums;
  border-top:1px solid #e4e1d8;padding-top:16px}
</style></head><body>
  <div class="mast"><span class="name">Yousef Mahmoud</span><span class="url">github.com/abokhalill</span></div>
  <div class="col">
    <p class="kicker">${kicker}</p>
    <h1>${escape(title)}</h1>
    <p class="foot">${escape(foot)}</p>
  </div>
</body></html>`;

const cards = [
	{
		file: 'og.png',
		kicker: 'Writeups',
		title: 'Technical deep dives and systems engineering writeups.',
		foot: 'abokhalill.github.io',
		titleSize: 62,
	},
];

for (const name of readdirSync(CONTENT).filter((f) => f.endsWith('.md'))) {
	const fm = frontmatter(readFileSync(join(CONTENT, name), 'utf8'));
	if (!fm.image || fm.draft === 'true') continue;
	cards.push({
		file: fm.image,
		kicker: `Writeup &nbsp;·&nbsp; ${fm.date}`,
		title: fm.title,
		// Long titles need to come down a step to stay inside the card.
		titleSize: fm.title.length > 90 ? 50 : 58,
		foot: 'abokhalill.github.io/' + name.replace(/\.md$/, ''),
	});
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
// The card is loaded from a file rather than via setContent: a page on
// about:blank is not allowed to fetch file:// fonts, and silently falls back to
// a system serif — which is how the first cards shipped.
const dir = mkdtempSync(join(tmpdir(), 'og-'));
for (const c of cards) {
	const html = join(dir, 'card.html');
	writeFileSync(html, card(c));
	await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
	await page.evaluate(() => document.fonts.ready);
	const ok = await page.evaluate(() => document.fonts.check("50px 'SS4'") && [...document.fonts].every((f) => f.status !== 'error'));
	if (!ok) throw new Error('card fonts failed to load — refusing to write a fallback-font card');
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(OUT, c.file) });
	console.log('wrote public/' + c.file);
}
await browser.close();
rmSync(dir, { recursive: true, force: true });
