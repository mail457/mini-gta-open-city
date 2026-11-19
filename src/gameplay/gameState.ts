/**
 * GAME STATE — tiny, pure, framework-free. Owned by: Agent 3 (Gameplay).
 *
 * Holds the two player-facing numbers the HUD / Debug API read every frame
 * (money, health) plus the small amount of bookkeeping the Lead needs around
 * them. No THREE, no DOM, no timers: every method is a pure state transition,
 * so it is trivially unit-testable and deterministic.
 *
 * The Lead owns orchestration (game.ts); this class only stores numbers.
 */

export interface GameStateSnapshot {
  money: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  earns: number;
  spends: number;
  damages: number;
  deaths: number;
}

export const DEFAULT_MAX_HEALTH = 100;
export const DEFAULT_START_MONEY = 0;

export class GameState {
  /** Cash on hand (never negative, always an integer). */
  money = DEFAULT_START_MONEY;
  /** Current health in [0, maxHealth]. */
  health = DEFAULT_MAX_HEALTH;
  /** Upper bound for `health` (HUD health bar, medkits). */
  maxHealth = DEFAULT_MAX_HEALTH;
  /** Lifetime counters (debug / stats). */
  readonly stats = { earns: 0, spends: 0, damages: 0, deaths: 0 };

  constructor(money: number = DEFAULT_START_MONEY, maxHealth: number = DEFAULT_MAX_HEALTH) {
    this.maxHealth = Math.max(1, Math.round(Number.isFinite(maxHealth) ? maxHealth : DEFAULT_MAX_HEALTH));
    this.reset(money, this.maxHealth);
  }

  /** True while health > 0. */
  get alive(): boolean {
    return this.health > 0;
  }

  /** Small serialisable copy (handy for DebugApi.snapshot). */
  snapshot(): GameStateSnapshot {
    return {
      money: this.money,
      health: this.health,
      maxHealth: this.maxHealth,
      alive: this.alive,
      earns: this.stats.earns,
      spends: this.stats.spends,
      damages: this.stats.damages,
      deaths: this.stats.deaths,
    };
  }

  /**
   * Add money (negative amounts remove it). Balance is clamped to >= 0 and
   * rounded to whole dollars. Returns the new balance. NaN / Infinity ignored.
   */
  addMoney(amount: number): number {
    if (Number.isFinite(amount)) {
      if (amount > 0) this.stats.earns++;
      else if (amount < 0) this.stats.spends++;
      this.money = Math.max(0, Math.round(this.money + amount));
    }
    return this.money;
  }

  /** Spend money only if affordable. Returns true when the purchase went through. */
  trySpend(amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (this.money < amount) return false;
    this.addMoney(-amount);
    return true;
  }

  /**
   * Apply damage. Returns true on the tick the player dies (health hits 0).
   * `stats.deaths` counts these transitions; further calls at 0 return false.
   */
  damage(amount: number): boolean {
    if (!Number.isFinite(amount) || amount <= 0 || this.health <= 0) return false;
    this.stats.damages++;
    this.health = Math.max(0, this.health - amount);
    if (this.health === 0) {
      this.stats.deaths++;
      return true;
    }
    return false;
  }

  /** Restore health (never above maxHealth). Returns the amount actually healed. */
  heal(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return this.health - before;
  }

  /** Instantly zero the health bar ("busted" / fall damage). Returns true when it killed. */
  kill(): boolean {
    return this.health > 0 ? this.damage(this.health) : false;
  }

  /**
   * Reset to fresh values. Called with no arguments it is a full player reset
   * (money = 0, health = max). Pass values to keep a run going
   * (e.g. `gs.reset(gs.money)` after a respawn). Counters are cleared.
   */
  reset(money: number = DEFAULT_START_MONEY, health: number = this.maxHealth): void {
    this.money = Math.max(0, Math.round(Number.isFinite(money) ? money : 0));
    const h = Number.isFinite(health) ? health : this.maxHealth;
    this.health = Math.max(0, Math.min(this.maxHealth, h));
    this.stats.earns = 0;
    this.stats.spends = 0;
    this.stats.damages = 0;
    this.stats.deaths = 0;
  }
}

/** Factory mirroring the `createX(...)` style used across the gameplay module. */
export function createGameState(money?: number, maxHealth?: number): GameState {
  return new GameState(money, maxHealth);
}
