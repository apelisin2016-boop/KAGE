export type Hex = { q: number; r: number };

export const HEX_DIRS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

export function parseHexKey(k: string): Hex {
  const [q, r] = k.split(",");
  return { q: Number(q), r: Number(r) };
}

export function hexEq(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

export function hexAdd(a: Hex, b: Hex): Hex {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function hexSub(a: Hex, b: Hex): Hex {
  return { q: a.q - b.q, r: a.r - b.r };
}

export function hexLen(h: Hex): number {
  return (Math.abs(h.q) + Math.abs(h.r) + Math.abs(-h.q - h.r)) / 2;
}

export function hexDist(a: Hex, b: Hex): number {
  return hexLen(hexSub(a, b));
}

export function neighbors(h: Hex): Hex[] {
  return HEX_DIRS.map((d) => hexAdd(h, d));
}

/** Rotate hex `k` times 60° CCW around origin. */
export function hexRotate60(h: Hex, k: number): Hex {
  let q = h.q;
  let r = h.r;
  const n = ((k % 6) + 6) % 6;
  for (let i = 0; i < n; i++) {
    const nq = -r;
    const nr = q + r;
    q = nq;
    r = nr;
  }
  return { q, r };
}

export function hexRotateAround(h: Hex, center: Hex, k: number): Hex {
  return hexAdd(center, hexRotate60(hexSub(h, center), k));
}

export function offsetToAxial(col: number, row: number): Hex {
  const q = col - (row - (row & 1)) / 2;
  return { q, r: row };
}

export function axialToOffset(h: Hex): { col: number; row: number } {
  const col = h.q + (h.r - (h.r & 1)) / 2;
  return { col, row: h.r };
}

export function hexToPixel(h: Hex, size: number): { x: number; y: number } {
  const x = size * Math.sqrt(3) * (h.q + h.r / 2);
  const y = size * (3 / 2) * h.r;
  return { x, y };
}

export function pixelToHex(x: number, y: number, size: number): Hex {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  return hexRound(q, r);
}

export function hexRound(q: number, r: number): Hex {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  let rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

export function hexesInRange(center: Hex, range: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -range; q <= range; q++) {
    for (let r = Math.max(-range, -q - range); r <= Math.min(range, -q + range); r++) {
      out.push({ q: center.q + q, r: center.r + r });
    }
  }
  return out;
}

export function hexRing(center: Hex, radius: number): Hex[] {
  if (radius === 0) return [{ ...center }];
  const out: Hex[] = [];
  let h = hexAdd(center, { q: HEX_DIRS[4]!.q * radius, r: HEX_DIRS[4]!.r * radius });
  for (let i = 0; i < 6; i++) {
    const d = HEX_DIRS[i]!;
    for (let j = 0; j < radius; j++) {
      out.push(h);
      h = hexAdd(h, d);
    }
  }
  return out;
}

export function hexLerp(a: Hex, b: Hex, t: number): { q: number; r: number; s: number } {
  const as_ = -a.q - a.r;
  const bs = -b.q - b.r;
  return {
    q: a.q + (b.q - a.q) * t,
    r: a.r + (b.r - a.r) * t,
    s: as_ + (bs - as_) * t,
  };
}

export function hexLine(a: Hex, b: Hex): Hex[] {
  const n = hexDist(a, b);
  if (n === 0) return [{ ...a }];
  const out: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = hexLerp(a, b, t);
    out.push(hexRound(p.q, p.r));
  }
  return out;
}

export type CostFn = (from: Hex, to: Hex) => number;

export function dijkstra(
  start: Hex,
  maxCost: number,
  costFn: CostFn,
  inBounds: (h: Hex) => boolean,
): { dist: Map<string, number>; prev: Map<string, string | null> } {
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const sk = hexKey(start.q, start.r);
  dist.set(sk, 0);
  prev.set(sk, null);
  const queue: { h: Hex; d: number }[] = [{ h: start, d: 0 }];
  const seen = new Set<string>();

  while (queue.length) {
    let bestI = 0;
    let bestD = queue[0]!.d;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i]!.d < bestD) {
        bestD = queue[i]!.d;
        bestI = i;
      }
    }
    const cur = queue[bestI]!;
    const last = queue.pop()!;
    if (bestI < queue.length) queue[bestI] = last;
    const ck = hexKey(cur.h.q, cur.h.r);
    if (seen.has(ck)) continue;
    seen.add(ck);
    if (cur.d > maxCost) continue;
    for (const n of neighbors(cur.h)) {
      if (!inBounds(n)) continue;
      const step = costFn(cur.h, n);
      if (step >= 99) continue;
      const nd = cur.d + step;
      if (nd > maxCost) continue;
      const nk = hexKey(n.q, n.r);
      const prevD = dist.get(nk);
      if (prevD === undefined || nd < prevD) {
        dist.set(nk, nd);
        prev.set(nk, ck);
        queue.push({ h: n, d: nd });
      }
    }
  }
  return { dist, prev };
}

export function reconstructPath(prev: Map<string, string | null>, dest: Hex): Hex[] {
  const path: Hex[] = [];
  let k: string | null = hexKey(dest.q, dest.r);
  while (k) {
    path.push(parseHexKey(k));
    k = prev.get(k) ?? null;
  }
  path.reverse();
  return path;
}
