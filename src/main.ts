import './ui/styles.css';
import { Foundation } from './game/foundation';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
const root = document.getElementById('ui-root');

function fatal(message: string): void {
  if (!root) return;
  root.innerHTML = `
    <div class="fatal-screen">
      <h1>MINI GTA — OPEN CITY</h1>
      <p class="fatal-title">The game could not start.</p>
      <p class="fatal-detail">${message}</p>
      <p class="fatal-hint">Please use a recent version of Safari or Chrome with hardware acceleration enabled, then reload.</p>
    </div>`;
}

try {
  if (!canvas) throw new Error('Canvas element #game-canvas is missing.');
  new Foundation(canvas);
} catch (err) {
  console.error(err);
  fatal(err instanceof Error ? err.message : String(err));
}
