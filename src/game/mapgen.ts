import { BALANCE, type Terrain, type UnitId, type VillageId } from "./balance";
import {
  axialToOffset,
  hexAdd,
  hexDist,
  hexKey,
  hexRotate60,
  hexesInRange,
  neighbors,
  offsetToAxial,
  type Hex,
} from "./hex";
import type { Rng } from "./rng";
import type {
  GameSetup,
  HexCell,
  Player,
  ResourceKind,
  ResourceNode,
  Settlement,
  Stack,
} from "./types";

export type GeneratedMap = {
  hexes: Record<string, HexCell>;
  settlements: Settlement[];
  resources: ResourceNode[];
  capitals: Hex[];
};

function fbm(rng: Rng): (x: number, y: number) => number {
  const g: number[] = [];
  for (let i = 0; i < 256; i++) g.push(rng.next());
  const fade = (t: number) => t * t * (3 - 2 * t);
  const at = (x: number, y: number) => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const v00 = g[(xi + g[yi]! * 13) & 255]!;
    const v10 = g[(xi + 1 + g[yi]! * 13) & 255]!;
    const v01 = g[(xi + g[(yi + 1) & 255]! * 13) & 255]!;
    const v11 = g[(xi + 1 + g[(yi + 1) & 255]! * 13) & 255]!;
    const u = fade(xf);
    const v = fade(yf);
    return v00 * (1 - u) * (1 - v) + v10 * u * (1 - v) + v01 * (1 - u) * v + v11 * u * v;
  };
  return (x, y) => {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let n = 0;
    for (let o = 0; o < 4; o++) {
      sum += amp * at(x * freq, y * freq);
      n += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / n;
  };
}

export function allHexes(w: number, h: number): Hex[] {
  const out: Hex[] = [];
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      out.push(offsetToAxial(col, row));
    }
  }
  return out;
}

export function inRect(h: Hex, w: number, hgt: number): boolean {
  const { col, row } = axialToOffset(h);
  return col >= 0 && row >= 0 && col < w && row < hgt;
}

function terrainFromNoise(
  elev: number,
  moist: number,
  M: typeof BALANCE.map,
): Terrain {
  if (elev > M.mountainElev) return "mountain";
  if (elev > M.hillElev) return "hill";
  if (moist > M.forestMoisture && elev < 0.55) return "forest";
  if (moist < M.desertMoisture && elev < 0.52) return "desert";
  return "plains";
}

/** Local radius-3 template — stamped at every capital for starting symmetry. */
function localTemplate(): { dq: number; dr: number; terrain: Terrain }[] {
  const cells: { dq: number; dr: number; terrain: Terrain }[] = [{ dq: 0, dr: 0, terrain: "plains" }];
  const ring1: Terrain[] = ["plains", "forest", "plains", "hill", "forest", "hill"];
  const dirs = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];
  for (let i = 0; i < 6; i++) {
    cells.push({ dq: dirs[i]![0], dr: dirs[i]![1], terrain: ring1[i]! });
  }
  const ring2: Terrain[] = [
    "plains",
    "forest",
    "desert",
    "plains",
    "hill",
    "forest",
    "plains",
    "plains",
    "forest",
    "hill",
    "desert",
    "plains",
  ];
  let i = 0;
  for (let s = 0; s < 6; s++) {
    let q = dirs[s]![0] * 2;
    let r = dirs[s]![1] * 2;
    const nd = dirs[(s + 2) % 6]!;
    for (let k = 0; k < 2; k++) {
      cells.push({ dq: q, dr: r, terrain: ring2[i % ring2.length]! });
      q += nd[0];
      r += nd[1];
      i++;
    }
  }
  const ring3: Terrain[] = [
    "forest",
    "plains",
    "hill",
    "plains",
    "desert",
    "plains",
    "forest",
    "plains",
    "hill",
    "plains",
    "forest",
    "plains",
    "desert",
    "plains",
    "hill",
    "plains",
    "forest",
    "plains",
  ];
  i = 0;
  for (let s = 0; s < 6; s++) {
    let q = dirs[s]![0] * 3;
    let r = dirs[s]![1] * 3;
    const nd = dirs[(s + 2) % 6]!;
    for (let k = 0; k < 3; k++) {
      cells.push({ dq: q, dr: r, terrain: ring3[i % ring3.length]! });
      q += nd[0];
      r += nd[1];
      i++;
    }
  }
  return cells;
}

function padOk(h: Hex, w: number, hgt: number, pad = 1): boolean {
  const o = axialToOffset(h);
  return o.col >= pad && o.row >= pad && o.col < w - pad && o.row < hgt - pad;
}

function nearestOpen(
  target: Hex,
  w: number,
  h: number,
  taken: Hex[],
  minSep: number,
): Hex {
  const all = allHexes(w, h).filter((p) => padOk(p, w, h, 1));
  const pool = all.length ? all : allHexes(w, h);
  const ranked = pool
    .filter((p) => taken.every((t) => hexDist(t, p) >= minSep))
    .sort((a, b) => hexDist(a, target) - hexDist(b, target) || a.q - b.q || a.r - b.r);
  if (ranked[0]) return ranked[0];
  const any = pool
    .filter((p) => taken.every((t) => t.q !== p.q || t.r !== p.r))
    .sort((a, b) => hexDist(a, target) - hexDist(b, target) || a.q - b.q || a.r - b.r);
  return any[0] ?? target;
}

/** Always returns one hex per player. Two-player: opposite edges so armies march. */
function placeCapitals(setup: GameSetup, rng: Rng): Hex[] {
  const { w, h, players } = setup;
  const n = Math.max(1, players.length);
  const preset = BALANCE.map.presets[setup.preset];
  if (n === 2) {
    const jitter = rng.chance(0.5) ? 1 : -1;
    const left = offsetToAxial(1, Math.max(1, Math.min(h - 2, Math.floor(h / 2) + jitter)));
    const right = offsetToAxial(w - 2, Math.max(1, Math.min(h - 2, Math.floor(h / 2) - jitter)));
    return rng.chance(0.5) ? [left, right] : [right, left];
  }
  const pad = n <= 4 ? 2 : 3;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const colR = Math.max(3, cx - pad);
  const rowR = Math.max(2.4, cy - pad);
  const startAng = setup.placement === "teams" ? -Math.PI / 2 : rng.range(0, Math.PI * 2);
  const minSep = n <= 4 ? Math.max(8, Math.floor(preset.capitalDistMin * 0.72)) : Math.max(6, Math.floor(preset.capitalDistMin * 0.55));
  const out: Hex[] = [];
  for (let i = 0; i < n; i++) {
    const ang = startAng + (Math.PI * 2 * i) / n;
    const col = cx + Math.cos(ang) * colR;
    const row = cy + Math.sin(ang) * rowR;
    const target = offsetToAxial(Math.round(col), Math.round(row));
    out.push(nearestOpen(target, w, h, out, minSep));
  }
  return out;
}

function findSpot(
  hexes: Record<string, HexCell>,
  origin: Hex,
  minD: number,
  maxD: number,
  taken: Set<string>,
  w: number,
  h: number,
): Hex | null {
  const ring: Hex[] = [];
  for (let d = minD; d <= maxD; d++) {
    for (const p of hexesInRange(origin, d)) {
      if (hexDist(origin, p) < minD) continue;
      if (!inRect(p, w, h)) continue;
      const k = hexKey(p.q, p.r);
      const cell = hexes[k];
      if (!cell || taken.has(k) || cell.terrain === "mountain") continue;
      ring.push(p);
    }
    if (ring.length) break;
  }
  if (ring.length) return ring[Math.floor(ring.length / 2)] ?? ring[0]!;
  for (const p of hexesInRange(origin, maxD + 3)) {
    if (!inRect(p, w, h)) continue;
    const k = hexKey(p.q, p.r);
    const cell = hexes[k];
    if (!cell || taken.has(k) || cell.terrain === "mountain") continue;
    if (p.q === origin.q && p.r === origin.r) continue;
    return p;
  }
  return null;
}

function paintRivers(
  hexes: Record<string, HexCell>,
  w: number,
  h: number,
  rng: Rng,
  reserved: Set<string>,
) {
  const mountains = Object.values(hexes).filter((c) => c.terrain === "mountain");
  const count = rng.intRange(BALANCE.map.riverCountMin, BALANCE.map.riverCountMax);
  for (let i = 0; i < count; i++) {
    if (!mountains.length) break;
    let cur: Hex = { q: rng.pick(mountains).q, r: rng.pick(mountains).r };
    const steps = rng.intRange(6, 14);
    for (let s = 0; s < steps; s++) {
      const k = hexKey(cur.q, cur.r);
      if (!reserved.has(k) && hexes[k] && hexes[k]!.terrain !== "mountain") {
        hexes[k]!.terrain = "river";
      }
      const opts = neighbors(cur).filter((n) => inRect(n, w, h) && hexes[hexKey(n.q, n.r)]);
      if (!opts.length) break;
      cur = rng.pick(opts);
    }
  }
}

function connectPassable(hexes: Record<string, HexCell>, w: number, h: number) {
  const pass = (c: HexCell) => c.terrain !== "mountain";
  const cells = Object.values(hexes).filter(pass);
  if (!cells.length) return;
  const start = cells[0]!;
  const seen = new Set<string>();
  const q: Hex[] = [{ q: start.q, r: start.r }];
  seen.add(hexKey(start.q, start.r));
  while (q.length) {
    const c = q.shift()!;
    for (const n of neighbors(c)) {
      const k = hexKey(n.q, n.r);
      const cell = hexes[k];
      if (!cell || seen.has(k) || !pass(cell)) continue;
      seen.add(k);
      q.push(n);
    }
  }
  for (const c of cells) {
    const k = hexKey(c.q, c.r);
    if (!seen.has(k)) c.terrain = "hill";
  }
  void w;
  void h;
}

function terrainCounts(hexes: Record<string, HexCell>, origin: Hex, range: number): Record<string, number> {
  const c: Record<string, number> = {};
  for (const h of hexesInRange(origin, range)) {
    const cell = hexes[hexKey(h.q, h.r)];
    if (!cell) continue;
    c[cell.terrain] = (c[cell.terrain] ?? 0) + 1;
  }
  return c;
}

function countsEqual(a: Record<string, number>, b: Record<string, number>, slack: number): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > slack) return false;
  }
  return true;
}

function tryGenerate(rng: Rng, setup: GameSetup, slack: number, force = false): GeneratedMap | null {
  const { w, h, players } = setup;
  const preset = BALANCE.map.presets[setup.preset];
  const capitals = placeCapitals(setup, rng);
  if (!capitals.length || capitals.length !== players.length) {
    if (force) return emptyRectMap(setup);
    return null;
  }
  if (!force) {
    const minPair = players.length <= 2 ? preset.capitalDistMin : Math.max(7, Math.floor(preset.capitalDistMin * 0.7));
    for (let i = 0; i < capitals.length; i++) {
      for (let j = i + 1; j < capitals.length; j++) {
        if (hexDist(capitals[i]!, capitals[j]!) < minPair) return null;
      }
    }
  }

  const noiseE = fbm(rng.fork(11));
  const noiseM = fbm(rng.fork(23));
  const hexes: Record<string, HexCell> = {};
  for (const hx of allHexes(w, h)) {
    const e = noiseE(hx.q * 0.13 + 4.2, hx.r * 0.13 + 1.7);
    const m = noiseM(hx.q * 0.15 + 9.1, hx.r * 0.15 + 3.3);
    hexes[hexKey(hx.q, hx.r)] = {
      q: hx.q,
      r: hx.r,
      terrain: terrainFromNoise(e, m, BALANCE.map),
      owner: null,
      contested: false,
      influence: {},
      capture: null,
    };
  }

  const reserved = new Set<string>();
  const tmpl = localTemplate();
  for (let i = 0; i < capitals.length; i++) {
    const cap = capitals[i]!;
    const rot = i % 6;
    for (const t of tmpl) {
      const off = hexRotate60({ q: t.dq, r: t.dr }, rot);
      const p = hexAdd(cap, off);
      const k = hexKey(p.q, p.r);
      const cell = hexes[k];
      if (!cell) continue;
      cell.terrain = t.terrain;
      reserved.add(k);
    }
    const ck = hexKey(cap.q, cap.r);
    if (hexes[ck]) hexes[ck]!.terrain = "plains";
    reserved.add(ck);
  }

  paintRivers(hexes, w, h, rng, reserved);
  connectPassable(hexes, w, h);

  for (const cap of capitals) {
    const k = hexKey(cap.q, cap.r);
    if (hexes[k]) hexes[k]!.terrain = "plains";
  }

  if (!force) {
    const baseCounts = terrainCounts(hexes, capitals[0]!, 3);
    for (let i = 1; i < capitals.length; i++) {
      if (!countsEqual(baseCounts, terrainCounts(hexes, capitals[i]!, 3), slack)) return null;
    }
  }

  const settlements: Settlement[] = [];
  const resources: ResourceNode[] = [];

  capitals.forEach((cap, i) => {
    settlements.push({
      id: `cap-${i}`,
      q: cap.q,
      r: cap.r,
      capitalOf: i,
      owner: i,
      buildings: [],
      capturedFrom: null,
      capturedTurn: -99,
      builtThisTurn: false,
    });
  });

  const nNeut = preset.neutralsPerPlayer * players.length;
  const nRes = preset.resourcesPerPlayer * players.length;
  const taken = new Set(capitals.map((c) => hexKey(c.q, c.r)));

  const dirs = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ];

  for (let i = 0; i < players.length; i++) {
    const cap = capitals[i]!;
    const toward = hexRotate60(dirs[0]!, (i + 2) % 6);
    let nHex = hexAdd(cap, { q: toward.q * 4, r: toward.r * 4 });
    if (!inRect(nHex, w, h) || hexes[hexKey(nHex.q, nHex.r)]?.terrain === "mountain" || taken.has(hexKey(nHex.q, nHex.r))) {
      nHex = findSpot(hexes, cap, 3, 5, taken, w, h) ?? nHex;
    }
    if (inRect(nHex, w, h) && hexes[hexKey(nHex.q, nHex.r)]?.terrain !== "mountain") {
      const k = hexKey(nHex.q, nHex.r);
      if (!taken.has(k)) {
        taken.add(k);
        settlements.push({
          id: `n-${i}-0`,
          q: nHex.q,
          r: nHex.r,
          capitalOf: null,
          owner: null,
          buildings: [],
          capturedFrom: null,
          capturedTurn: -99,
          builtThisTurn: false,
        });
      }
    }
    const rDir = hexRotate60(dirs[1]!, i % 6);
    let rHex = hexAdd(cap, { q: rDir.q * 3, r: rDir.r * 3 });
    if (!inRect(rHex, w, h) || hexes[hexKey(rHex.q, rHex.r)]?.terrain === "mountain" || taken.has(hexKey(rHex.q, rHex.r))) {
      rHex = findSpot(hexes, cap, 2, 4, taken, w, h) ?? rHex;
    }
    if (inRect(rHex, w, h) && hexes[hexKey(rHex.q, rHex.r)]?.terrain !== "mountain") {
      const k = hexKey(rHex.q, rHex.r);
      if (!taken.has(k)) {
        taken.add(k);
        const kinds: ResourceKind[] = ["ryo", "supplies", "chakra"];
        resources.push({
          id: `r-${i}-0`,
          q: rHex.q,
          r: rHex.r,
          kind: kinds[i % 3]!,
          owner: null,
          capturedFrom: null,
          capturedTurn: -99,
        });
      }
    }
  }

  const passable = Object.values(hexes).filter(
    (c) => c.terrain !== "mountain" && !taken.has(hexKey(c.q, c.r)),
  );

  const distOk = (h: Hex) => capitals.every((c) => hexDist(c, h) >= 3);

  while (settlements.filter((s) => s.capitalOf === null).length < nNeut) {
    const candidates = passable.filter((c) => distOk(c) && !taken.has(hexKey(c.q, c.r)));
    if (!candidates.length) break;
    const pick = rng.pick(candidates);
    taken.add(hexKey(pick.q, pick.r));
    settlements.push({
      id: `n-x-${settlements.length}`,
      q: pick.q,
      r: pick.r,
      capitalOf: null,
      owner: null,
      buildings: [],
      capturedFrom: null,
      capturedTurn: -99,
      builtThisTurn: false,
    });
    if (settlements.filter((s) => s.capitalOf === null).length >= nNeut) break;
  }

  const kinds: ResourceKind[] = ["ryo", "supplies", "chakra"];
  while (resources.length < nRes) {
    const candidates = passable.filter((c) => distOk(c) && !taken.has(hexKey(c.q, c.r)));
    if (!candidates.length) break;
    const pick = rng.pick(candidates);
    taken.add(hexKey(pick.q, pick.r));
    resources.push({
      id: `r-x-${resources.length}`,
      q: pick.q,
      r: pick.r,
      kind: kinds[resources.length % 3]!,
      owner: null,
      capturedFrom: null,
      capturedTurn: -99,
    });
  }

  if (!force) {
    const nDists = capitals.map((c) => {
      let best = 99;
      for (const s of settlements) {
        if (s.capitalOf !== null) continue;
        best = Math.min(best, hexDist(c, { q: s.q, r: s.r }));
      }
      return best;
    });
    const nSlack = Math.max(1, slack);
    const nMin = Math.min(...nDists);
    const nMax = Math.max(...nDists);
    if (nMin < 99 && nMax - nMin > nSlack) return null;

    const rCounts = capitals.map(
      (c) => resources.filter((r) => hexDist(c, { q: r.q, r: r.r }) <= 4).length,
    );
    const rSlack = Math.max(1, slack);
    if (Math.max(...rCounts) - Math.min(...rCounts) > rSlack) return null;
  }

  return { hexes, settlements, resources, capitals };
}

function dummyRng(): Rng {
  return {
    next: () => 0.37,
    getState: () => 1,
    setState: () => undefined,
    int: () => 0,
    range: (a, b) => (a + b) / 2,
    intRange: (a) => a,
    pick: <T>(arr: readonly T[]) => arr[0]!,
    shuffle: <T>(arr: T[]) => arr,
    chance: () => false,
    signed: () => 1,
    fork: () => dummyRng(),
  };
}

function emptyRectMap(setup: GameSetup): GeneratedMap {
  const { w, h } = setup;
  const hexes: Record<string, HexCell> = {};
  for (const hx of allHexes(w, h)) {
    hexes[hexKey(hx.q, hx.r)] = {
      q: hx.q,
      r: hx.r,
      terrain: "plains",
      owner: null,
      contested: false,
      influence: {},
      capture: null,
    };
  }
  const capitals = placeCapitals(setup, dummyRng());
  const settlements: Settlement[] = capitals.map((cap, i) => ({
    id: `cap-${i}`,
    q: cap.q,
    r: cap.r,
    capitalOf: i,
    owner: i,
    buildings: [],
    capturedFrom: null,
    capturedTurn: -99,
    builtThisTurn: false,
  }));
  return { hexes, settlements, resources: [], capitals };
}

export function generateMap(rng: Rng, setup: GameSetup): GeneratedMap {
  const attempts = BALANCE.map.genAttempts;
  for (let i = 0; i < attempts; i++) {
    const slack = i < 20 ? 0 : i < 40 ? 1 : i < 60 ? 2 : 4;
    const m = tryGenerate(rng, setup, slack);
    if (m) return m;
  }
  const last = tryGenerate(rng, setup, 12, true);
  if (last) return last;
  return emptyRectMap(setup);
}

export function makePlayers(setup: GameSetup): Player[] {
  return setup.players.map((p, i) => {
    const v = BALANCE.villages[p.village];
    return {
      id: i,
      name: p.name || v.name,
      village: p.village,
      difficulty: p.difficulty,
      ryo: BALANCE.income.startRyo,
      supplies: BALANCE.income.startSupplies,
      chakra: BALANCE.income.startChakra,
      commanders: [
        {
          id: `cmd-${i}-0`,
          defId: p.commanderDefId,
          level: 1,
          xp: 0,
          skills: { war: 0, econ: 0, scout: 0 },
          cooldown: 0,
          alive: true,
        },
      ],
      startingCommander: p.commanderDefId,
      alive: true,
      reputation: v.startRep,
      hiredSecond: false,
      hiredThisTurn: 0,
      lastIncome: { ryo: 0, supplies: 0, chakra: 0 },
    };
  });
}

export function startingStacks(
  setup: GameSetup,
  capitals: Hex[],
  settlements: Settlement[],
  resources: ResourceNode[],
  nextId: { n: number },
): Stack[] {
  const stacks: Stack[] = [];
  const nid = () => {
    const id = `s${nextId.n++}`;
    return id;
  };
  const hpOf = (type: UnitId, count: number) =>
    Math.round(BALANCE.units.defs[type].hp * count);

  capitals.forEach((cap, i) => {
    const village = setup.players[i]!.village as VillageId;
    const extra = BALANCE.villages[village].startGeninBonus;
    const n = BALANCE.start.commanderGenin + extra;
    stacks.push({
      id: nid(),
      playerId: i,
      q: cap.q,
      r: cap.r,
      units: [{ type: "genin", count: n, hpTotal: hpOf("genin", n) }],
      commanderId: `cmd-${i}-0`,
      moved: false,
      garrison: false,
    });
    stacks.push({
      id: nid(),
      playerId: i,
      q: cap.q,
      r: cap.r,
      units: [
        {
          type: "genin",
          count: BALANCE.garrisons.capitalCount,
          hpTotal: hpOf("genin", BALANCE.garrisons.capitalCount),
        },
      ],
      commanderId: null,
      moved: false,
      garrison: true,
    });
  });

  for (const s of settlements) {
    if (s.capitalOf !== null) continue;
    stacks.push({
      id: nid(),
      playerId: -1,
      q: s.q,
      r: s.r,
      units: [
        {
          type: "genin",
          count: BALANCE.garrisons.settlementCount,
          hpTotal: hpOf("genin", BALANCE.garrisons.settlementCount),
        },
      ],
      commanderId: null,
      moved: false,
      garrison: true,
    });
  }
  for (const r of resources) {
    stacks.push({
      id: nid(),
      playerId: -1,
      q: r.q,
      r: r.r,
      units: [
        {
          type: "genin",
          count: BALANCE.garrisons.resourceCount,
          hpTotal: hpOf("genin", BALANCE.garrisons.resourceCount),
        },
      ],
      commanderId: null,
      moved: false,
      garrison: true,
    });
  }
  return stacks;
}

export function commandersForVillage(v: VillageId): string[] {
  return Object.values(BALANCE.commanders.defs)
    .filter((c) => c.village === v)
    .map((c) => c.id);
}
