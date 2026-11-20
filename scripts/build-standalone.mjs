/**
 * Builds a single self-contained HTML file that runs straight from the file
 * system (no server):  release/MINI-GTA-OPEN-CITY-STANDALONE.html
 *
 * Browsers refuse to load ES-module scripts and CSS from file:// URLs (CORS
 * blocks origin "null"), so this build inlines everything into one classic
 * <script> and one <style> block.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const OUT = process.env.STANDALONE_OUT ?? '/tmp';

// esbuild needs a real output path to emit the CSS imported by main.ts, so we
// bundle into a throwaway directory and read both files back.
const tmp = resolve(tmpdir(), `mini-gta-standalone-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2019',
  charset: 'utf8',
  minify: true,
  outdir: tmp,
  entryNames: 'app',
  define: { 'import.meta.env.DEV': 'false' },
  logLevel: 'warning',
});
const js = readFileSync(resolve(tmp, 'app.js'), 'utf8');
const style = readFileSync(resolve(tmp, 'app.css'), 'utf8');
rmSync(tmp, { recursive: true, force: true });
if (!js || !style) throw new Error('bundle output missing');

// Close tags inside the script must not terminate the <script> element.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0b0f1a" />
    <title>MINI GTA — OPEN CITY</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b0f1a'/%3E%3Ctext x='32' y='44' font-size='34' font-family='Arial Black,Arial' font-weight='900' text-anchor='middle' fill='%23ffcf3f'%3EM%3C/text%3E%3C/svg%3E" />
    <style>${style}</style>
  </head>
  <body>
    <div id="app">
      <canvas id="game-canvas" aria-label="Game viewport"></canvas>
      <div id="ui-root"></div>
    </div>
    <noscript><p style="color:#fff;font-family:sans-serif;padding:2rem">MINI GTA needs JavaScript.</p></noscript>
    <script>${safeJs}</script>
  </body>
</html>
`;

const outPath = process.env.STANDALONE_OUT
  ? `${OUT}/MINI-GTA-OPEN-CITY-STANDALONE.html`
  : resolve(root, 'release/MINI-GTA-OPEN-CITY-STANDALONE.html');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);
console.log(`✔ ${outPath} (${(html.length / 1048576).toFixed(2)} MB, v${pkg.version})`);
