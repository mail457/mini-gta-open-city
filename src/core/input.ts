import type { InputFrame, InputState } from '../contracts';

/**
 * Keyboard + mouse input with pointer lock.
 * Owned by: Lead. Agents consume InputFrame only.
 */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private frame: InputFrame = {
    moveX: 0,
    moveY: 0,
    sprint: false,
    jump: false,
    interact: false,
    pauseToggle: false,
    handbrake: false,
    lookX: 0,
    lookY: 0,
  };
  active = false;
  pointerLocked = false;
  /** Notified when the player releases pointer lock (used to auto-pause). */
  onPointerLockLost: (() => void) | null = null;
  private canvas: HTMLElement;
  private mouseSensitivity = 0.0024;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('contextmenu', (e) => {
      if (this.pointerLocked) e.preventDefault();
    });
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.active && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) {
      e.preventDefault();
    }
    if (!this.keys.has(e.code)) this.pressed.add(e.code);
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.pressed.clear();
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private onMouseDown = () => {
    if (this.active && !this.pointerLocked) this.requestLock();
  };

  private onLockChange = () => {
    const was = this.pointerLocked;
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (was && !this.pointerLocked) this.onPointerLockLost?.();
  };

  requestLock(): void {
    if (this.pointerLocked) return;
    try {
      const p = (this.canvas.requestPointerLock as (opts?: { unadjustedMovement?: boolean }) => unknown)({
        unadjustedMovement: false,
      });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {
          /* Browser refused (e.g. not a user gesture). Game stays playable with keyboard-only camera. */
        });
      }
    } catch {
      /* Old browsers without options argument. */
    }
  }

  releaseLock(): void {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Consume edge state. Call once per rendered frame from the game loop. */
  consume(): InputFrame {
    const f = this.frame;
    const k = this.keys;
    f.moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    f.moveY = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    f.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    f.jump = k.has('Space');
    f.interact = this.pressed.has('KeyE') || this.pressed.has('KeyF');
    f.pauseToggle = this.pressed.has('Escape') || this.pressed.has('KeyP');
    f.handbrake = k.has('Space');
    f.lookX = this.mouseDX * this.mouseSensitivity;
    f.lookY = this.mouseDY * this.mouseSensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.pressed.clear();
    return f;
  }

  /** True if a key was freshly pressed since last consume. For UI screens. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  snap(): InputState {
    if (this.active) this.consume();
    return { ...this.frame, active: this.active };
  }

  reset(): void {
    this.keys.clear();
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
  }
}
