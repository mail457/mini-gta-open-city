/**
 * IN-GAME HUD — money, health, mission panel, compass/waypoint, speedometer,
 * circular minimap (canvas), toast notifications and the mission-result overlay.
 *
 * Owner: W-4 (UI). Consumer: Lead's `src/game/game.ts` calls
 *   hud.update(hudData)        once per frame (throws nothing; cheap)
 *   hud.toast(...)             on events
 *   hud.showMissionResult(v)   when a mission ends
 *   hud.setVisible(b)          hide while menus are up
 *   hud.setMuted(b)            M key / pause-screen toggle
 *   hud.dispose()
 *
 * Performance contract: `update()` only writes to the DOM when a value changed
 * (textContent / classList / style vars), caches every element reference and
 * only touches the minimap canvas (one cleared 2D canvas per frame + a cached
 * background image) — no layout reads, no innerHTML, no allocations per dot.
 */
import type { HudApi, HudData, MissionResultView, MissionState, XZ } from '../contracts';
import { clampToCircle, formatClock, formatMetres, formatMoney, formatSpeed, healthColor, setClass, setStyleVar, setText } from './dom';

/* -------------------------------------------------------------------------- */
/* Minimap projection (pure helpers, exported for unit tests)                 */
/* -------------------------------------------------------------------------- */

/** Minimap radius in world metres (the circular window edge). */
export const MINIMAP_RADIUS_M = 85;
/** Point hammered into the tile texture: diameter/radius ratio the spec asks for. */
export const MINIMAP_TILE_RATIO = 170 / 300;

/**
 * World → minimap pixel projection. North (−Z) is up, east (+X) is right.
 * Call with the map centre set to the player so the player sits in the middle.
 */
export function projectToMinimap(
  x: number,
  z: number,
  centreX: number,
  centreZ: number,
  radiusPx: number,
  worldRadiusM: number = MINIMAP_RADIUS_M,
): { x: number; y: number } {
  const k = radiusPx / worldRadiusM;
  return { x: radiusPx + (x - centreX) * k, y: radiusPx + (z - centreZ) * k };
}

/**
 * CSS rotation (deg) that makes a marker point from `from` towards `to`.
 * Assumes the north-up map. Returns 0 when the two points coincide.
 */
export function markerRotationDeg(x: number, z: number, centreX: number, centreZ: number): number {
  const dx = x - centreX;
  const dz = z - centreZ;
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return (Math.atan2(dz, dx) * 180) / Math.PI + 90;
}

/**
 * Compass needling: angle of the waypoint relative to the player's facing.
 * 0 = dead ahead, +90 = to the right, ±180 = behind. Player yaw convention
 * (matching ThirdPersonCamera + the walk code): forward = (−sin yaw, −cos yaw).
 */
export function waypointRelativeDeg(wp: XZ, px: number, pz: number, playerYaw: number): number {
  const fx = -Math.sin(playerYaw);
  const fz = -Math.cos(playerYaw);
  const rx = Math.cos(playerYaw);
  const rz = -Math.sin(playerYaw);
  const dx = wp.x - px;
  const dz = wp.z - pz;
  return (Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180) / Math.PI;
}

/* -------------------------------------------------------------------------- */
/* Canvas helpers                                                             */
/* -------------------------------------------------------------------------- */

const MAP_DPR_CAP = 2;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/** Draws a dot at (x, y); skips NaN. */
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Upward-pointing triangle (player). */
function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size * 0.72, y + size * 0.78);
  ctx.lineTo(x, y + size * 0.38);
  ctx.lineTo(x - size * 0.72, y + size * 0.78);
  ctx.closePath();
  ctx.fill();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * Stylish procedural city-street tile for the minimap: a 5-btn "btn" tile of
 * dark blocks separated by streets with centre dashes. Drawn ONCE at init into
 * an offscreen canvas that is then used as a repeating pattern.
 */
export function renderMinimapTile(sizePx: number, blocks = 5): HTMLCanvasElement {
  const size = Math.max(32, Math.round(sizePx));
  const tile = makeCanvas(size, size);
  const ctx = ctx2d(tile);
  if (!ctx) return tile;

  // Ground / block base: deep navy asphalt with a subtle gradient.
  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, '#0d1421');
  bg.addColorStop(1, '#0a0f19');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const cell = size / blocks;
  const road = Math.max(2, cell * 0.2);

  // Blocks (buildings) — slightly lighter charcoal with a hairline edge.
  for (let i = 0; i < blocks; i++) {
    for (let j = 0; j < blocks; j++) {
      const x = i * cell + road / 2;
      const y = j * cell + road / 2;
      const w = cell - road;
      // Vary block tone deterministically (checker + diagonal) so the map reads as a city.
      const tone = (i * 7 + j * 13) % 5;
      const shades = ['#1a2234', '#1c2539', '#182033', '#202a40', '#161d2d'];
      ctx.fillStyle = shades[tone];
      ctx.fillRect(x, y, w, w);
      // Park-green cells here and there (block (2,2) in the real layout is a park).
      if ((i === 2 && j === 2) || (i === 4 && j === 1)) {
        ctx.fillStyle = 'rgba(77, 136, 90, 0.30)';
        ctx.fillRect(x, y, w, w);
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, w - 1);
    }
  }

  // Street surfaces.
  ctx.strokeStyle = '#2a3448';
  ctx.lineWidth = road;
  ctx.lineCap = 'square';
  for (let i = 0; i <= blocks; i++) {
    const p = (i * cell) % size;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  // Kerb lines (thin bright edge either side of every road).
  ctx.strokeStyle = 'rgba(150, 170, 205, 0.22)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= blocks; i++) {
    const p = (i * cell) % size;
    for (const off of [-road / 2, road / 2]) {
      ctx.beginPath();
      ctx.moveTo(p + off, 0);
      ctx.lineTo(p + off, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p + off);
      ctx.lineTo(size, p + off);
      ctx.stroke();
    }
  }

  // Centre dashes on arterials (every street in this miniature city).
  ctx.strokeStyle = 'rgba(255, 207, 63, 0.16)';
  ctx.lineWidth = Math.max(1, Math.round(road * 0.08));
  ctx.setLineDash([cell * 0.18, cell * 0.14]);
  for (let i = 0; i <= blocks; i++) {
    const p = (i * cell) % size;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  return tile;
}

/* -------------------------------------------------------------------------- */
/* Screen layout                                                              */
/* -------------------------------------------------------------------------- */

export interface HudOptions {
  /** Point one minimap-tile edge spans, in px (defaults to MINIMAP_TILE_RATIO). */
  tileRatio?: number;
}

export interface HudController extends HudApi {
  /** Hide the whole HUD (menus / pause / result overlays). */
  setVisible(visible: boolean): void;
  /** Reflect the audio mute state (adds the MUTE ON chip on the HUD). */
  setMuted(muted: boolean): void;
  isVisible(): boolean;
  dispose(): void;
}

const VK = {
  key: 'KeyR',
  enter: 'Enter',
  numpadEnter: 'NumpadEnter',
};

export const HUD_TESTIDS = {
  hud: 'hud',
  money: 'money',
  health: 'health',
  missionPanel: 'mission-panel',
  minimap: 'minimap',
  speedo: 'speedo',
  toasts: 'toasts',
  compass: 'compass',
  result: 'mission-result',
  continueBtn: 'continue-button',
  restartBtn: 'restart-button',
  prompt: 'action-prompt',
  hint: 'objective-hint',
  crosshair: 'crosshair',
  ammo: 'ammo',
} as const;

export function createHud(root: HTMLElement, options: HudOptions = {}): HudController {
  const tileRatio = options.tileRatio && options.tileRatio > 0 ? options.tileRatio : MINIMAP_TILE_RATIO;
  const owned: HTMLElement[] = [];
  const hudRoot = document.createElement('div');
  hudRoot.className = 'mg-hud';
  hudRoot.id = 'mg-hud';
  hudRoot.setAttribute('data-testid', HUD_TESTIDS.hud);
  hudRoot.setAttribute('aria-hidden', 'true');
  owned.push(hudRoot);
  root.appendChild(hudRoot);

  /* ------------------------------ DOM skeleton ------------------------------ */

  // Top-right: money + health + clock
  const tr = document.createElement('div');
  tr.className = 'mg-hud-tr';

  const money = document.createElement('div');
  money.className = 'mg-money';
  money.setAttribute('data-testid', HUD_TESTIDS.money);
  money.setAttribute('role', 'status');
  money.setAttribute('aria-label', 'Money');
  const coin = document.createElement('span');
  coin.className = 'mg-coin';
  coin.setAttribute('aria-hidden', 'true');
  const moneyText = document.createElement('span');
  moneyText.className = 'mg-money-value';
  moneyText.textContent = '$0';
  money.append(coin, moneyText);

  const health = document.createElement('div');
  health.className = 'mg-health';
  health.setAttribute('data-testid', HUD_TESTIDS.health);
  health.setAttribute('role', 'meter');
  health.setAttribute('aria-label', 'Health');
  health.setAttribute('aria-valuemin', '0');
  health.setAttribute('aria-valuemax', '100');
  health.setAttribute('aria-valuenow', '100');
  const healthIcon = document.createElement('span');
  healthIcon.className = 'mg-health-icon';
  healthIcon.setAttribute('aria-hidden', 'true');
  const healthTrack = document.createElement('div');
  healthTrack.className = 'mg-health-track';
  const healthFill = document.createElement('div');
  healthFill.className = 'mg-health-fill';
  healthTrack.append(healthFill);
  const healthNum = document.createElement('span');
  healthNum.className = 'mg-health-num';
  healthNum.textContent = '100';
  health.append(healthIcon, healthTrack, healthNum);

  const clock = document.createElement('div');
  clock.className = 'mg-clock';
  clock.setAttribute('data-testid', 'hud-clock');
  clock.textContent = '';

  tr.append(money, health, clock);

  // Top-left: mission panel
  const missionPanel = document.createElement('section');
  missionPanel.className = 'mg-mission-panel';
  missionPanel.setAttribute('data-testid', HUD_TESTIDS.missionPanel);
  missionPanel.setAttribute('aria-label', 'Current mission');
  missionPanel.hidden = true;
  const missionHead = document.createElement('div');
  missionHead.className = 'mg-mission-head';
  const missionChip = document.createElement('span');
  missionChip.className = 'mg-mission-chip';
  const missionReward = document.createElement('span');
  missionReward.className = 'mg-mission-reward';
  missionHead.append(missionChip, missionReward);
  const missionTitle = document.createElement('h2');
  missionTitle.className = 'mg-mission-title';
  const missionObjective = document.createElement('p');
  missionObjective.className = 'mg-mission-objective';
  const missionFoot = document.createElement('div');
  missionFoot.className = 'mg-mission-foot';
  const missionTimer = document.createElement('div');
  missionTimer.className = 'mg-mission-timer';
  missionTimer.hidden = true;
  missionTimer.setAttribute('role', 'timer');
  const missionDist = document.createElement('div');
  missionDist.className = 'mg-mission-dist';
  missionFoot.append(missionTimer, missionDist);
  missionPanel.append(missionHead, missionTitle, missionObjective, missionFoot);

  // Top-centre: compass strip + waypoint needle
  const compass = document.createElement('div');
  compass.className = 'mg-compass';
  compass.setAttribute('data-testid', HUD_TESTIDS.compass);
  compass.setAttribute('aria-hidden', 'true');
  const strip = document.createElement('div');
  strip.className = 'mg-compass-strip';
  const CARDINALS: Array<[string, number]> = [
    ['N', 0],
    ['NE', 45],
    ['E', 90],
    ['SE', 135],
    ['S', 180],
    ['SW', 225],
    ['W', 270],
    ['NW', 315],
  ];
  const labelEls: HTMLElement[] = [];
  for (const [name] of CARDINALS) {
    const label = document.createElement('span');
    label.className = 'mg-compass-label' + (name === 'N' ? ' mg-n' : '');
    label.textContent = name;
    strip.append(label);
    labelEls.push(label);
  }
  for (let deg = 0; deg < 360; deg += 15) {
    const tick = document.createElement('span');
    tick.className = 'mg-compass-tick';
    strip.append(tick);
  }
  const tickEls = Array.from(strip.querySelectorAll<HTMLElement>('.mg-compass-tick'));
  const marker = document.createElement('span');
  marker.className = 'mg-compass-marker';
  strip.append(marker);
  const needle = document.createElement('div');
  needle.className = 'mg-compass-needle';
  const distLabel = document.createElement('div');
  distLabel.className = 'mg-compass-dist';
  distLabel.textContent = '▲ -- m';
  compass.append(strip, needle, distLabel);

  // Bottom-left: minimap
  const minimap = document.createElement('div');
  minimap.className = 'mg-minimap';
  minimap.setAttribute('data-testid', HUD_TESTIDS.minimap);
  minimap.setAttribute('role', 'img');
  minimap.setAttribute('aria-label', 'Minimap');
  const mapCanvas = makeCanvas(340, 340);
  mapCanvas.setAttribute('aria-hidden', 'true');
  minimap.append(mapCanvas);

  // Bottom-right: speedometer
  const speedo = document.createElement('div');
  speedo.className = 'mg-speedo';
  speedo.setAttribute('data-testid', HUD_TESTIDS.speedo);
  speedo.setAttribute('aria-label', 'Speedometer');
  speedo.hidden = true;
  const speedNum = document.createElement('div');
  speedNum.className = 'mg-speed-num';
  speedNum.textContent = '0';
  const speedMeta = document.createElement('div');
  speedMeta.className = 'mg-speed-meta';
  const speedUnit = document.createElement('span');
  speedUnit.className = 'mg-speed-unit';
  speedUnit.textContent = 'km/h';
  const gear = document.createElement('span');
  gear.className = 'mg-gear';
  gear.setAttribute('data-testid', 'gear');
  gear.textContent = 'N';
  const bars = document.createElement('div');
  bars.className = 'mg-speedo-bars';
  const BAR_COUNT = 10;
  const barEls: HTMLElement[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const b = document.createElement('span');
    b.className = 'mg-speedo-bar';
    bars.append(b);
    barEls.push(b);
  }
  speedMeta.append(speedUnit, gear, bars);
  speedo.append(speedNum, speedMeta);

  // Centre-top: toasts
  const toasts = document.createElement('div');
  toasts.className = 'mg-toasts';
  toasts.setAttribute('data-testid', HUD_TESTIDS.toasts);
  toasts.setAttribute('aria-live', 'polite');
  toasts.setAttribute('aria-atomic', 'false');

  const hintEl = document.createElement('p');
  hintEl.className = 'mg-hint';
  hintEl.dataset.testid = HUD_TESTIDS.hint;
  hintEl.hidden = true;
  hudRoot.appendChild(hintEl);

  /* ------------------------ Context action prompt ------------------------- */
  const prompt = document.createElement('div');
  prompt.className = 'mg-prompt';
  prompt.dataset.testid = HUD_TESTIDS.prompt;
  prompt.hidden = true;
  const promptKey = document.createElement('span');
  promptKey.className = 'mg-prompt-key';
  const promptText = document.createElement('span');
  promptText.className = 'mg-prompt-text';
  prompt.append(promptKey, promptText);
  /* ------------------------------ Crosshair ------------------------------- */
  const crosshair = document.createElement('div');
  crosshair.className = 'mg-crosshair';
  crosshair.dataset.testid = HUD_TESTIDS.crosshair;
  crosshair.hidden = true;
  crosshair.innerHTML =
    '<span class="mg-ch-t"></span><span class="mg-ch-r"></span><span class="mg-ch-b"></span><span class="mg-ch-l"></span><span class="mg-ch-dot"></span><span class="mg-hitmark"></span>';
  const ammoEl = document.createElement('div');
  ammoEl.className = 'mg-ammo';
  ammoEl.dataset.testid = HUD_TESTIDS.ammo;
  ammoEl.hidden = true;

  hudRoot.append(tr, missionPanel, prompt, crosshair, ammoEl, compass, minimap, speedo, toasts);

  /* ---------------------------- Mission result ----------------------------- */

  const result = document.createElement('div');
  result.className = 'mg-screen mg-result';
  result.setAttribute('data-testid', HUD_TESTIDS.result);
  result.setAttribute('role', 'dialog');
  result.setAttribute('aria-modal', 'true');
  result.setAttribute('aria-labelledby', 'mg-result-title');
  result.hidden = true;
  result.style.display = 'none';
  const resultPanel = document.createElement('div');
  resultPanel.className = 'mg-panel';
  const resultTitle = document.createElement('h2');
  resultTitle.className = 'mg-title';
  resultTitle.id = 'mg-result-title';
  const resultMission = document.createElement('p');
  resultMission.className = 'mg-result-mission';
  const resultSub = document.createElement('p');
  resultSub.className = 'mg-result-sub';
  const resultStats = document.createElement('div');
  resultStats.className = 'mg-result-stats';
  const rewardStat = document.createElement('div');
  rewardStat.className = 'mg-stat mg-stat-reward';
  const rewardLabel = document.createElement('span');
  rewardLabel.className = 'mg-stat-label';
  rewardLabel.textContent = 'Reward';
  const rewardValue = document.createElement('span');
  rewardValue.className = 'mg-stat-value';
  rewardStat.append(rewardLabel, rewardValue);
  const timeStat = document.createElement('div');
  timeStat.className = 'mg-stat';
  const timeLabel = document.createElement('span');
  timeLabel.className = 'mg-stat-label';
  timeLabel.textContent = 'Time';
  const timeValue = document.createElement('span');
  timeValue.className = 'mg-stat-value';
  timeStat.append(timeLabel, timeValue);
  resultStats.append(rewardStat, timeStat);
  const resultActions = document.createElement('div');
  resultActions.className = 'mg-actions mg-result-actions';
  const continueBtn = document.createElement('button');
  continueBtn.type = 'button';
  continueBtn.className = 'mg-btn mg-primary';
  continueBtn.setAttribute('data-testid', HUD_TESTIDS.continueBtn);
  continueBtn.setAttribute('aria-keyshortcuts', 'Enter');
  continueBtn.textContent = 'Continue';
  const restartBtn = document.createElement('button');
  restartBtn.type = 'button';
  restartBtn.className = 'mg-btn';
  restartBtn.setAttribute('data-testid', HUD_TESTIDS.restartBtn);
  restartBtn.setAttribute('aria-keyshortcuts', 'R');
  restartBtn.textContent = 'Restart';
  resultActions.append(continueBtn, restartBtn);
  const resultHint = document.createElement('p');
  resultHint.className = 'mg-fine mg-result-hint';
  resultHint.textContent = 'Enter — continue · R — restart';
  resultPanel.append(resultTitle, resultMission, resultSub, resultStats, resultActions, resultHint);
  result.append(resultPanel);
  root.appendChild(result);
  owned.push(result);

  // The overlay re-uses the same `result-button` test ids in the pause menu path?
  // No: result buttons are unique; the pause menu has its own restart button.
  const resultOverlay = result;

  /* ------------------------------ State cache ------------------------------ */

  const cached = {
    money: NaN,
    health: NaN,
    clock: '',
    missionPhase: '' as string,
    missionTitle: '',
    missionObjective: '',
    missionTimer: '',
    missionReward: NaN,
    missionDist: '',
    speed: NaN,
    gear: '',
    bars: -1,
    inVehicle: null as boolean | null,
    hasCompass: null as boolean | null,
    needleDeg: 1e9,
    width: 0,
  };

  const tile = renderMinimapTile(170 * tileRatio);
  let mapPattern: CanvasPattern | null = null;
  const mapCtx = ctx2d(mapCanvas);

  let visible = true;
  let disposed = false;
  let muted = false;
  let resultVisible = false;

  let onContinue: (() => void) | null = null;
  let onRestart: (() => void) | null = null;

  /* ------------------------------- Minimap --------------------------------- */

  function resizeMinimapIfNeeded(): void {
    const cssSize = minimap.clientWidth || 170;
    const dpr = Math.min(window.devicePixelRatio || 1, MAP_DPR_CAP);
    const px = clampToCircle(cssSize * dpr, 0, 1e9).x; // just for the number
    const size = Math.max(64, Math.round(px));
    if (size === mapCanvas.width && size === mapCanvas.height) return;
    mapCanvas.width = size;
    mapCanvas.height = size;
    mapPattern = null;
    cached.width = size;
    if (mapCtx) {
      const pattern = mapPatternFrom(mapCtx, size);
      mapPattern = pattern;
    }
  }

  function mapPatternFrom(ctx: CanvasRenderingContext2D, size: number): CanvasPattern | null {
    try {
      const p = ctx.createPattern(tile, 'repeat');
      if (p && 'setTransform' in p) {
        // One tile edge = size * MINIMAP_RADIUS_M * tileRatio world metres → exactly `size` px.
        const scale = size / tile.width;
        (p as CanvasPattern & { setTransform(t: DOMMatrix): void }).setTransform(new DOMMatrix([scale, 0, 0, scale, 0, 0]));
      }
      return p;
    } catch {
      return null;
    }
  }

  function drawMinimap(d: HudData): void {
    if (!mapCtx) return;
    const size = mapCanvas.width;
    if (size <= 1) return;
    const r = size / 2;
    const ctx = mapCtx;
    const m = d.minimap;
    const px = Number.isFinite(m.playerX) ? m.playerX : 0;
    const pz = Number.isFinite(m.playerZ) ? m.playerZ : 0;
    const k = r / MINIMAP_RADIUS_M;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // Circular clip.
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();

    // Cached street-grid background, offset by the player's world position.
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, size, size);
    if (!mapPattern) mapPattern = mapPatternFrom(ctx, size);
    if (mapPattern) {
      // One tile edge spans `r * tileRatio` world metres → r / tileRatio px.
      const scale = size / tile.width;
      const tilePx = tile.width * scale;
      const worldPerTile = (MINIMAP_RADIUS_M * 2) / 2 / tileRatio * 2; // metres per tile
      const pxPerM = k;
      const ox = ((px % worldPerTile) * pxPerM + tilePx * 1e6) % tilePx;
      const oy = ((pz % worldPerTile) * pxPerM + tilePx * 1e6) % tilePx;
      ctx.save();
      ctx.translate(r, r);
      ctx.translate(-ox, -oy);
      ctx.fillStyle = mapPattern;
      // Draw a margin so the pattern always covers the circle.
      ctx.fillRect(-tilePx, -tilePx, size + tilePx * 2, size + tilePx * 2);
      ctx.restore();
    }

    // Waypoint distance ring.
    if (m.waypoint) {
      const wx = r + (m.waypoint.x - px) * k;
      const wy = r + (m.waypoint.z - pz) * k;
      if (Math.hypot(wx - r, wy - r) < r) {
        ctx.strokeStyle = 'rgba(255, 207, 63, 0.22)';
        ctx.lineWidth = Math.max(1, size / 340);
        ctx.beginPath();
        ctx.arc(r, r, Math.hypot(wx - r, wy - r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Pedestrians (small grey dots).
    const pedR = Math.max(1, size * 0.0055);
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < m.peds.length; i++) {
      const p = m.peds[i];
      dot(ctx, r + (p.x - px) * k, r + (p.z - pz) * k, pedR, '#9aa7bd');
    }

    // Traffic (gold dots).
    const carR = Math.max(1.6, size * 0.009);
    ctx.globalAlpha = 1;
    for (let i = 0; i < m.cars.length; i++) {
      const c = m.cars[i];
      dot(ctx, r + (c.x - px) * k, r + (c.z - pz) * k, carR, '#ffcf3f');
    }

    // Waypoint diamond (pulsing) or clamped edge arrow.
    if (m.waypoint) {
      const rel = clampToCircle((m.waypoint.x - px) * k, (m.waypoint.z - pz) * k, r - size * 0.06);
      const wx = r + rel.x;
      const wy = r + rel.z;
      if (rel.clamped) {
        // Edge arrow pointing outwards.
        const ang = Math.atan2(rel.z, rel.x);
        ctx.save();
        ctx.translate(wx, wy);
        ctx.rotate(ang);
        ctx.fillStyle = '#ffcf3f';
        const s = size * 0.045;
        ctx.beginPath();
        ctx.moveTo(s, 0);
        ctx.lineTo(-s * 0.7, s * 0.75);
        ctx.lineTo(-s * 0.3, 0);
        ctx.lineTo(-s * 0.7, -s * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 240);
        ctx.save();
        ctx.shadowColor = 'rgba(255, 207, 63, 0.9)';
        ctx.shadowBlur = size * 0.03 * (0.6 + pulse);
        diamond(ctx, wx, wy, size * 0.03 * (0.85 + pulse * 0.3), '#ffcf3f');
        ctx.restore();
      }
    }

    // Player: white triangle pointing along playerYaw (map is north-up).
    // Forward = (−sin yaw, −cos yaw) in world XZ; canvas +Y = +Z.
    const heading = (Math.atan2(-Math.cos(m.playerYaw), -Math.sin(m.playerYaw)) * 180) / Math.PI + 90;
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.shadowColor = 'rgba(255, 255, 255, 0.85)';
    ctx.shadowBlur = size * 0.025;
    triangle(ctx, 0, 0, size * 0.032, '#ffffff');
    ctx.restore();

    ctx.restore(); // clip

    // North indicator.
    ctx.fillStyle = 'rgba(255, 207, 63, 0.85)';
    ctx.font = `800 ${Math.round(size * 0.055)}px "Inter", "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', r, size * 0.075);
  }

  /* -------------------------- update() per frame --------------------------- */

  function updateMission(m: MissionState): void {
    const isIdle = m.phase === 'idle' || m.phase === 'complete' || m.phase === 'failed';
    if (missionPanel.hidden !== isIdle) missionPanel.hidden = isIdle;
    if (isIdle) return;

    if (cached.missionPhase !== m.phase) {
      cached.missionPhase = m.phase;
      const chipText = m.phase === 'meet' ? 'On foot' : m.phase === 'getVehicle' ? 'Get a car' : 'Deliver';
      setText(missionChip, chipText);
    }
    setText(missionTitle, m.title || 'Mission');
    setText(missionObjective, m.objective || '');
    const rewardText = m.reward > 0 ? formatMoney(m.reward) : '';
    if (cached.missionReward !== m.reward) {
      cached.missionReward = m.reward;
      setText(missionReward, rewardText);
      missionReward.hidden = rewardText === '';
    }
    if (m.timeLeft !== null && m.timeLeft !== undefined) {
      if (missionTimer.hidden) missionTimer.hidden = false;
      const txt = formatClock(m.timeLeft);
      if (cached.missionTimer !== txt) {
        cached.missionTimer = txt;
        setText(missionTimer, txt);
        setClass(missionTimer, 'mg-low', m.timeLeft <= 10);
      } else if (m.timeLeft > 10 && missionTimer.classList.contains('mg-low')) {
        missionTimer.classList.remove('mg-low');
      }
    } else if (!missionTimer.hidden) {
      missionTimer.hidden = true;
    }
    const showDist = cached.missionDist !== '' && cached.missionDist !== '--';
    if (missionDist.hidden === showDist) missionDist.hidden = !showDist;
  }

  function updateCompass(d: HudData): void {
    const m = d.minimap;
    const dist = d.distanceToWaypoint;
    const hasWaypoint = dist !== null && Number.isFinite(dist) && dist >= 0 && m.waypoint !== null;
    if (hasWaypoint !== cached.hasCompass) {
      cached.hasCompass = hasWaypoint;
      setClass(compass, 'mg-on', hasWaypoint);
      compass.style.visibility = hasWaypoint ? 'visible' : 'hidden';
    }
    if (!hasWaypoint) return;
    const needleDegRaw = waypointRelativeDeg(m.waypoint as XZ, m.playerX, m.playerZ, m.playerYaw);
    const smooth = Math.round(needleDegRaw / 2) * 2; // 2° buckets → fewer DOM writes
    if (smooth !== cached.needleDeg) {
      cached.needleDeg = smooth;
      needle.style.transform = `rotate(${smooth}deg)`;
    }
    // Compass strip: cards slide relative to facing.
    const facingDeg = (-m.playerYaw * 180) / Math.PI;
    positionCompassStrip(facingDeg);
    setText(distLabel, `▲ ${formatMetres(dist)} m`);
  }

  let lastFacingBucket = 1e9;
  function positionCompassStrip(facingDeg: number): void {
    const bucket = Math.round(facingDeg / 2) * 2;
    if (bucket === lastFacingBucket) return;
    lastFacingBucket = bucket;
    const span = 120; // degrees visible across the strip
    for (const el of labelEls) {
      const deg = Number((el as HTMLElement & { dataset: DOMStringMap }).dataset.deg ?? 0);
      const rel = ((((deg - facingDeg) % 360) + 540) % 360) - 180;
      if (Math.abs(rel) > span / 2) {
        el.style.display = 'none';
      } else {
        el.style.display = '';
        el.style.left = `${50 + (rel / span) * 100}%`;
        el.dataset.deg = String(deg);
      }
    }
    for (const tick of tickEls) {
      const deg = Number(tick.dataset.deg ?? NaN);
      if (Number.isNaN(deg)) continue;
      const rel = ((((deg - facingDeg) % 360) + 540) % 360) - 180;
      if (Math.abs(rel) > span / 2) {
        tick.style.display = 'none';
      } else {
        tick.style.display = '';
        tick.style.left = `${50 + (rel / span) * 100}%`;
      }
    }
  }

  function updateSpeedo(d: HudData): void {
    if (d.inVehicle !== cached.inVehicle) {
      cached.inVehicle = d.inVehicle;
      speedo.hidden = !d.inVehicle;
      if (!d.inVehicle) {
        cached.speed = NaN;
        cached.gear = '';
        cached.bars = -1;
      }
    }
    if (!d.inVehicle) return;
    const kmh = Math.max(0, Number.isFinite(d.speedKmh) ? d.speedKmh : 0);
    const shown = Math.round(kmh);
    if (shown !== cached.speed) {
      cached.speed = shown;
      setText(speedNum, formatSpeed(kmh));
    }
    // Fake gearbox: R when reversing would be a contract gap (speedKmh is unsigned),
    // so show N at standstill and D once moving (arcade automatic).
    const gearText = kmh < 1 ? 'N' : kmh < 45 ? 'D2' : kmh < 90 ? 'D3' : 'D4';
    if (gearText !== cached.gear) {
      cached.gear = gearText;
      setText(gear, gearText);
    }
    const lit = Math.min(BAR_COUNT, Math.round((kmh / 140) * BAR_COUNT));
    if (lit !== cached.bars) {
      cached.bars = lit;
      for (let i = 0; i < BAR_COUNT; i++) setClass(barEls[i], 'mg-lit', i < lit);
    }
  }

  function updateHealth(h: number): void {
    const hp = Math.max(0, Math.min(100, Number.isFinite(h) ? h : 100));
    const rounded = Math.round(hp);
    if (rounded === cached.health) return;
    cached.health = rounded;
    healthFill.style.width = `${rounded}%`;
    setStyleVar(health, '--health-color', healthColor(rounded));
    setText(healthNum, String(rounded));
    health.setAttribute('aria-valuenow', String(rounded));
    const colour = healthColor(rounded);
    setStyleVar(healthIcon, 'color', colour);
  }

  function updateMoney(moneyValue: number): void {
    const rounded = Math.round(Number.isFinite(moneyValue) ? moneyValue : 0);
    if (rounded === cached.money) return;
    const first = Number.isNaN(cached.money);
    cached.money = rounded;
    setText(moneyText, formatMoney(rounded));
    if (!first) {
      // Brief pop animation — restart by removing then re-adding the class.
      money.classList.remove('mg-money-pop');
      void money.offsetWidth;
      money.classList.add('mg-money-pop');
    }
  }

  function startMission(d: HudData): void {
    updateMission(d.mission);
    updateCompass(d);
  }

  function clearMissionResult(): void {
    if (!resultVisible) return;
    resultVisible = false;
    resultOverlay.hidden = true;
    resultOverlay.style.display = 'none';
    onContinue = null;
    onRestart = null;
    window.removeEventListener('keydown', onKeyDown, true);
    hudRoot.classList.remove('mg-hidden');
    if (visible) hudRoot.hidden = false;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!resultVisible) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (e.code === VK.enter || e.code === VK.numpadEnter || e.key === 'Enter') {
      if (document.activeElement === restartBtn) return; // native button activation handles it
      e.preventDefault();
      e.stopPropagation();
      const cb = onContinue;
      clearMissionResult();
      cb?.();
      return;
    }
    if (e.code === VK.key) {
      e.preventDefault();
      e.stopPropagation();
      const cb = onRestart;
      clearMissionResult();
      cb?.();
    }
  }

  continueBtn.addEventListener('click', () => {
    const cb = onContinue;
    clearMissionResult();
    cb?.();
  });
  restartBtn.addEventListener('click', () => {
    const cb = onRestart;
    clearMissionResult();
    cb?.();
  });

  // Build compass label dataset once.
  labelEls.forEach((el, i) => {
    el.dataset.deg = String(CARDINALS[i][1]);
  });
  tickEls.forEach((el, i) => {
    el.dataset.deg = String(i * 15);
  });

  return {
    update(data: HudData): void {
      if (disposed || !data) return;
      resizeMinimapIfNeeded();
      updateMoney(data.money);
      updateHealth(data.playerHealth);
      startMission(data);
      updateSpeedo(data);
      // Context action prompt (E to enter / exit) — the single most important hint.
      const p = data.prompt ?? null;
      if (p && p.text) {
        if (prompt.hidden) prompt.hidden = false;
        setText(promptKey, p.key || 'E');
        setText(promptText, p.text);
        prompt.classList.add('mg-on');
      } else if (!prompt.hidden) {
        prompt.hidden = true;
        prompt.classList.remove('mg-on');
      }
      // Objective help line (lives just under the mission panel).
      const hintText = data.hint ?? '';
      if (hintText) {
        if (!hintEl.parentElement) hudRoot.appendChild(hintEl);
        setText(hintEl, hintText);
        if (hintEl.hidden) hintEl.hidden = false;
      } else if (!hintEl.hidden) {
        hintEl.hidden = true;
      }
      // Ammo readout for the armed player.
      const ammo = data.ammo ?? null;
      if (ammo) {
        if (ammoEl.hidden) ammoEl.hidden = false;
        const text = `${ammo.mag} / ${ammo.reserve}`;
        if (ammoEl.textContent !== `${ammo.name}\u0000${text}`) {
          ammoEl.textContent = text;
          ammoEl.dataset.name = ammo.name;
        }
        if (ammo.mag === 0) ammoEl.classList.add('mg-empty');
        else ammoEl.classList.remove('mg-empty');
      } else if (!ammoEl.hidden) {
        ammoEl.hidden = true;
      }
      const label = typeof data.timeOfDayLabel === 'string' ? data.timeOfDayLabel : '';
      if (cached.clock !== label) {
        cached.clock = label;
        setText(clock, label);
      }
      drawMinimap(data);
    },

    toast(text: string, kind: 'info' | 'good' | 'bad' = 'info', duration = 2600): void {
      if (disposed || !text) return;
      const node = document.createElement('div');
      node.className = `mg-toast mg-toast-${kind}`;
      node.setAttribute('role', 'status');
      node.textContent = String(text);
      toasts.appendChild(node);
      while (toasts.childElementCount > 4) toasts.firstElementChild?.remove();
      const life = Math.max(350, Math.min(20000, duration));
      const t1 = window.setTimeout(() => node.classList.add('mg-toast-out'), Math.max(0, life - 240));
      const t2 = window.setTimeout(() => {
        node.remove();
        window.clearTimeout(t1);
      }, life);
      // Keep timers cheap: clear both when the element is removed early.
      (node as HTMLElement & { _t?: number[] })._t = [t1, t2];
    },

    showMissionResult(view: MissionResultView, actions?: { onContinue?: () => void; onRestart?: () => void }): void {
      if (disposed) return;
      resultVisible = true;
      onContinue = actions?.onContinue ?? null;
      onRestart = actions?.onRestart ?? null;
      const success = !!view.success;
      resultOverlay.classList.toggle('mg-fail', !success);
      setText(resultTitle, success ? 'Mission complete' : 'Mission failed');
      setText(resultMission, view.title || '');
      setText(resultSub, view.subtitle || '');
      const rewardOk = success && Number.isFinite(view.reward) && view.reward > 0;
      rewardValue.textContent = rewardOk ? `+${formatMoney(view.reward)}` : formatMoney(0);
      const total = Number.isFinite(view.timeSeconds) ? Math.max(0, view.timeSeconds) : 0;
      timeValue.textContent = formatClock(Math.round(total));
      resultOverlay.hidden = false;
      resultOverlay.style.display = '';
      hudRoot.classList.add('mg-hidden');
      window.addEventListener('keydown', onKeyDown, true);
      // Focus the primary action for keyboard users (do not scroll the page).
      try {
        continueBtn.focus({ preventScroll: true });
      } catch {
        continueBtn.focus();
      }
      toasts.replaceChildren();
    },

    clearMissionResult,

    setCrosshair(show: boolean, kick = 0): void {
      if (disposed) return;
      if (crosshair.hidden === show) crosshair.hidden = !show;
      if (show) crosshair.style.setProperty('--ch-kick', `${Math.round(kick * 10)}px`);
    },

    pulseHitMarker(): void {
      if (disposed) return;
      const m = crosshair.querySelector('.mg-hitmark') as HTMLElement | null;
      if (!m) return;
      m.classList.remove('mg-hit');
      void m.offsetWidth; // restart the animation
      m.classList.add('mg-hit');
    },

    setVisible(show: boolean): void {
      visible = show;
      if (disposed) return;
      if (!show) {
        hudRoot.hidden = true;
        hudRoot.style.display = 'none';
        hudRoot.style.pointerEvents = 'none';
      } else {
        hudRoot.hidden = false;
        hudRoot.style.display = '';
      }
      // Note: `visible` only controls the HUD; the result overlay is independent.
    },

    setMuted(isMuted: boolean): void {
      muted = isMuted;
      hudRoot.classList.toggle('mg-muted', muted);
      if (muted) {
        if (!clock.textContent || clock.textContent.indexOf('MUTE') < 0) {
          cached.clock = '';
        }
      }
    },

    isVisible(): boolean {
      return visible && !hudRoot.hidden;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearMissionResult();
      window.removeEventListener('keydown', onKeyDown, true);
      for (const node of owned) node.remove();
      owned.length = 0;
      mapPattern = null;
    },
  };
}
