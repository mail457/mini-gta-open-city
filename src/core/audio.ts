import type { AudioBus, SoundName } from '../contracts';

/**
 * Tiny WebAudio synthesiser — no audio assets, every sound is generated.
 * Owned by: Lead. Safe to construct before any user gesture (context starts suspended).
 */
export class Audio implements AudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private muted = false;
  private engineStarted = false;
  private dead = false;
  private lastUnlock = 0;

  private ensure(): AudioContext | null {
    // A NaN/Infinity buffer or gain can permanently kill the AudioContext
    // ("Render quantum size ... invalid"). Once that happens we never use it again.
    if (this.dead) return null;
    if (this.ctx && this.ctx.state === 'closed') {
      this.ctx = null;
      this.master = null;
      this.engineStarted = false;
    }
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && performance.now() - this.lastUnlock > 250) {
        this.lastUnlock = performance.now();
        void this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.ctx.addEventListener?.('statechange', () => {
        if (this.ctx && this.ctx.state === 'closed') this.dead = true;
      });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    }
  }

  play(name: SoundName, volume = 1): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    switch (name) {
      case 'coin':
        this.blip(880, 0.08, 'square', 0.25 * volume, t);
        this.blip(1320, 0.12, 'square', 0.2 * volume, t + 0.07);
        break;
      case 'missionStart':
        this.blip(440, 0.14, 'sawtooth', 0.18 * volume, t);
        this.blip(660, 0.14, 'sawtooth', 0.18 * volume, t + 0.12);
        this.blip(880, 0.3, 'sawtooth', 0.18 * volume, t + 0.24);
        break;
      case 'missionComplete':
        this.blip(523, 0.12, 'triangle', 0.25 * volume, t);
        this.blip(659, 0.12, 'triangle', 0.25 * volume, t + 0.12);
        this.blip(784, 0.12, 'triangle', 0.25 * volume, t + 0.24);
        this.blip(1046, 0.4, 'triangle', 0.25 * volume, t + 0.36);
        break;
      case 'jump':
        this.sweep(300, 600, 0.18, 'sine', 0.15 * volume, t);
        break;
      case 'step':
        this.sweep(140, 70, 0.06, 'sine', 0.08 * volume, t);
        break;
      case 'enterCar':
        this.sweep(120, 90, 0.15, 'square', 0.12 * volume, t);
        break;
      case 'exitCar':
        this.sweep(180, 120, 0.12, 'square', 0.1 * volume, t);
        break;
      case 'crash':
        this.noise(0.2, 0.3 * volume, t);
        break;
      case 'horn':
        this.blip(392, 0.25, 'square', 0.12 * volume, t);
        this.blip(494, 0.25, 'square', 0.1 * volume, t);
        break;
      case 'ui':
        this.blip(660, 0.05, 'sine', 0.15 * volume, t);
        break;
    }
  }

  private blip(freq: number, dur: number, type: OscillatorType, vol: number, when: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(this.master!);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  private sweep(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, when: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), when + dur);
    g.gain.setValueAtTime(Math.max(vol, 0.0002), when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(this.master!);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  private noise(dur: number, vol: number, when: number): void {
    const ctx = this.ctx!;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    g.gain.value = vol;
    src.buffer = buf;
    src.connect(filter).connect(g).connect(this.master!);
    src.start(when);
  }

  setEngine(rpm: number, playing: boolean): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    if (!this.engineStarted) {
      this.engineStarted = true;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 520;
      this.engineOsc = ctx.createOscillator();
      this.engineOsc.type = 'sawtooth';
      this.engineOsc.frequency.value = 60;
      this.engineOsc2 = ctx.createOscillator();
      this.engineOsc2.type = 'square';
      this.engineOsc2.frequency.value = 30;
      this.engineOsc.connect(filter);
      this.engineOsc2.connect(filter);
      filter.connect(this.engineGain).connect(this.master);
      this.engineOsc.start();
      this.engineOsc2.start();
    }
    const t = ctx.currentTime;
    if (!Number.isFinite(rpm)) rpm = 0;
    const target = playing && !this.muted ? 0.06 + rpm * 0.06 : 0;
    this.engineGain!.gain.setTargetAtTime(target, t, 0.1);
    const f = 50 + rpm * 150;
    this.engineOsc!.frequency.setTargetAtTime(f, t, 0.08);
    this.engineOsc2!.frequency.setTargetAtTime(f * 0.5, t, 0.08);
  }

  dispose(): void {
    try {
      this.engineOsc?.stop();
      this.engineOsc2?.stop();
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }
}
