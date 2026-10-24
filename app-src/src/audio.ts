// iOS Safari audio unlock helpers.
// Called synchronously inside the first user gesture.

let silentEl: HTMLAudioElement | null = null;

function silentWavDataUri(): string {
  // 0.5 s of 8 kHz mono 8-bit silence, generated at runtime.
  const samples = 4000;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

/** iOS 17+: play through the ringer/silent switch. */
export function setPlaybackSession(): void {
  try {
    const nav = navigator as unknown as { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'playback';
  } catch { /* ignore */ }
}

/** Fallback for older iOS: a looping silent <audio> element switches the
 *  page to the "playback" audio category so the mute switch doesn't silence Web Audio. */
export function startSilentAudioElement(): void {
  try {
    if (!silentEl) {
      silentEl = document.createElement('audio');
      silentEl.setAttribute('x-webkit-airplay', 'deny');
      silentEl.setAttribute('playsinline', '');
      silentEl.preload = 'auto';
      silentEl.loop = true;
      silentEl.src = silentWavDataUri();
    }
    const p = silentEl.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

/** Play a one-sample silent buffer; must happen inside a user gesture. */
export function playSilentBuffer(ctx: AudioContext): void {
  try {
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* ignore */ }
}

export function ensureRunning(ctx: AudioContext | null | undefined): void {
  if (!ctx) return;
  const state = ctx.state as string;
  if (state === 'suspended' || state === 'interrupted') {
    void ctx.resume().catch(() => { /* ignore */ });
  }
}

/** Full unlock sequence, synchronous within a gesture handler. */
export function unlockAudio(ctx: AudioContext): void {
  setPlaybackSession();
  startSilentAudioElement();
  ensureRunning(ctx);
  playSilentBuffer(ctx);
}

/** Keep the context alive: resume on visibility return and on any later tap. */
export function installKeepAlive(getCtx: () => AudioContext | null | undefined): () => void {
  const onVis = () => {
    if (document.visibilityState === 'visible') {
      setPlaybackSession();
      ensureRunning(getCtx());
    }
  };
  const onGesture = () => {
    const ctx = getCtx();
    if (!ctx) return;
    const state = ctx.state as string;
    if (state !== 'running') {
      setPlaybackSession();
      startSilentAudioElement();
      ensureRunning(ctx);
      playSilentBuffer(ctx);
    }
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pageshow', onVis);
  window.addEventListener('touchend', onGesture, true);
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('click', onGesture, true);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pageshow', onVis);
    window.removeEventListener('touchend', onGesture, true);
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('click', onGesture, true);
  };
}
