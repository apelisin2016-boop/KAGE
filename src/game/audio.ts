let ctx: AudioContext | null = null;
let unlocked = false;
let muted = false;

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  return ctx;
}

export function unlockAudio() {
  const c = ac();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  unlocked = true;
}

export function setMuted(v: boolean) {
  muted = v;
  if (v && ctx) void ctx.suspend();
  else if (!v && ctx) void ctx.resume();
}

export function isMuted() {
  return muted;
}

function tone(freq: number, dur: number, type: OscillatorType, gain = 0.05, at = 0) {
  const c = ac();
  if (!c || !unlocked) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  click: () => tone(720, 0.06, "square", 0.03),
  select: () => tone(480, 0.07, "triangle", 0.04),
  move: () => {
    tone(220, 0.1, "sine", 0.04);
    tone(330, 0.08, "sine", 0.02, 0.05);
  },
  hit: () => {
    tone(90, 0.12, "sawtooth", 0.06);
    tone(240, 0.08, "square", 0.03, 0.02);
  },
  tech: () => {
    tone(520, 0.16, "triangle", 0.05);
    tone(780, 0.2, "sine", 0.03, 0.04);
  },
  turn: () => tone(310, 0.12, "triangle", 0.04),
  win: () => {
    tone(392, 0.18, "triangle", 0.05);
    tone(494, 0.2, "triangle", 0.05, 0.12);
    tone(587, 0.28, "triangle", 0.05, 0.24);
  },
  error: () => tone(140, 0.1, "square", 0.04),
};
