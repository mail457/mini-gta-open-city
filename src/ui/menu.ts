/**
 * Menu screens: start, controls, pause. (Step 4 — UI engineer deliverable.)
 *
 * The mission-result overlay lives in hud.ts (it is part of the HUD's state), so
 * this module focuses on the pre-game and paused screens. It renders purely from
 * the status it is given; all game flow is driven by the Lead's callbacks.
 */
import type { GameStatus, MissionResultView } from '../contracts';
import type { ScreensApi, ScreenCallbacks } from '../game/game';

export interface MenuScreens extends ScreensApi {
  /** True while a menu screen (not the result overlay) is visible. */
  isMenuOpen(): boolean;
  showLoading(): void;
  dispose(): void;
}

const CONTROLS: Array<[string[], string]> = [
  [['W', 'A', 'S', 'D'], 'Walk / drive · steer'],
  [['Mouse'], 'Look around'],
  [['Shift'], 'Sprint'],
  [['Space'], 'Jump · handbrake'],
  [['E'], 'Enter / exit vehicle'],
  [['LMB'], 'Fire weapon'],
  [['R', '1', '2'], 'Reload · pistol / SMG'],
  [['Esc', 'P'], 'Pause'],
  [['⌫'], 'Restart run'],
  [['M'], 'Mute sound'],
];

function kbd(label: string): HTMLElement {
  const node = document.createElement('span');
  node.className = label.length > 2 ? 'mg-kbd mg-kbd-wide' : 'mg-kbd';
  node.textContent = label;
  return node;
}

function btn(label: string, testid: string, opts: { primary?: boolean; onClick: () => void }): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `mg-btn${opts.primary ? ' mg-primary' : ''}`;
  b.dataset.testid = testid;
  b.textContent = label;
  b.addEventListener('click', opts.onClick);
  return b;
}

function panel(children: HTMLElement[]): HTMLElement {
  const p = document.createElement('div');
  p.className = 'mg-panel';
  p.append(...children);
  return p;
}

function legend(): HTMLElement {
  const l = document.createElement('div');
  l.className = 'mg-legend';
  for (const [keys, action] of CONTROLS) {
    const row = document.createElement('div');
    row.className = 'mg-legend-row';
    const keysWrap = document.createElement('div');
    keysWrap.className = 'mg-legend-keys';
    keys.forEach((k, i) => {
      if (i) keysWrap.append(document.createTextNode(' '));
      keysWrap.append(kbd(k));
    });
    const act = document.createElement('div');
    act.className = 'mg-legend-action';
    act.textContent = action;
    row.append(keysWrap, act);
    l.append(row);
  }
  return l;
}

export function createScreens(root: HTMLElement, cb: ScreenCallbacks): MenuScreens {
  const owned: HTMLElement[] = [];

  /* ------------------------------- Start --------------------------------- */
  const startScreen = document.createElement('section');
  startScreen.className = 'mg-screen mg-start';
  startScreen.dataset.testid = 'start-screen';
  startScreen.setAttribute('aria-label', 'Main menu');

  const kicker = document.createElement('p');
  kicker.className = 'mg-kicker';
  kicker.textContent = 'Mini open-world action';
  const title = document.createElement('h1');
  title.className = 'mg-title';
  title.textContent = 'MINI GTA';
  const subtitle = document.createElement('p');
  subtitle.className = 'mg-subtitle';
  subtitle.textContent = 'OPEN CITY';
  const rule = document.createElement('div');
  rule.className = 'mg-rule';
  const copy = document.createElement('p');
  copy.className = 'mg-copy';
  copy.textContent = 'A tiny city. One delivery. Infinite detours.';
  const playBtn = btn('PLAY', 'play-button', { primary: true, onClick: () => cb.onPlay() });
  const controlsBtn = btn('HOW TO PLAY', 'controls-button', { onClick: () => cb.onShowControls() });
  const actions = document.createElement('div');
  actions.className = 'mg-actions';
  actions.append(playBtn, controlsBtn);
  // Essential keys, shown before the player even starts.
  const quick = document.createElement('div');
  quick.className = 'mg-quickkeys';
  for (const [keys, label] of [['WASD', 'walk / drive'], ['Mouse', 'look / fire'], ['E', 'enter / exit car'], ['Esc', 'pause']] as Array<[string, string]>) {
    const item = document.createElement('span');
    item.className = 'mg-quickkey';
    item.append(kbd(keys), document.createTextNode(label));
    quick.append(item);
  }
  const footer = document.createElement('p');
  footer.className = 'mg-fine mg-footer';
  footer.textContent = 'Runs in your browser · no download · headphones on';
  startScreen.append(panel([kicker, title, subtitle, rule, copy, quick, actions, footer]));
  owned.push(startScreen);

  /* ------------------------------ Controls ------------------------------- */
  const controlsScreen = document.createElement('section');
  controlsScreen.className = 'mg-screen mg-controls';
  controlsScreen.dataset.testid = 'controls-screen';
  controlsScreen.setAttribute('aria-label', 'Controls');
  const cKicker = document.createElement('p');
  cKicker.className = 'mg-kicker';
  cKicker.textContent = 'Controls';
  const cTitle = document.createElement('h2');
  cTitle.className = 'mg-title';
  cTitle.textContent = 'How to play';
  const backBtn = btn('BACK', 'back-button', { onClick: () => cb.onBack() });
  const cActions = document.createElement('div');
  cActions.className = 'mg-actions';
  cActions.append(backBtn);
  const cFootnote = document.createElement('p');
  cFootnote.className = 'mg-fine mg-controls-footnote';
  cFootnote.textContent = 'Click the game view to capture the mouse. Press Esc to release it.';
  const cPanel = panel([cKicker, cTitle, legend(), cFootnote, cActions]);
  cPanel.classList.add('mg-controls-panel');
  controlsScreen.append(cPanel);
  owned.push(controlsScreen);

  /* -------------------------------- Pause -------------------------------- */
  const pauseScreen = document.createElement('section');
  pauseScreen.className = 'mg-screen mg-pause';
  pauseScreen.dataset.testid = 'pause-screen';
  pauseScreen.setAttribute('role', 'dialog');
  pauseScreen.setAttribute('aria-modal', 'true');
  pauseScreen.setAttribute('aria-label', 'Paused');
  const pTitle = document.createElement('h2');
  pTitle.className = 'mg-title';
  pTitle.textContent = 'Paused';
  const pSub = document.createElement('p');
  pSub.className = 'mg-copy';
  pSub.textContent = 'The city can wait.';
  const resumeBtn = btn('RESUME', 'resume-button', { primary: true, onClick: () => cb.onResume() });
  const restartBtn = btn('RESTART RUN', 'restart-button', { onClick: () => cb.onRestart() });
  const pauseControlsBtn = btn('CONTROLS', 'controls-button', { onClick: () => cb.onShowControls() });
  const muteBtn = btn('MUTE: OFF', 'mute-button', { onClick: () => cb.onToggleMute() });
  const menuBtn = btn('QUIT TO MENU', 'quit-button', { onClick: () => cb.onQuitToMenu() });
  const pRow = document.createElement('div');
  pRow.className = 'mg-actions mg-pause-actions-row';
  pRow.append(resumeBtn, restartBtn);
  const pRow2 = document.createElement('div');
  pRow2.className = 'mg-actions-row';
  pRow2.append(muteBtn, pauseControlsBtn);
  const pActions = document.createElement('div');
  pActions.className = 'mg-actions';
  pActions.append(pRow, pRow2, menuBtn);
  const pPanel = panel([pTitle, pSub, pActions]);
  pPanel.classList.add('mg-pause-panel');
  pauseScreen.append(pPanel);
  owned.push(pauseScreen);

  root.append(startScreen, controlsScreen, pauseScreen);

  let status: GameStatus = 'loading';
  let lastPlaying: GameStatus = 'menu';
  let muted = false;

  const apply = () => {
    startScreen.hidden = !(status === 'menu' || status === 'loading');
    controlsScreen.hidden = status !== 'controls';
    pauseScreen.hidden = status !== 'paused';
    if (status === 'menu') {
      try {
        playBtn.focus({ preventScroll: true });
      } catch {
        playBtn.focus();
      }
    } else if (status === 'paused') {
      try {
        resumeBtn.focus({ preventScroll: true });
      } catch {
        resumeBtn.focus();
      }
    }
  };
  apply();

  return {
    show(next: GameStatus): void {
      if (next !== 'controls' && next !== 'menu') lastPlaying = next === 'paused' ? lastPlaying : next;
      status = next;
      apply();
    },
    showMissionResult(_v: MissionResultView, _onContinue: () => void, _onRestart: () => void): void {
      // Rendered by the HUD overlay (hud.showMissionResult); nothing to do here.
      status = 'missionResult';
      apply();
    },
    setMuted(m: boolean): void {
      muted = m;
      muteBtn.textContent = `MUTE: ${muted ? 'ON' : 'OFF'}`;
    },
    isMenuOpen(): boolean {
      return status === 'menu' || status === 'controls' || status === 'paused';
    },
    showLoading(): void {
      status = 'loading';
      playBtn.disabled = true;
      playBtn.textContent = 'LOADING…';
      apply();
    },
    dispose(): void {
      for (const el of owned) el.remove();
    },
  };
}
