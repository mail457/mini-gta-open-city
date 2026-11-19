import './ui/styles.css';
import { Game } from './game/game';
import { createHud } from './ui/hud';
import { createScreens } from './ui/menu';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
const root = document.getElementById('ui-root');

function fatal(message: string): void {
  if (!root) return;
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'fatal-screen';
  const h = document.createElement('h1');
  h.textContent = 'MINI GTA — OPEN CITY';
  const t = document.createElement('p');
  t.className = 'fatal-title';
  t.textContent = 'The game could not start.';
  const d = document.createElement('p');
  d.className = 'fatal-detail';
  d.textContent = message;
  const hint = document.createElement('p');
  hint.className = 'fatal-hint';
  hint.textContent =
    'Please use a recent version of Safari or Chrome with hardware acceleration (WebGL) enabled, then reload.';
  wrap.append(h, t, d, hint);
  root.append(wrap);
}

try {
  if (!canvas) throw new Error('Canvas element #game-canvas is missing.');
  if (!root) throw new Error('UI root element #ui-root is missing.');
  canvas.tabIndex = 0;
  const game = new Game(canvas, { root, createHud, createScreens });
  // Test hook: the debug API is also what Playwright drives.
  if (import.meta.env.DEV) {
    console.info('[mini-gta] ready', JSON.stringify(game.snapshot()));
  }
} catch (err) {
  console.error(err);
  fatal(err instanceof Error ? err.message : String(err));
}
