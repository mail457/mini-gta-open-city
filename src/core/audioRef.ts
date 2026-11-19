import { Audio } from './audio';
import type { AudioBus } from '../contracts';

/**
 * Process-wide audio bus. The WebAudio context is created lazily on first sound,
 * so constructing this before any user gesture is safe (browsers start it suspended).
 */
export const AUDIO: AudioBus = new Audio();
