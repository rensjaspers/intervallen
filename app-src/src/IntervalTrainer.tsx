import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { unlockAudio, ensureRunning, installKeepAlive, setPlaybackSession } from './audio';

type Quality = 'perfect' | 'major' | 'minor' | 'tritone';

interface Interval {
  semis: number;
  short: string;
  name: string;
  hint?: string;
  quality: Quality;
}

interface Level {
  id: number;
  name: string;
  detail: string;
  fixedRoot: boolean;
  harmonic: boolean;
  labels: boolean;
  peek: boolean;
}

interface Round {
  root: number;
  semis: number;
}

interface Feedback {
  ok: boolean;
  picked: number;
  answer: number;
}

interface Geom {
  whiteW: number;
  blackW: number;
}

interface KeyLayout {
  midi: number;
  left: number;
  width: number;
  center: number;
  black: boolean;
}

interface AudioEngine {
  ctx: AudioContext;
  dest: AudioNode;
}

interface DomPress {
  preventDefault: () => void;
  stopPropagation: () => void;
  currentTarget: EventTarget | null;
}

type Phase = 'playing' | 'answer' | 'feedback';
type Review = 'correct' | 'yours';

const INTERVALS: readonly Interval[] = [
  { semis: 0, short: 'P1', name: 'reine prime', quality: 'perfect' },
  { semis: 1, short: 'k2', name: 'kleine secunde', quality: 'minor' },
  { semis: 2, short: 'g2', name: 'grote secunde', quality: 'major' },
  { semis: 3, short: 'k3', name: 'kleine terts', quality: 'minor' },
  { semis: 4, short: 'g3', name: 'grote terts', quality: 'major' },
  { semis: 5, short: '4', name: 'reine kwart', quality: 'perfect' },
  {
    semis: 6,
    short: 'tt',
    name: 'tritonus',
    hint: 'overmatige kwart / verminderde kwint',
    quality: 'tritone',
  },
  { semis: 7, short: '5', name: 'reine kwint', quality: 'perfect' },
  { semis: 8, short: 'k6', name: 'kleine sext', quality: 'minor' },
  { semis: 9, short: 'g6', name: 'grote sext', quality: 'major' },
  { semis: 10, short: 'k7', name: 'kleine septiem', quality: 'minor' },
  { semis: 11, short: 'g7', name: 'grote septiem', quality: 'major' },
  { semis: 12, short: '8', name: 'reine octaaf', quality: 'perfect' },
];

const LEVELS: readonly Level[] = [
  {
    id: 1,
    name: 'Meekijken',
    detail: 'Vanaf C, na elkaar. De toetsen blijven branden.',
    fixedRoot: true,
    harmonic: false,
    labels: true,
    peek: true,
  },
  {
    id: 2,
    name: 'Op gehoor',
    detail: 'Vanaf C, na elkaar. Labels blijven, toetsen niet.',
    fixedRoot: true,
    harmonic: false,
    labels: true,
    peek: false,
  },
  {
    id: 3,
    name: 'Andere grondtoon',
    detail: 'Willekeurige start. De labels schuiven mee.',
    fixedRoot: false,
    harmonic: false,
    labels: true,
    peek: false,
  },
  {
    id: 4,
    name: 'Zonder labels',
    detail: 'Alleen de grondtoon staat nog aangegeven.',
    fixedRoot: false,
    harmonic: false,
    labels: false,
    peek: false,
  },
  {
    id: 5,
    name: 'Samen',
    detail: 'Willekeurige start, twee noten tegelijk.',
    fixedRoot: false,
    harmonic: true,
    labels: false,
    peek: false,
  },
];

const LOW_MIDI = 48;
const HIGH_MIDI = 72;
const FIXED_ROOT = 60;
const ROOT_MIN = 48;
const ROOT_MAX = 60;
const STORAGE_KEY = 'intervallen-best-v1';
const REVIEW_PAUSE_MS = 700;

const BG = '#14120e';
const INK = '#f6f1e7';
const MUTED = '#b3ab9e';
const GOLD = '#e2b340';
const OK = '#3cba78';
const BAD = '#e15d4f';
const PANEL = '#221f1a';
const LINE = '#3c362e';

const NOTE_NAMES = [
  'C',
  'Cis',
  'D',
  'Dis',
  'E',
  'F',
  'Fis',
  'G',
  'Gis',
  'A',
  'Ais',
  'B',
] as const;

function noteName(midi: number): string {
  const name = NOTE_NAMES[midi % 12];
  return name ?? 'C';
}

function qualityColor(quality: Quality): string {
  switch (quality) {
    case 'perfect':
      return GOLD;
    case 'major':
      return '#ef8b62';
    case 'minor':
      return '#7eb6e0';
    case 'tritone':
      return '#c58be0';
  }
}

function findLevel(id: number): Level {
  for (const level of LEVELS) {
    if (level.id === id) return level;
  }
  throw new Error(`onbekend niveau ${id}`);
}

function intervalBySemis(semis: number): Interval {
  for (const interval of INTERVALS) {
    if (interval.semis === semis) return interval;
  }
  throw new Error(`onbekend interval ${semis}`);
}

function spokenName(interval: Interval): string {
  if (interval.hint) return `${interval.name} (${interval.hint})`;
  return interval.name;
}

function accessibleName(interval: Interval): string {
  return spokenName(interval);
}

function nameParts(interval: Interval): { top: string; bottom: string } {
  if (interval.hint) return { top: interval.name, bottom: 'overm. kwart' };
  const space = interval.name.indexOf(' ');
  if (space < 0) return { top: interval.name, bottom: '' };
  return {
    top: interval.name.slice(0, space),
    bottom: interval.name.slice(space + 1),
  };
}

function isWhite(midi: number): boolean {
  const pc = midi % 12;
  return pc === 0 || pc === 2 || pc === 4 || pc === 5 || pc === 7 || pc === 9 || pc === 11;
}

function whiteStep(pc: number): number | null {
  switch (pc) {
    case 0:
      return 0;
    case 2:
      return 1;
    case 4:
      return 2;
    case 5:
      return 3;
    case 7:
      return 4;
    case 9:
      return 5;
    case 11:
      return 6;
    default:
      return null;
  }
}

function whiteOffset(midi: number): number {
  const step = whiteStep(midi % 12);
  const fromC0 = Math.floor(midi / 12) * 7 + (step ?? 0);
  const lowStep = whiteStep(LOW_MIDI % 12);
  const lowFromC0 = Math.floor(LOW_MIDI / 12) * 7 + (lowStep ?? 0);
  return fromC0 - lowFromC0;
}

function countWhites(): number {
  let count = 0;
  for (let midi = LOW_MIDI; midi <= HIGH_MIDI; midi += 1) {
    if (isWhite(midi)) count += 1;
  }
  return count;
}

const WHITE_COUNT = countWhites();

function blackNudge(pc: number): number | null {
  switch (pc) {
    case 1:
      return 0.92;
    case 3:
      return 2.08;
    case 6:
      return 3.84;
    case 8:
      return 5;
    case 10:
      return 6.16;
    default:
      return null;
  }
}

function blackCenterOffset(midi: number): number {
  const pc = midi % 12;
  return whiteOffset(midi - pc) + (blackNudge(pc) ?? 0);
}

function keyLayout(midi: number, whiteW: number, blackW: number): KeyLayout {
  if (isWhite(midi)) {
    const left = whiteOffset(midi) * whiteW + 1;
    const width = Math.max(8, whiteW - 2);
    return { midi, left, width, center: left + width / 2, black: false };
  }
  const center = blackCenterOffset(midi) * whiteW;
  return {
    midi,
    left: center - blackW / 2,
    width: blackW,
    center,
    black: true,
  };
}

function pickSemis(avoid: number | null): number {
  let semis = Math.floor(Math.random() * INTERVALS.length);
  if (semis === avoid) {
    semis = (semis + 1 + Math.floor(Math.random() * (INTERVALS.length - 1))) % INTERVALS.length;
  }
  return semis;
}

function pickRootMidi(avoid: number | null): number {
  const span = ROOT_MAX - ROOT_MIN + 1;
  let midi = ROOT_MIN + Math.floor(Math.random() * span);
  if (midi === avoid) midi = ROOT_MIN + ((midi - ROOT_MIN + 1) % span);
  return midi;
}

function loadBest(): Record<number, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const out: Record<number, number> = {};
    for (const key of Object.keys(record)) {
      const value = record[key];
      const id = Number(key);
      if (!Number.isInteger(id) || typeof value !== 'number') continue;
      out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function saveBest(map: Record<number, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Sandbox of privémodus zonder opslag.
  }
}

function audioContextCtor(): {
  new (contextOptions?: AudioContextOptions): AudioContext;
} | null {
  const host = globalThis as unknown as {
    AudioContext?: { new (contextOptions?: AudioContextOptions): AudioContext };
    webkitAudioContext?: { new (contextOptions?: AudioContextOptions): AudioContext };
  };
  if (typeof host.AudioContext === 'function') return host.AudioContext;
  if (typeof host.webkitAudioContext === 'function') return host.webkitAudioContext;
  return null;
}

function createEngine(): AudioEngine | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  setPlaybackSession();
  let ctx: AudioContext;
  try {
    ctx = new Ctor({ latencyHint: 'interactive' });
  } catch {
    ctx = new Ctor();
  }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 16;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.22;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  comp.connect(master);
  master.connect(ctx.destination);
  return { ctx, dest: comp };
}

const PARTIALS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1.45],
  [2, 0.48, 1.05],
  [3, 0.24, 0.75],
  [4, 0.13, 0.52],
  [5, 0.07, 0.4],
  [6, 0.04, 0.32],
  [7, 0.025, 0.26],
];

function playPiano(
  ctx: AudioContext,
  destination: AudioNode,
  midi: number,
  when: number,
  velocity: number,
): void {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.65;
  const open = Math.min(freq * 8, 7200);
  const close = Math.max(freq * 2.4, 480);
  filter.frequency.setValueAtTime(open, when);
  filter.frequency.exponentialRampToValueAtTime(close, when + 0.42);
  filter.connect(destination);

  const stretch = 0.00032;
  for (const partial of PARTIALS) {
    const n = partial[0];
    const amp = partial[1];
    const decay = partial[2];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const harmonic = freq * n * Math.sqrt(1 + stretch * n * n);
    osc.frequency.setValueAtTime(harmonic * 1.004, when);
    osc.frequency.exponentialRampToValueAtTime(harmonic, when + 0.045);
    const peak = Math.max(0.0002, velocity * 0.15 * amp);
    const dur = Math.max(0.35, decay * (1.2 - (midi - 60) * 0.012));
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.007);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.55), when + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain);
    gain.connect(filter);
    osc.start(when);
    osc.stop(when + dur + 0.03);
  }

  const noiseDur = 0.035;
  const length = Math.max(1, Math.floor(ctx.sampleRate * noiseDur));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const env = Math.pow(1 - i / length, 3);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = Math.min(freq * 3, 2800);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(Math.max(0.0002, velocity * 0.07), when);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + noiseDur);
  noise.connect(highpass);
  highpass.connect(noiseGain);
  noiseGain.connect(filter);
  noise.start(when);
  noise.stop(when + noiseDur + 0.01);
}


export default function IntervalTrainer() {
  const [landscape, setLandscape] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= window.innerHeight;
  });
  const [booted, setBooted] = useState<boolean>(false);
  const [audioOn, setAudioOn] = useState<boolean>(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [levelId, setLevelId] = useState<number>(1);
  const [phase, setPhase] = useState<Phase>('playing');
  const [round, setRound] = useState<Round | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [lit, setLit] = useState<number[]>([]);
  const [score, setScore] = useState<number>(0);
  const [streak, setStreak] = useState<number>(0);
  const [best, setBest] = useState<Record<number, number>>(() => loadBest());
  const [showLevels, setShowLevels] = useState<boolean>(false);
  const [geom, setGeom] = useState<Geom | null>(null);

  const audioRef = useRef<AudioEngine | null>(null);
  const feedbackRef = useRef<Feedback | null>(null);
  const timers = useRef<number[]>([]);
  const phaseRef = useRef<Phase>('playing');
  const roundRef = useRef<Round | null>(null);
  const levelIdRef = useRef<number>(1);
  const streakRef = useRef<number>(0);
  const keysRef = useRef<HTMLDivElement | null>(null);

  const level = useMemo((): Level => findLevel(levelId), [levelId]);

  const clearTimers = useCallback((): void => {
    const ids = timers.current;
    timers.current = [];
    for (const id of ids) window.clearTimeout(id);
  }, []);

  const later = useCallback((ms: number, fn: () => void): void => {
    const id = window.setTimeout((): void => {
      fn();
    }, ms);
    timers.current.push(id);
  }, []);

  const playNotes = useCallback((root: number, semis: number, harmonic: boolean): void => {
    const engine = audioRef.current;
    if (!engine) return;
    ensureRunning(engine.ctx);
    const top = root + semis;
    const t0 = engine.ctx.currentTime + 0.04;
    if (harmonic) {
      playPiano(engine.ctx, engine.dest, root, t0, 0.84);
      if (semis !== 0) playPiano(engine.ctx, engine.dest, top, t0, 0.8);
      return;
    }
    playPiano(engine.ctx, engine.dest, root, t0, 0.88);
    playPiano(engine.ctx, engine.dest, top, t0 + 0.62, 0.96);
  }, []);

  const soundRound = useCallback(
    (nextLevel: Level, current: Round, peek: boolean): void => {
      playNotes(current.root, current.semis, nextLevel.harmonic);
      const top = current.root + current.semis;
      if (nextLevel.harmonic) {
        setLit(peek ? (current.semis === 0 ? [current.root] : [current.root, top]) : []);
        return;
      }
      if (!peek) {
        setLit([]);
        return;
      }
      setLit([current.root]);
      later(600, (): void => {
        setLit(current.semis === 0 ? [current.root] : [current.root, top]);
      });
    },
    [later, playNotes],
  );

  const replayInterval = useCallback(
    (root: number, semis: number, harmonic: boolean, kind: Review): void => {
      setReview(kind);
      setLit(semis === 0 ? [root] : [root, root + semis]);
      playNotes(root, semis, harmonic);
    },
    [playNotes],
  );

  const startRound = useCallback(
    (nextLevelId: number, avoidSemis: number | null, avoidRoot: number | null): void => {
      clearTimers();
      const nextLevel = findLevel(nextLevelId);
      const semis = pickSemis(avoidSemis);
      const root = nextLevel.fixedRoot ? FIXED_ROOT : pickRootMidi(avoidRoot);
      const nextRound: Round = { root, semis };
      roundRef.current = nextRound;
      phaseRef.current = 'playing';
      feedbackRef.current = null;
      setRound(nextRound);
      setFeedback(null);
      setReview(null);
      setHint(null);
      setPhase('playing');
      soundRound(nextLevel, nextRound, nextLevel.peek);
      const wait = nextLevel.harmonic ? 740 : 1100;
      later(wait, (): void => {
        phaseRef.current = 'answer';
        setPhase('answer');
      });
    },
    [clearTimers, later, soundRound],
  );

  const submit = useCallback(
    (semis: number): void => {
      if (phaseRef.current !== 'answer') return;
      const current = roundRef.current;
      if (!current) return;
      if (!Number.isInteger(semis) || semis < 0 || semis > 12) return;
      phaseRef.current = 'feedback';
      const ok = semis === current.semis;
      const nextStreak = ok ? streakRef.current + 1 : 0;
      streakRef.current = nextStreak;
      setStreak(nextStreak);
      if (ok) {
        const gained = levelIdRef.current * 10 + nextStreak;
        setScore((pts: number): number => pts + gained);
        const id = levelIdRef.current;
        setBest((prev: Record<number, number>): Record<number, number> => {
          const old = prev[id] ?? 0;
          if (nextStreak <= old) return prev;
          return { ...prev, [id]: nextStreak };
        });
      }
      setHint(null);
      const nextFeedback: Feedback = { ok, picked: semis, answer: current.semis };
      feedbackRef.current = nextFeedback;
      setFeedback(nextFeedback);
      setPhase('feedback');
      if (ok) {
        setReview(null);
        setLit([current.root, current.root + current.semis]);
        later(780, (): void => {
          const finished = roundRef.current;
          startRound(
            levelIdRef.current,
            finished ? finished.semis : null,
            finished ? finished.root : null,
          );
        });
        return;
      }
      setReview(null);
      setLit([]);
      later(REVIEW_PAUSE_MS, (): void => {
        if (phaseRef.current !== 'feedback') return;
        const still = roundRef.current;
        const fb = feedbackRef.current;
        if (!still || !fb || fb.ok) return;
        replayInterval(still.root, still.semis, findLevel(levelIdRef.current).harmonic, 'correct');
      });
    },
    [later, replayInterval, startRound],
  );

  useEffect((): (() => void) => {
    const update = (_event?: Event): void => {
      setLandscape(window.innerWidth >= window.innerHeight);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return (): void => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  useEffect((): (() => void) => {
    const body = document.body;
    const root = document.documentElement;
    const prevOverflow = body.style.overflow;
    const prevRootOverflow = root.style.overflow;
    const prevMargin = body.style.margin;
    body.style.overflow = 'hidden';
    root.style.overflow = 'hidden';
    body.style.margin = '0';
    return (): void => {
      body.style.overflow = prevOverflow;
      root.style.overflow = prevRootOverflow;
      body.style.margin = prevMargin;
      clearTimers();
      const ctx = audioRef.current?.ctx;
      if (ctx && ctx.state !== 'closed') void ctx.close();
    };
  }, [clearTimers]);

  useEffect((): (() => void) => {
    return installKeepAlive(() => audioRef.current?.ctx);
  }, []);

  useEffect((): void => {
    saveBest(best);
  }, [best]);

  useEffect((): (() => void) | void => {
    if (!booted || !landscape) return;
    const el = keysRef.current;
    if (!el) return;
    const measure = (): void => {
      const width = el.clientWidth;
      if (width < 20) return;
      const whiteW = width / WHITE_COUNT;
      setGeom((prev: Geom | null): Geom | null => {
        if (prev && Math.abs(prev.whiteW - whiteW) < 0.4) return prev;
        return { whiteW, blackW: whiteW * 0.56 };
      });
    };
    measure();
    const observer = new ResizeObserver((_entries: ResizeObserverEntry[]): void => {
      measure();
    });
    observer.observe(el);
    return (): void => {
      observer.disconnect();
    };
  }, [booted, landscape]);

  const layouts = useMemo((): KeyLayout[] => {
    if (!geom) return [];
    const list: KeyLayout[] = [];
    for (let midi = LOW_MIDI; midi <= HIGH_MIDI; midi += 1) {
      list.push(keyLayout(midi, geom.whiteW, geom.blackW));
    }
    return list;
  }, [geom]);

  const status = useMemo((): string => {
    if (hint && phase === 'answer') return hint;
    if (phase === 'playing') return level.peek ? 'Luister… je mag kijken' : 'Luister…';
    if (phase === 'answer') return 'Welk interval?';
    if (phase === 'feedback' && feedback) {
      const interval = intervalBySemis(feedback.answer);
      if (feedback.ok) {
        const spoken = spokenName(interval);
        return streak > 1 ? `Goed · ${spoken} · reeks ${streak}` : `Goed · ${spoken}`;
      }
      return `Het was: ${interval.name}`;
    }
    return 'Welk interval?';
  }, [hint, phase, level.peek, feedback, streak]);

  const bestNow = best[levelId] ?? 0;

  const handleBegin = useCallback(
    (event: DomPress): void => {
      event.preventDefault();
      if (audioRef.current) {
        unlockAudio(audioRef.current.ctx);
        setBooted(true);
        return;
      }
      const engine = createEngine();
      if (!engine) {
        setAudioError('Deze browser heeft geen Web Audio.');
        return;
      }
      audioRef.current = engine;
      unlockAudio(engine.ctx);
      const onState = (): void => {
        setAudioOn(engine.ctx.state === 'running');
      };
      engine.ctx.addEventListener('statechange', onState);
      void engine.ctx.resume().then(
        (): void => {
          setAudioOn(engine.ctx.state === 'running');
        },
        (_reason: unknown): void => {
          setAudioError('Geluid kon niet starten.');
        },
      );
      setAudioOn(engine.ctx.state === 'running');
      setBooted(true);
      startRound(levelIdRef.current, null, null);
    },
    [startRound],
  );

  const handleReplay = useCallback(
    (event: DomPress): void => {
      event.preventDefault();
      if (phaseRef.current !== 'answer') return;
      const current = roundRef.current;
      if (!current) return;
      soundRound(findLevel(levelIdRef.current), current, findLevel(levelIdRef.current).peek);
    },
    [soundRound],
  );

  const handleHearCorrect = useCallback(
    (event: DomPress): void => {
      event.preventDefault();
      if (phaseRef.current !== 'feedback') return;
      const current = roundRef.current;
      const fb = feedbackRef.current;
      if (!current || !fb || fb.ok) return;
      clearTimers();
      replayInterval(current.root, current.semis, findLevel(levelIdRef.current).harmonic, 'correct');
    },
    [clearTimers, replayInterval],
  );

  const handleHearYours = useCallback(
    (event: DomPress): void => {
      event.preventDefault();
      if (phaseRef.current !== 'feedback') return;
      const current = roundRef.current;
      const fb = feedbackRef.current;
      if (!current || !fb || fb.ok) return;
      clearTimers();
      replayInterval(current.root, fb.picked, findLevel(levelIdRef.current).harmonic, 'yours');
    },
    [clearTimers, replayInterval],
  );

  const handleNext = useCallback(
    (event: DomPress): void => {
      event.preventDefault();
      if (phaseRef.current !== 'feedback') return;
      const fb = feedbackRef.current;
      if (!fb || fb.ok) return;
      const finished = roundRef.current;
      startRound(
        levelIdRef.current,
        finished ? finished.semis : null,
        finished ? finished.root : null,
      );
    },
    [startRound],
  );

  const handleToggleLevels = useCallback((event: DomPress): void => {
    event.preventDefault();
    setShowLevels((open: boolean): boolean => !open);
  }, []);

  const handleCloseLevels = useCallback((event: DomPress): void => {
    event.preventDefault();
    setShowLevels(false);
  }, []);

  const handleSheet = useCallback((event: DomPress): void => {
    event.stopPropagation();
  }, []);

  const handleChooseLevel = useCallback(
    (event: DomPress, id: number): void => {
      event.preventDefault();
      levelIdRef.current = id;
      setLevelId(id);
      setShowLevels(false);
      streakRef.current = 0;
      setStreak(0);
      const current = roundRef.current;
      startRound(id, current ? current.semis : null, current ? current.root : null);
    },
    [startRound],
  );

  const handleName = useCallback(
    (event: DomPress, semis: number): void => {
      event.preventDefault();
      submit(semis);
    },
    [submit],
  );

  const handleKey = useCallback(
    (event: DomPress, midi: number): void => {
      event.preventDefault();
      const current = roundRef.current;
      if (!current || phaseRef.current !== 'answer') return;
      const semis = midi - current.root;
      if (semis < 0 || semis > 12) {
        setHint('Alleen stijgend, tot en met het octaaf.');
        return;
      }
      submit(semis);
    },
    [submit],
  );

  const answerButtons = (intervals: readonly Interval[]) =>
    intervals.map((interval: Interval) => {
      const parts = nameParts(interval);
      const color = qualityColor(interval.quality);
      let background = PANEL;
      let border = `1px solid ${LINE}`;
      if (feedback && phase === 'feedback' && interval.semis === feedback.answer) {
        background = '#1d4a34';
        border = `2px solid ${OK}`;
      } else if (
        feedback &&
        phase === 'feedback' &&
        !feedback.ok &&
        interval.semis === feedback.picked
      ) {
        background = '#5c2824';
        border = `2px solid ${BAD}`;
      }
      return (
        <button
          key={interval.semis}
          type="button"
          aria-label={accessibleName(interval)}
          disabled={phase !== 'answer'}
          onClick={(event: DomPress) => {
            handleName(event, interval.semis);
          }}
          style={{
            minHeight: 48,
            width: '100%',
            boxSizing: 'border-box',
            border,
            borderRadius: 8,
            background,
            color: INK,
            padding: '3px 2px',
            font: 'inherit',
            touchAction: 'manipulation',
            cursor: phase === 'answer' ? 'pointer' : 'default',
            opacity: phase === 'playing' ? 0.72 : 1,
          }}
        >
          <span
            style={{
              display: 'block',
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: 0.4,
              color,
              lineHeight: 1.1,
            }}
          >
            {interval.short}
          </span>
          <span style={{ display: 'block', fontSize: 12, fontWeight: 700, lineHeight: 1.05 }}>
            {parts.top}
          </span>
          <span style={{ display: 'block', fontSize: 10, lineHeight: 1.05, color: '#ddd6c8' }}>
            {parts.bottom}
          </span>
        </button>
      );
    });

  return (
    <div
      data-audio={audioOn ? 'on' : 'off'}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: BG,
        color: INK,
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        touchAction: 'manipulation',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
        paddingTop: 'max(6px, env(safe-area-inset-top))',
        paddingRight: 'max(8px, env(safe-area-inset-right))',
        paddingBottom: 'max(6px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(8px, env(safe-area-inset-left))',
      }}
    >
      {!landscape ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 6,
            background: BG,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            textAlign: 'center',
            padding: 24,
          }}
        >
          <div style={{ fontSize: 42, lineHeight: 1 }} aria-hidden="true">
            ↻
          </div>
          <div style={{ fontSize: 28, fontWeight: 750 }}>Draai je telefoon</div>
          <div style={{ fontSize: 15, color: MUTED }}>Dit spel werkt liggend.</div>
        </div>
      ) : null}

      {landscape && !booted ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
            background: BG,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            textAlign: 'center',
            padding: 24,
          }}
        >
          <div style={{ fontSize: 32, fontWeight: 750, letterSpacing: -0.5 }}>Intervallen</div>
          <div style={{ fontSize: 16, color: MUTED, maxWidth: 460, lineHeight: 1.35 }}>
            Hoor een stijgend interval. Tik de naam of de toets.
          </div>
          <button
            type="button"
            onClick={handleBegin}
            style={{
              minHeight: 52,
              minWidth: 180,
              border: 'none',
              borderRadius: 12,
              background: GOLD,
              color: '#241c0c',
              font: 'inherit',
              fontSize: 18,
              fontWeight: 750,
              cursor: 'pointer',
              touchAction: 'manipulation',
            }}
          >
            Begin
          </button>
          {audioError ? <div style={{ color: BAD, fontSize: 14 }}>{audioError}</div> : null}
        </div>
      ) : null}

      {landscape && booted ? (
        <>
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minHeight: 36,
              flex: '0 0 auto',
            }}
          >
            <strong style={{ fontSize: 15, fontWeight: 750 }}>Intervallen</strong>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: MUTED,
                fontSize: 13,
              }}
            >
              {level.id} · {level.name}
            </span>
            <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              reeks {streak}
            </span>
            <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {score} pt
            </span>
            <span style={{ fontSize: 12, color: MUTED, whiteSpace: 'nowrap' }}>beste {bestNow}</span>
            <button
              type="button"
              aria-label="Speel het interval nog eens"
              disabled={phase !== 'answer'}
              onClick={handleReplay}
              style={{
                minHeight: 36,
                borderRadius: 8,
                border: `1px solid ${LINE}`,
                background: '#2a261f',
                color: INK,
                font: 'inherit',
                fontSize: 13,
                padding: '0 10px',
                touchAction: 'manipulation',
                cursor: phase === 'answer' ? 'pointer' : 'default',
              }}
            >
              nog eens
            </button>
            <button
              type="button"
              aria-label="Kies een niveau"
              onClick={handleToggleLevels}
              style={{
                minHeight: 36,
                borderRadius: 8,
                border: `1px solid ${LINE}`,
                background: '#2a261f',
                color: INK,
                font: 'inherit',
                fontSize: 13,
                padding: '0 10px',
                touchAction: 'manipulation',
                cursor: 'pointer',
              }}
            >
              niveau
            </button>
          </header>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 auto' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                gap: 4,
              }}
            >
              {answerButtons(INTERVALS.slice(0, 7))}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                gap: 4,
              }}
            >
              {answerButtons(INTERVALS.slice(7))}
            </div>
          </div>

          <div style={{ textAlign: 'center', fontSize: 10, color: MUTED, flex: '0 0 auto' }}>
            tt = overmatige kwart / verminderde kwint
          </div>

          <div
            role="status"
            aria-live="polite"
            style={{
              minHeight: 18,
              textAlign: 'center',
              fontSize: 14,
              fontWeight: 650,
              flex: '0 0 auto',
              color: feedback && phase === 'feedback' ? (feedback.ok ? OK : BAD) : INK,
            }}
          >
            {status}
          </div>

          {phase === 'feedback' && feedback && !feedback.ok ? (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                flexWrap: 'wrap',
                gap: 6,
                flex: '0 0 auto',
              }}
            >
              <button
                type="button"
                aria-label="Nog eens horen"
                onClick={handleHearCorrect}
                style={{
                  minHeight: 36,
                  borderRadius: 8,
                  border: `1px solid ${LINE}`,
                  background: '#2a261f',
                  color: INK,
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: 650,
                  padding: '0 12px',
                  touchAction: 'manipulation',
                  cursor: 'pointer',
                }}
              >
                Nog eens horen
              </button>
              <button
                type="button"
                aria-label="Jouw antwoord"
                onClick={handleHearYours}
                style={{
                  minHeight: 36,
                  borderRadius: 8,
                  border: `1px solid ${LINE}`,
                  background: '#2a261f',
                  color: INK,
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: 650,
                  padding: '0 12px',
                  touchAction: 'manipulation',
                  cursor: 'pointer',
                }}
              >
                Jouw antwoord
              </button>
              <button
                type="button"
                aria-label="Volgende"
                onClick={handleNext}
                style={{
                  minHeight: 36,
                  borderRadius: 8,
                  border: 'none',
                  background: GOLD,
                  color: '#241c0c',
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: 750,
                  padding: '0 12px',
                  touchAction: 'manipulation',
                  cursor: 'pointer',
                }}
              >
                Volgende
              </button>
            </div>
          ) : null}

          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ position: 'relative', height: 28, flex: '0 0 auto' }}>
              {round
                ? layouts
                    .filter((layout: KeyLayout): boolean => layout.midi === round.root)
                    .map((layout: KeyLayout) => (
                      <div
                        key="grondtoon"
                        data-semis={0}
                        style={{
                          position: 'absolute',
                          left: layout.center,
                          top: 0,
                          transform: 'translateX(-50%)',
                          textAlign: 'center',
                          transition: 'left 220ms ease',
                          pointerEvents: 'none',
                          color: GOLD,
                          lineHeight: 1,
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 800 }}>{noteName(round.root)}</div>
                        <div style={{ fontSize: 10, lineHeight: 1 }}>▼</div>
                      </div>
                    ))
                : null}
            </div>

            <div ref={keysRef} style={{ position: 'relative', flex: '1 1 auto', minHeight: 72 }}>
              {layouts
                .filter((layout: KeyLayout): boolean => !layout.black)
                .map((layout: KeyLayout) => {
                  const node = renderKey(layout);
                  return node;
                })}
              {layouts
                .filter((layout: KeyLayout): boolean => layout.black)
                .map((layout: KeyLayout) => renderKey(layout))}
            </div>
          </div>

          {showLevels ? (
            <div
              onClick={handleCloseLevels}
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 5,
                background: 'rgba(8, 7, 5, 0.72)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 12,
              }}
            >
              <div
                onClick={handleSheet}
                style={{
                  width: '100%',
                  maxWidth: 560,
                  background: '#1c1a16',
                  borderRadius: 12,
                  padding: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  border: `1px solid ${LINE}`,
                }}
              >
                {LEVELS.map((item: Level) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={`${item.id}. ${item.name}. ${item.detail}`}
                    aria-pressed={item.id === levelId}
                    onClick={(event: DomPress) => {
                      handleChooseLevel(event, item.id);
                    }}
                    style={{
                      minHeight: 48,
                      textAlign: 'left',
                      borderRadius: 8,
                      border: item.id === levelId ? `2px solid ${GOLD}` : `1px solid ${LINE}`,
                      background: item.id === levelId ? '#3a311c' : '#26231e',
                      color: INK,
                      font: 'inherit',
                      padding: '6px 10px',
                      cursor: 'pointer',
                      touchAction: 'manipulation',
                    }}
                  >
                    <span style={{ display: 'block', fontWeight: 750, fontSize: 14 }}>
                      {item.id} · {item.name}
                    </span>
                    <span style={{ display: 'block', color: MUTED, fontSize: 12 }}>{item.detail}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );

  function renderKey(layout: KeyLayout) {
    const midi = layout.midi;
    const inRange = round !== null && midi >= round.root && midi <= round.root + 12;
    const isRoot = round !== null && midi === round.root;
    const semis = round ? midi - round.root : -1;
    const litNow = lit.indexOf(midi) !== -1;
    const isPeek = phase !== 'feedback' && litNow;
    const wrongReview = phase === 'feedback' && feedback !== null && !feedback.ok;
    const isCorrect =
      (wrongReview && review === 'correct' && litNow) ||
      (phase === 'feedback' &&
        feedback !== null &&
        feedback.ok &&
        round !== null &&
        midi === round.root + feedback.answer);
    const isWrong = wrongReview && review === 'yours' && litNow;
    let background = layout.black
      ? 'linear-gradient(#3a342e, #120f0c 28%)'
      : 'linear-gradient(#fffdf8, #f1e6d4 72%, #e4d5c0)';
    if (!inRange) background = layout.black ? '#0c0b0a' : '#8f897e';
    if (isPeek) background = layout.black ? '#6a5424' : '#ffe7a3';
    if (isCorrect) background = layout.black ? '#1d4a32' : '#d9f5e4';
    if (isWrong) background = layout.black ? '#5a2420' : '#f8d2cc';
    let shadow = layout.black
      ? 'inset 0 -8px 10px rgba(0,0,0,0.45)'
      : 'inset 0 -12px 14px rgba(90,60,20,0.12)';
    if (isCorrect) shadow = `inset 0 0 0 3px ${OK}`;
    else if (isWrong) shadow = `inset 0 0 0 3px ${BAD}`;
    else if (isRoot) shadow = `inset 0 0 0 3px ${GOLD}, ${shadow}`;
    const interval = semis >= 0 && semis <= 12 ? intervalBySemis(semis) : null;
    const showCode = inRange && level.labels && interval !== null;
    const codeColor = !interval
      ? GOLD
      : layout.black
        ? isPeek || isCorrect || isWrong
          ? '#fff6dd'
          : qualityColor(interval.quality)
        : isPeek || isCorrect || isWrong
          ? '#3a2a10'
          : qualityColor(interval.quality);
    const label = isRoot
      ? `${noteName(midi)}, grondtoon${interval ? `, ${interval.name}` : ''}`
      : interval
        ? `${noteName(midi)}, ${interval.name}`
        : noteName(midi);
    return (
      <button
        key={midi}
        type="button"
        data-midi={midi}
        data-root={isRoot ? '1' : '0'}
        data-lit={litNow ? '1' : '0'}
        data-correct={isCorrect ? '1' : '0'}
        data-yours={isWrong ? '1' : '0'}
        aria-label={label}
        disabled={phase !== 'answer'}
        onClick={(event: DomPress) => {
          handleKey(event, midi);
        }}
        style={{
          position: 'absolute',
          left: layout.left,
          top: 0,
          width: layout.width,
          height: layout.black ? '62%' : '100%',
          zIndex: layout.black ? 2 : 1,
          boxSizing: 'border-box',
          border: 'none',
          borderRadius: layout.black ? '0 0 5px 5px' : '0 0 7px 7px',
          background,
          boxShadow: shadow,
          padding: 0,
          overflow: 'hidden',
          touchAction: 'manipulation',
          font: 'inherit',
          cursor: phase === 'answer' ? 'pointer' : 'default',
        }}
      >
        {showCode && interval ? (
          <>
            <span
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: layout.black ? 4 : 6,
                background: qualityColor(interval.quality),
              }}
            />
            <span
              data-code={interval.short}
              style={{
                position: 'absolute',
                top: layout.black ? 6 : 8,
                left: 0,
                right: 0,
                textAlign: 'center',
                fontSize: layout.black ? 9 : 13,
                fontWeight: 800,
                letterSpacing: 0.2,
                lineHeight: 1,
                color: codeColor,
                pointerEvents: 'none',
              }}
            >
              {interval.short}
            </span>
          </>
        ) : null}
        {isRoot ? (
          <span
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: layout.black ? 4 : 8,
              textAlign: 'center',
              fontSize: layout.black ? 9 : 14,
              fontWeight: 800,
              color: layout.black ? GOLD : '#5c4010',
              pointerEvents: 'none',
            }}
          >
            {noteName(midi)}
          </span>
        ) : null}
      </button>
    );
  }
}

