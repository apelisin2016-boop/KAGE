/** Deterministic mulberry32 PRNG. All game randomness goes through this. */

export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function hashSeed(seed: string | number): number {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  return xmur3(String(seed))();
}

export type Rng = {
  next: () => number;
  getState: () => number;
  setState: (n: number) => void;
  int: (n: number) => number;
  range: (a: number, b: number) => number;
  intRange: (a: number, b: number) => number;
  pick: <T>(arr: readonly T[]) => T;
  shuffle: <T>(arr: T[]) => T[];
  chance: (p: number) => boolean;
  signed: (v: number) => number;
  fork: (salt: number) => Rng;
};

export function createRng(seed: string | number): Rng {
  let s = hashSeed(seed);
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    getState: () => s,
    setState: (n) => {
      s = n >>> 0;
    },
    int: (n) => {
      if (n <= 0) return 0;
      return Math.floor(next() * n);
    },
    range: (a, b) => a + next() * (b - a),
    intRange: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: <T>(arr: readonly T[]) => arr[Math.floor(next() * arr.length)]!,
    shuffle: <T>(arr: T[]) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = t;
      }
      return arr;
    },
    chance: (p) => next() < p,
    signed: (v) => 1 + (next() * 2 - 1) * v,
    fork: (salt) => createRng((s ^ (salt >>> 0)) >>> 0),
  };
  return rng;
}

export function randomSeedString(rng = createRng(Date.now() ^ performance.now())): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[rng.int(alphabet.length)];
  return out;
}
