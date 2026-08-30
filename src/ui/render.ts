import { BALANCE, TERRAIN_LABELS, type Terrain, type VillageId } from "@/game/balance";
import {
  hexKey,
  hexToPixel,
  neighbors,
  parseHexKey,
  pixelToHex,
  type Hex,
} from "@/game/hex";
import { hexOf, playerOf, viewingPlayer, visionSet, exploredSet } from "@/game/rules";
import type { BattleLogLine, BattleRoster, BattleState, GameEvent, GameState, Stack } from "@/game/types";
import { drawSpr, spr, spritesReady, stackArt } from "./sprites";

export type Camera = { x: number; y: number; scale: number };

export type Fx = {
  id: number;
  kind: "damage" | "flash" | "pulse" | "spark" | "slash";
  q: number;
  r: number;
  text?: string;
  color?: string;
  born: number;
  life: number;
};

export type MoveAnim = {
  stackId: string;
  from: { q: number; r: number };
  to: { q: number; r: number };
  path: { q: number; r: number }[];
  born: number;
  life: number;
};

export type CombatPose = {
  atkId: string;
  defId: string;
  t0: number;
  dur: number;
  side: "a" | "d" | null;
  aHp?: number;
  aMax?: number;
  aCount?: number;
  dHp?: number;
  dMax?: number;
  dCount?: number;
};

export type View = {
  camera: Camera;
  hover: Hex | null;
  selected: string | null;
  reachable: Set<string>;
  attackable: Set<string>;
  path: Hex[];
  fx: Fx[];
  moves: MoveAnim[];
  now: number;
  reduced: boolean;
  shake: number;
  techAim: boolean;
  combat?: CombatPose | null;
};

const SIZE = BALANCE.map.hexSize;
const COS = [0, 0, 0, 0, 0, 0];
const SIN = [0, 0, 0, 0, 0, 0];
for (let i = 0; i < 6; i++) {
  const a = (Math.PI / 180) * (60 * i - 30);
  COS[i] = Math.cos(a);
  SIN[i] = Math.sin(a);
}

export function worldSize(state: GameState) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const h of Object.values(state.hexes)) {
    const p = hexToPixel(h, SIZE);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX + SIZE * 2, h: maxY - minY + SIZE * 2 };
}

export function fitCamera(state: GameState, vw: number, vh: number): Camera {
  const b = worldSize(state);
  const sx = vw / (b.w + 24);
  const sy = vh / (b.h + 24);
  const scale = Math.min(2.15, Math.max(0.28, Math.min(sx, sy)));
  return {
    x: vw / 2 - ((b.minX + b.maxX) / 2) * scale,
    y: vh / 2 - ((b.minY + b.maxY) / 2) * scale,
    scale,
  };
}

export function screenToHex(cam: Camera, sx: number, sy: number): Hex {
  const x = (sx - cam.x) / cam.scale;
  const y = (sy - cam.y) / cam.scale;
  return pixelToHex(x, y, SIZE);
}

export function panToWorld(state: GameState, wx: number, wy: number, vw: number, vh: number, scale: number): Camera {
  return { x: vw / 2 - wx * scale, y: vh / 2 - wy * scale, scale };
}

function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath();
  ctx.moveTo(x + size * COS[0]!, y + size * SIN[0]!);
  for (let i = 1; i < 6; i++) ctx.lineTo(x + size * COS[i]!, y + size * SIN[i]!);
  ctx.closePath();
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function alongPath(path: { q: number; r: number }[], t: number): { x: number; y: number; hop: number } {
  const pts = path.length >= 2 ? path : path[0] ? [path[0], path[0]] : [{ q: 0, r: 0 }, { q: 0, r: 0 }];
  const segs = Math.max(1, pts.length - 1);
  const f = Math.min(1, Math.max(0, t)) * segs;
  const i = Math.min(segs - 1, Math.floor(f));
  const lt = easeInOut(f - i);
  const a = hexToPixel(pts[i]!, SIZE);
  const b = hexToPixel(pts[i + 1] ?? pts[i]!, SIZE);
  const hop = Math.sin((f - i) * Math.PI) * (SIZE * 0.22);
  return { x: lerp(a.x, b.x, lt), y: lerp(a.y, b.y, lt), hop };
}

type GroundCache = {
  sig: string;
  canvas: HTMLCanvasElement;
  minX: number;
  minY: number;
  w: number;
  h: number;
};

let ground: GroundCache | null = null;
const GROUND_MAX = 4096;

export function bustGround() {
  ground = null;
}

function groundSig(state: GameState, pid: number, vis: Set<string>, explored: Set<string>): string {
  let h = (pid + 1) * 2654435761;
  h ^= vis.size * 33;
  h ^= explored.size * 97;
  for (const c of Object.values(state.hexes)) {
    h = (Math.imul(h, 31) + (c.owner ?? 17) + (c.contested ? 3 : 0) + c.terrain.length) | 0;
  }
  for (const s of state.settlements) {
    h = (Math.imul(h, 31) + (s.owner ?? 9) + s.buildings.length * 7) | 0;
  }
  h ^= (state.resources.length << 8) ^ ((state.missions?.length ?? 0) << 16);
  return `${h}:${spritesReady() ? 1 : 0}:${state.w}x${state.h}`;
}

function paintGround(state: GameState, pid: number, vis: Set<string>, explored: Set<string>, fogOn: boolean): GroundCache {
  const b = worldSize(state);
  const ox = -b.minX + SIZE;
  const oy = -b.minY + SIZE;
  const worldW = Math.max(1, Math.ceil(b.w));
  const worldH = Math.max(1, Math.ceil(b.h));
  const fit = Math.min(1, GROUND_MAX / worldW, GROUND_MAX / worldH);
  const canvas = ground?.canvas && ground.w === worldW && ground.h === worldH ? ground.canvas : document.createElement("canvas");
  const w = Math.max(1, Math.ceil(worldW * fit));
  const h = Math.max(1, Math.ceil(worldH * fit));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.scale(fit, fit);
  ctx.translate(ox, oy);

  const terrainFill: Record<string, string> = {
    plains: "#334438",
    forest: "#234c38",
    hill: "#4a3e32",
    mountain: "#424650",
    river: "#224a60",
    scorched: "#3f3026",
    desert: "#52462c",
  };

  for (const cell of Object.values(state.hexes)) {
    const p = hexToPixel(cell, SIZE);
    const key = hexKey(cell.q, cell.r);
    const known = !fogOn || explored.has(key);
    const seen = !fogOn || vis.has(key);
    hexPath(ctx, p.x, p.y, SIZE - 0.6);
    if (!known) {
      ctx.fillStyle = "#0c1018";
      ctx.fill();
      ctx.strokeStyle = "rgba(8,12,20,0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
      continue;
    }
    const tex = spr(`terrain/${cell.terrain}`);
    if (tex && tex.naturalWidth) {
      ctx.save();
      hexPath(ctx, p.x, p.y, SIZE - 0.6);
      ctx.clip();
      const jitter = ((cell.q * 73856093) ^ (cell.r * 19349663)) >>> 0;
      const s = SIZE * 2.2;
      ctx.drawImage(tex, p.x - s / 2 + (jitter % 7) - 3, p.y - s / 2 + ((jitter >> 3) % 7) - 3, s, s);
      ctx.restore();
    } else {
      ctx.fillStyle = terrainFill[cell.terrain] ?? "#334438";
      ctx.fill();
    }

    if (cell.owner !== null && !cell.contested) {
      const pl = state.players[cell.owner];
      if (pl) {
        hexPath(ctx, p.x, p.y, SIZE - 1.4);
        ctx.fillStyle = hexAlpha(BALANCE.colors.villages[pl.village].accent, seen ? 0.28 : 0.12);
        ctx.fill();
      }
    } else if (cell.contested) {
      hexPath(ctx, p.x, p.y, SIZE - 1.4);
      ctx.fillStyle = "rgba(201,160,102,0.16)";
      ctx.fill();
    }

    hexPath(ctx, p.x, p.y, SIZE - 0.6);
    ctx.strokeStyle = "rgba(8,10,14,0.62)";
    ctx.lineWidth = 1.35;
    ctx.stroke();

    if (!seen) {
      hexPath(ctx, p.x, p.y, SIZE - 0.4);
      ctx.fillStyle = `rgba(8,10,16,${BALANCE.vision.shroudAlpha})`;
      ctx.fill();
    }

    if (cell.terrain === "forest") {
      const jitter = ((cell.q * 17 + cell.r * 31) % 5) - 2;
      drawSpr(ctx, "terrain/trees", p.x + jitter, p.y + 10, SIZE * (seen ? 1.38 : 1.1), { alpha: seen ? 1 : 0.45 });
    } else if (cell.terrain === "mountain") {
      drawSpr(ctx, "terrain/peak", p.x, p.y + 8, SIZE * (seen ? 1.5 : 1.2), { alpha: seen ? 1 : 0.4 });
    } else if (cell.terrain === "hill") {
      drawSpr(ctx, "terrain/peak", p.x, p.y + 10, SIZE * 0.88, { alpha: seen ? 0.85 : 0.35 });
    }
  }

  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  for (const cell of Object.values(state.hexes)) {
    if (cell.owner === null) continue;
    if (fogOn && !explored.has(hexKey(cell.q, cell.r))) continue;
    const pl = state.players[cell.owner];
    if (!pl) continue;
    const p = hexToPixel(cell, SIZE);
    ctx.strokeStyle = hexAlpha(BALANCE.colors.villages[pl.village].glow, vis.has(hexKey(cell.q, cell.r)) ? 0.65 : 0.25);
    for (const n of neighbors(cell)) {
      const nc = hexOf(state, n.q, n.r);
      if (!nc || nc.owner === cell.owner) continue;
      if (fogOn && !explored.has(hexKey(n.q, n.r))) continue;
      const np = hexToPixel(n, SIZE);
      const mx = (p.x + np.x) / 2;
      const my = (p.y + np.y) / 2;
      const dx = np.x - p.x;
      const dy = np.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * (SIZE * 0.52);
      const py = (dx / len) * (SIZE * 0.52);
      ctx.beginPath();
      ctx.moveTo(mx - px, my - py);
      ctx.lineTo(mx + px, my + py);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  for (const s of state.settlements) {
    if (fogOn && !explored.has(hexKey(s.q, s.r))) continue;
    const p = hexToPixel(s, SIZE);
    const owner = s.owner !== null ? state.players[s.owner] : null;
    const village = owner?.village ?? null;
    const col = village ? BALANCE.colors.villages[village].accent : "rgba(200,204,212,0.45)";
    const seenHere = vis.has(hexKey(s.q, s.r));
    ctx.globalAlpha = !seenHere && fogOn ? 0.5 : 1;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 8, SIZE * 0.55, SIZE * 0.28, 0, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(col, 0.35);
    ctx.fill();
    const baseKey = s.capitalOf !== null ? `bases/${village ?? "leaf"}` : "bases/settlement";
    const h = s.capitalOf !== null ? SIZE * 1.85 : SIZE * 1.35;
    if (!drawSpr(ctx, baseKey, p.x, p.y + 10, h)) {
      if (s.capitalOf !== null) drawStar(ctx, p.x, p.y - 10, 7, col);
      else {
        ctx.fillStyle = col;
        ctx.fillRect(p.x - 6, p.y - 12, 12, 10);
      }
    }
    if (s.capitalOf !== null) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(p.x + 10, p.y - h + 16);
      ctx.lineTo(p.x + 22, p.y - h + 18);
      ctx.lineTo(p.x + 10, p.y - h + 28);
      ctx.closePath();
      ctx.fill();
    }
    if (seenHere) {
      s.buildings.forEach((b, i) => {
        const ang = -0.9 + i * 0.55;
        const bx = p.x + Math.cos(ang) * (SIZE * 0.7);
        const by = p.y + 6 + Math.sin(ang) * (SIZE * 0.35);
        drawSpr(ctx, `buildings/${b}`, bx, by, SIZE * 0.55);
      });
    }
    ctx.globalAlpha = 1;
  }

  for (const r of state.resources) {
    if (fogOn && !explored.has(hexKey(r.q, r.r))) continue;
    const p = hexToPixel(r, SIZE);
    const dim = !vis.has(hexKey(r.q, r.r)) && fogOn;
    ctx.globalAlpha = dim ? 0.45 : 1;
    if (!drawSpr(ctx, `props/${r.kind}`, p.x, p.y + 8, SIZE * 0.7)) {
      ctx.fillStyle = r.kind === "ryo" ? "#c9a066" : r.kind === "supplies" ? "#7a9e6a" : "#7ec8e3";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + 3);
      ctx.lineTo(p.x + 5, p.y + 8);
      ctx.lineTo(p.x, p.y + 13);
      ctx.lineTo(p.x - 5, p.y + 8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  for (const m of state.missions ?? []) {
    if (fogOn && !explored.has(hexKey(m.q, m.r))) continue;
    const p = hexToPixel(m, SIZE);
    const dim = !vis.has(hexKey(m.q, m.r)) && fogOn;
    ctx.globalAlpha = dim ? 0.5 : 1;
    if (!drawSpr(ctx, `props/${m.kind}`, p.x, p.y + 8, SIZE * 0.78)) {
      ctx.fillStyle = m.kind === "bounty" ? "#c45c4a" : m.kind === "shrine" ? "#7ec8e3" : "#e8cc5a";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 9);
      ctx.lineTo(p.x + 6, p.y);
      ctx.lineTo(p.x, p.y + 9);
      ctx.lineTo(p.x - 6, p.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return { sig: groundSig(state, pid, vis, explored), canvas, minX: b.minX - SIZE, minY: b.minY - SIZE, w: worldW, h: worldH };
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  view: View,
  w: number,
  h: number,
  dpr: number,
) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = BALANCE.colors.bg;
  ctx.fillRect(0, 0, w, h);

  const shake = view.shake * view.shake;
  const ox = shake ? (Math.random() - 0.5) * 8 * shake : 0;
  const oy = shake ? (Math.random() - 0.5) * 8 * shake : 0;

  ctx.save();
  ctx.translate(view.camera.x + ox, view.camera.y + oy);
  ctx.scale(view.camera.scale, view.camera.scale);

  const pid = viewingPlayer(state);
  const vis = visionSet(state, pid);
  const explored = exploredSet(state, pid);
  const fogOn = BALANCE.vision.fog && state.players[pid]?.difficulty === "human";

  const sig = groundSig(state, pid, vis, explored);
  if (!ground || ground.sig !== sig || ground.w !== Math.ceil(worldSize(state).w) || ground.h !== Math.ceil(worldSize(state).h)) {
    try {
      ground = paintGround(state, pid, vis, explored, fogOn);
    } catch {
      ground = null;
    }
  }
  if (ground) ctx.drawImage(ground.canvas, ground.minX, ground.minY, ground.w, ground.h);

  const inv = 1 / view.camera.scale;
  const left = (-view.camera.x) * inv - SIZE * 2;
  const top = (-view.camera.y) * inv - SIZE * 2;
  const right = (w - view.camera.x) * inv + SIZE * 2;
  const bottom = (h - view.camera.y) * inv + SIZE * 2;
  const inView = (x: number, y: number) => x > left && x < right && y > top && y < bottom;

  for (const cell of Object.values(state.hexes)) {
    if (!cell.capture) continue;
    const key = hexKey(cell.q, cell.r);
    if (fogOn && !explored.has(key)) continue;
    const p = hexToPixel(cell, SIZE);
    if (!inView(p.x, p.y)) continue;
    const t = (Math.sin(view.now / 220) + 1) / 2;
    hexPath(ctx, p.x, p.y, SIZE - 2);
    const pl = cell.capture.playerId >= 0 ? state.players[cell.capture.playerId] : undefined;
    ctx.strokeStyle = hexAlpha(pl ? BALANCE.colors.villages[pl.village].glow : "#fff", 0.35 + t * 0.5);
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  if (view.reachable.size) {
    ctx.fillStyle = "rgba(200,204,212,0.10)";
    ctx.strokeStyle = "rgba(200,204,212,0.42)";
    ctx.lineWidth = 1.4;
    for (const k of view.reachable) {
      const hxd = parseHexKey(k);
      const p = hexToPixel(hxd, SIZE);
      if (!inView(p.x, p.y)) continue;
      hexPath(ctx, p.x, p.y, SIZE - 3);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (view.attackable.size) {
    const pulse = 0.45 + 0.25 * Math.sin(view.now / 180);
    ctx.fillStyle = `rgba(196,92,74,${0.14 + pulse * 0.08})`;
    ctx.strokeStyle = `rgba(196,92,74,${0.55 + pulse * 0.35})`;
    ctx.lineWidth = 2.2;
    for (const k of view.attackable) {
      const hxd = parseHexKey(k);
      const p = hexToPixel(hxd, SIZE);
      if (!inView(p.x, p.y)) continue;
      hexPath(ctx, p.x, p.y, SIZE - 3);
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.translate(p.x, p.y - 2);
      ctx.strokeStyle = `rgba(232,180,160,${0.75 + pulse * 0.2})`;
      ctx.lineWidth = 2.1;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-7, -6);
      ctx.lineTo(7, 8);
      ctx.moveTo(7, -6);
      ctx.lineTo(-7, 8);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (view.path.length > 1) {
    ctx.beginPath();
    const a0 = hexToPixel(view.path[0]!, SIZE);
    ctx.moveTo(a0.x, a0.y);
    for (let i = 1; i < view.path.length; i++) {
      const p = hexToPixel(view.path[i]!, SIZE);
      ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = "rgba(232,236,242,0.7)";
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  if (view.hover) {
    const cell = hexOf(state, view.hover.q, view.hover.r);
    if (cell) {
      const p = hexToPixel(cell, SIZE);
      hexPath(ctx, p.x, p.y, SIZE - 1.5);
      const atkHover = view.hover && view.attackable.has(hexKey(view.hover.q, view.hover.r));
      ctx.strokeStyle = view.techAim
        ? "rgba(126,200,227,0.95)"
        : atkHover
          ? "rgba(196,92,74,0.95)"
          : "rgba(232,236,242,0.85)";
      ctx.lineWidth = atkHover ? 3 : 2.2;
      ctx.stroke();
    }
  }

  if (view.combat) {
    const ids = [view.combat.atkId, view.combat.defId];
    const pulse = 0.45 + 0.3 * Math.sin(view.now / 140);
    for (const id of ids) {
      const st = state.stacks.find((s) => s.id === id);
      if (!st) continue;
      const p = hexToPixel(st, SIZE);
      hexPath(ctx, p.x, p.y, SIZE - 1.2);
      ctx.strokeStyle = `rgba(232, 180, 120, ${0.35 + pulse * 0.45})`;
      ctx.lineWidth = 3.2;
      ctx.stroke();
    }
  }

  const stacks = state.stacks;
  const seen = new Map<string, number>();
  for (const st of stacks) {
    if (fogOn && !vis.has(hexKey(st.q, st.r))) continue;
    const p = hexToPixel({ q: st.q, r: st.r }, SIZE);
    if (!inView(p.x, p.y) && !view.moves.some((m) => m.stackId === st.id)) continue;
    const k = hexKey(st.q, st.r);
    const idx = seen.get(k) ?? 0;
    seen.set(k, idx + 1);
    drawToken(ctx, state, st, view, idx);
  }

  for (const fx of view.fx) {
    const t = (view.now - fx.born) / fx.life;
    if (t < 0 || t > 1) continue;
    const p = hexToPixel({ q: fx.q, r: fx.r }, SIZE);
    if (fx.kind === "damage") {
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = fx.color ?? "#f0d8a8";
      ctx.strokeStyle = "rgba(8,10,14,0.75)";
      ctx.lineWidth = 5;
      ctx.font = "800 24px Palatino Linotype, Palatino, serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const ty = p.y - 36 - t * 36;
      ctx.strokeText(fx.text ?? "", p.x, ty);
      ctx.fillText(fx.text ?? "", p.x, ty);
      ctx.globalAlpha = 1;
    } else if (fx.kind === "slash") {
      ctx.save();
      ctx.translate(p.x, p.y - 6);
      ctx.rotate(-0.75 + t * 1.65);
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.strokeStyle = fx.color ?? "#e8b4a0";
      ctx.lineWidth = 6.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(0, 0, SIZE * (0.62 + t * 0.28), -0.95, 1.2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(244,241,234,0.7)";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, SIZE * (0.42 + t * 0.2), -0.7, 0.95);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    } else if (fx.kind === "pulse") {
      const a = (Math.sin(view.now / 180) + 1) / 2;
      ctx.globalAlpha = 0.25 + a * 0.35;
      hexPath(ctx, p.x, p.y, SIZE - 2);
      ctx.strokeStyle = fx.color ?? "#e8cc5a";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (fx.kind === "spark") {
      const ang = (fx.id % 8) * 0.8 + t * 2.4;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = fx.color ?? "#fff";
      ctx.beginPath();
      ctx.arc(p.x + Math.cos(ang) * 18 * t, p.y + Math.sin(ang) * 18 * t, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  ctx.restore();
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  cam: Camera,
  vw: number,
  vh: number,
  mw: number,
  mh: number,
  dpr: number,
) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0, 0, mw, mh);
  const b = worldSize(state);
  const s = Math.min(mw / b.w, mh / b.h);
  const ox = (mw - b.w * s) / 2 - b.minX * s;
  const oy = (mh - b.h * s) / 2 - b.minY * s;
  const pid = viewingPlayer(state);
  const vis = visionSet(state, pid);
  const explored = exploredSet(state, pid);
  const fogOn = BALANCE.vision.fog && state.players[pid]?.difficulty === "human";

  for (const cell of Object.values(state.hexes)) {
    const p = hexToPixel(cell, SIZE);
    const x = p.x * s + ox;
    const y = p.y * s + oy;
    const key = hexKey(cell.q, cell.r);
    const known = !fogOn || explored.has(key);
    if (!known) {
      ctx.fillStyle = "#12161f";
    } else if (cell.owner !== null && state.players[cell.owner]) {
      ctx.fillStyle = BALANCE.colors.villages[state.players[cell.owner]!.village].accent;
    } else {
      ctx.fillStyle = vis.has(key) ? "#3a4450" : "#222830";
    }
    ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
  }

  for (const st of state.stacks) {
    if (st.garrison) continue;
    if (fogOn && !vis.has(hexKey(st.q, st.r))) continue;
    const p = hexToPixel(st, SIZE);
    const x = p.x * s + ox;
    const y = p.y * s + oy;
    const pl = st.playerId >= 0 ? state.players[st.playerId] : null;
    ctx.fillStyle = pl ? BALANCE.colors.villages[pl.village].glow : "#c8ccd4";
    ctx.beginPath();
    ctx.arc(x, y, st.commanderId ? 2.6 : 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const m of state.missions ?? []) {
    if (fogOn && !explored.has(hexKey(m.q, m.r))) continue;
    const p = hexToPixel(m, SIZE);
    const x = p.x * s + ox;
    const y = p.y * s + oy;
    ctx.fillStyle = "#e8cc5a";
    ctx.fillRect(x - 1.8, y - 1.8, 3.6, 3.6);
  }

  const vx = ((-cam.x) / cam.scale) * s + ox;
  const vy = ((-cam.y) / cam.scale) * s + oy;
  const vwS = (vw / cam.scale) * s;
  const vhS = (vh / cam.scale) * s;
  ctx.strokeStyle = "rgba(232,236,242,0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(vx, vy, vwS, vhS);
}

export function minimapToWorld(
  state: GameState,
  mx: number,
  my: number,
  mw: number,
  mh: number,
): { x: number; y: number } {
  const b = worldSize(state);
  const s = Math.min(mw / b.w, mh / b.h);
  const ox = (mw - b.w * s) / 2 - b.minX * s;
  const oy = (mh - b.h * s) / 2 - b.minY * s;
  return { x: (mx - ox) / s, y: (my - oy) / s };
}

function combatShift(st: Stack, view: View, state: GameState): { x: number; y: number; flash: number; scale: number } {
  const c = view.combat;
  if (!c) return { x: 0, y: 0, flash: 0, scale: 1 };
  const isAtk = st.id === c.atkId;
  const isDef = st.id === c.defId;
  if (!isAtk && !isDef) return { x: 0, y: 0, flash: 0, scale: 1 };
  const atk = state.stacks.find((s) => s.id === c.atkId);
  const def = state.stacks.find((s) => s.id === c.defId);
  if (!atk || !def) return { x: 0, y: 0, flash: 0, scale: 1 };
  const ap = hexToPixel(atk, SIZE);
  const dp = hexToPixel(def, SIZE);
  const dx = dp.x - ap.x;
  const dy = dp.y - ap.y;
  const t = Math.min(1, Math.max(0, (view.now - c.t0) / Math.max(1, c.dur)));
  const striker = c.side === "d" ? isDef : isAtk;
  const target = c.side === "d" ? isAtk : isDef;
  if (striker) {
    let k = 0;
    if (t < 0.18) k = -0.2 * (t / 0.18);
    else if (t < 0.46) k = -0.2 + 0.92 * ((t - 0.18) / 0.28);
    else k = 0.72 * (1 - (t - 0.46) / 0.54);
    const squash = t > 0.18 && t < 0.5 ? 1.12 : 1;
    return { x: dx * k, y: dy * k, flash: t > 0.38 && t < 0.62 ? 0.7 : 0, scale: squash };
  }
  if (target && t > 0.38 && t < 0.9) {
    const u = Math.sin(((t - 0.38) / 0.52) * Math.PI) * 0.22;
    return { x: dx * u, y: dy * u, flash: t < 0.62 ? 0.95 : 0.25, scale: t < 0.62 ? 0.9 : 1 };
  }
  return { x: 0, y: 0, flash: 0, scale: 1 };
}

function drawToken(ctx: CanvasRenderingContext2D, state: GameState, st: Stack, view: View, slot = 0) {
  const anim = view.moves.find((m) => m.stackId === st.id);
  const ox = (slot % 2) * 12 - (slot > 0 ? 6 : 0);
  const oy = Math.floor(slot / 2) * 12;
  const shift = combatShift(st, view, state);
  if (anim) {
    const raw = Math.min(1, Math.max(0, (view.now - anim.born) / anim.life));
    const path = anim.path.length >= 2 ? anim.path : [anim.from, anim.to];
    const p = alongPath(path, view.reduced ? 1 : raw);
    const hop = view.reduced ? 0 : p.hop;
    return drawTokenAt(ctx, state, st, p.x + ox + shift.x, p.y + oy - hop + shift.y, view, shift.flash, shift.scale);
  }
  const p = hexToPixel({ q: st.q, r: st.r }, SIZE);
  drawTokenAt(ctx, state, st, p.x + ox + shift.x, p.y + oy + shift.y, view, shift.flash, shift.scale);
}

function stackTitle(state: GameState, st: Stack): string {
  if (st.playerId < 0) return "Нукенин";
  const p = st.playerId >= 0 ? state.players[st.playerId] : undefined;
  if (st.commanderId && p) {
    const c = p.commanders.find((x) => x.id === st.commanderId);
    if (c) {
      const def = BALANCE.commanders.defs[c.defId as keyof typeof BALANCE.commanders.defs];
      return def?.name ?? "Командир";
    }
  }
  const main = [...st.units].sort((a, b) => b.count - a.count)[0];
  return main ? (BALANCE.units.defs[main.type]?.name ?? "Отряд") : "Отряд";
}

function drawTokenAt(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  st: Stack,
  x: number,
  y: number,
  view: View,
  hitFlash = 0,
  poseScale = 1,
) {
  const p = st.playerId >= 0 ? state.players[st.playerId] : undefined;
  const village: VillageId | null = p?.village ?? null;
  const accent = village ? BALANCE.colors.villages[village].accent : "#8b909c";
  const glow = village ? BALANCE.colors.villages[village].glow : "#c8ccd4";
  let count = st.units.reduce((n, u) => n + u.count, 0);
  let hp = st.units.reduce((n, u) => n + u.hpTotal, 0);
  let maxHp = st.units.reduce((n, u) => {
    const d = BALANCE.units.defs[u.type];
    return n + (d ? d.hp * Math.max(1, u.count) : 0);
  }, 0);
  const pose = view.combat;
  if (pose) {
    if (st.id === pose.atkId && pose.aMax) {
      hp = pose.aHp ?? hp;
      maxHp = pose.aMax;
      count = pose.aCount ?? count;
    } else if (st.id === pose.defId && pose.dMax) {
      hp = pose.dHp ?? hp;
      maxHp = pose.dMax;
      count = pose.dCount ?? count;
    }
  }
  const isCmd = !!st.commanderId;
  const selected = view.selected === st.id;
  const mine = st.playerId === viewingPlayer(state);
  const idle = mine && !st.garrison && !st.moved;
  const spent = mine && !st.garrison && st.moved;
  const main = [...st.units].sort((a, b) => b.count - a.count)[0];
  const h = isCmd
    ? SIZE * 2.22
    : st.garrison
      ? SIZE * 1.35
      : main?.type === "cavalry" || main?.type === "siege"
        ? SIZE * 2.02
        : SIZE * 1.88;
  const spriteKey = stackArt({
    village,
    commander: isCmd,
    missing: st.playerId < 0,
    unit: main?.type ?? null,
  });

  ctx.save();
  if (spent) ctx.globalAlpha *= 0.55;
  if (hitFlash) ctx.globalAlpha *= 0.5 + hitFlash * 0.5;
  if (poseScale !== 1) {
    ctx.translate(x, y);
    ctx.scale(poseScale, 2 - poseScale);
    ctx.translate(-x, -y);
  }

  ctx.beginPath();
  ctx.ellipse(x, y + 12, SIZE * 0.58, SIZE * 0.28, 0, 0, Math.PI * 2);
  ctx.fillStyle = selected ? "rgba(244,241,234,0.55)" : hexAlpha(accent, 0.48);
  ctx.fill();
  if (selected) {
    ctx.strokeStyle = "#f4f1ea";
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }
  if (idle && !view.reduced) {
    const pulse = 0.3 + 0.24 * Math.sin(view.now / 260);
    ctx.beginPath();
    ctx.ellipse(x, y + 12, SIZE * (0.64 + pulse * 0.12), SIZE * 0.32, 0, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(glow, pulse);
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  ctx.shadowColor = "rgba(6,8,12,0.7)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 5;
  if (!drawSpr(ctx, spriteKey, x, y + 12, h)) {
    ctx.beginPath();
    ctx.arc(x, y + 2, isCmd ? 22 : 18, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  if (hitFlash > 0.4) {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha *= 0.45;
    drawSpr(ctx, spriteKey, x, y + 12, h);
    ctx.globalCompositeOperation = "source-over";
  }

  if (village) {
    const kanji = BALANCE.colors.villages[village].kanji;
    const badge = Math.max(11, SIZE * 0.22);
    ctx.beginPath();
    ctx.arc(x + SIZE * 0.42, y + 8, badge, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(accent, 0.96);
    ctx.fill();
    ctx.strokeStyle = "rgba(10,12,16,0.45)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#f4f1ea";
    ctx.font = `700 ${Math.round(badge + 3)}px Palatino Linotype, Palatino, serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(kanji, x + SIZE * 0.42, y + 9);
  }

  if (isCmd && main && spr(`icons/${main.type}`)) {
    drawSpr(ctx, `icons/${main.type}`, x - SIZE * 0.5, y + 10, Math.max(20, SIZE * 0.38), { anchor: "center" });
  }

  const frac = maxHp > 0 ? hp / maxHp : 1;
  const barW = SIZE * 1.15;
  ctx.fillStyle = "rgba(8,10,14,0.82)";
  ctx.fillRect(x - barW / 2, y + 14, barW, 7);
  ctx.fillStyle = frac > 0.5 ? glow : frac > 0.25 ? "#c9a066" : "#c45c4a";
  ctx.fillRect(x - barW / 2, y + 14, barW * frac, 7);
  ctx.strokeStyle = "rgba(244,241,234,0.22)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x - barW / 2, y + 14, barW, 7);

  const title = stackTitle(state, st);
  const fs = isCmd ? 16 : 15;
  ctx.font = `700 ${fs}px ui-sans-serif, system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const label = count ? `${title} · ${count}` : title;
  const tw = Math.min(SIZE * 2.8, ctx.measureText(label).width + 16);
  ctx.fillStyle = "rgba(8,10,14,0.82)";
  ctx.fillRect(x - tw / 2, y + 24, tw, 20);
  ctx.fillStyle = glow;
  ctx.fillRect(x - tw / 2, y + 24, 5, 20);
  ctx.strokeStyle = "rgba(8,10,14,0.85)";
  ctx.lineWidth = 3;
  ctx.strokeText(label, x + 3, y + 27);
  ctx.fillStyle = "#f4f1ea";
  ctx.fillText(label, x + 3, y + 27);
  ctx.restore();
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.45;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

const alphaCache = new Map<string, string>();
function hexAlpha(hex: string, a: number) {
  const key = hex + a.toFixed(2);
  const hit = alphaCache.get(key);
  if (hit) return hit;
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const out = `rgba(${r},${g},${b},${a})`;
  alphaCache.set(key, out);
  return out;
}

let fxId = 1;
export function eventsToFx(events: GameEvent[], now: number, reduced = false): { fx: Fx[]; moves: MoveAnim[] } {
  const fx: Fx[] = [];
  const moves: MoveAnim[] = [];
  const strike = events.some((e) => e.kind === "battle");
  for (const e of events) {
    if (e.kind !== "move") continue;
    const path = e.path && e.path.length >= 2 ? e.path : [e.from, e.to];
    const steps = Math.max(1, path.length - 1);
    const life = reduced ? 1 : Math.min(900, Math.max(160, BALANCE.fx.moveMs * steps));
    moves.push({ stackId: e.stackId, from: e.from, to: e.to, path, born: now, life });
  }
  const delay = strike && !reduced ? (moves[0]?.life ?? 0) : 0;
  for (const e of events) {
    if (e.kind === "damage") {
      fx.push({ id: fxId++, kind: "damage", q: e.q, r: e.r, text: e.text, color: e.color, born: now + delay, life: BALANCE.fx.damageMs });
    } else if (e.kind === "flash") {
      fx.push({ id: fxId++, kind: "flash", q: e.q, r: e.r, color: e.color, born: now + delay, life: BALANCE.fx.flashMs });
      for (let i = 0; i < 5; i++) {
        fx.push({ id: fxId++, kind: "spark", q: e.q, r: e.r, color: e.color, born: now + delay, life: 500 });
      }
      if (strike) {
        fx.push({ id: fxId++, kind: "slash", q: e.q, r: e.r, color: e.color, born: now + delay, life: BALANCE.fx.slashMs });
      }
    } else if (e.kind === "pulse") {
      fx.push({ id: fxId++, kind: "pulse", q: e.q, r: e.r, born: now, life: BALANCE.fx.pulseMs });
    }
  }
  return { fx, moves };
}

export function battleHitFx(line: BattleLogLine, battle: BattleState, now: number): Fx[] {
  if (line.kind !== "hit" && line.kind !== "tech") return [];
  const targetIsDef = line.side === "a";
  const q = targetIsDef ? battle.hexQ : (battle.fromQ ?? battle.hexQ);
  const r = targetIsDef ? battle.hexR : (battle.fromR ?? battle.hexR);
  const out: Fx[] = [];
  if (line.kind === "hit") {
    out.push({
      id: fxId++,
      kind: "damage",
      q,
      r,
      text: `−${line.dmg ?? 0}`,
      color: line.triangle ? "#e8cc5a" : "#f0d8a8",
      born: now,
      life: BALANCE.fx.damageMs,
    });
    out.push({ id: fxId++, kind: "slash", q, r, color: "#e8b4a0", born: now, life: BALANCE.fx.slashMs });
    for (let i = 0; i < 8; i++) {
      out.push({ id: fxId++, kind: "spark", q, r, color: line.triangle ? "#e8cc5a" : "#fff", born: now, life: 580 });
    }
  } else {
    out.push({ id: fxId++, kind: "flash", q, r, color: "#7ec8e3", born: now, life: BALANCE.fx.flashMs });
    out.push({ id: fxId++, kind: "slash", q, r, color: "#7ec8e3", born: now, life: BALANCE.fx.slashMs });
  }
  return out;
}

function cloneRoster(r?: BattleRoster[]): BattleRoster[] {
  return (r ?? []).map((u) => ({ ...u }));
}

function rosterAt(start: BattleRoster[] | undefined, log: BattleLogLine[], idx: number, asTarget: "a" | "d"): BattleRoster[] {
  const r = cloneRoster(start);
  for (let i = 0; i <= idx; i++) {
    const h = log[i];
    if (!h || (h.kind !== "hit" && h.kind !== "tech") || !h.to) continue;
    const hitThis = (h.side === "a" && asTarget === "d") || (h.side === "d" && asTarget === "a");
    if (!hitThis) continue;
    const slot = r.find((u) => u.type === h.to);
    if (!slot) continue;
    if (h.toHp !== undefined) slot.hpTotal = h.toHp;
    if (h.toCount !== undefined) slot.count = h.toCount;
  }
  return r;
}

function rosterSum(units: BattleRoster[], start?: BattleRoster[]): { hp: number; max: number; count: number } {
  const base = start && start.length ? start : units;
  let hp = 0;
  let max = 0;
  let count = 0;
  for (const orig of base) {
    const d = BALANCE.units.defs[orig.type];
    const live = units.find((u) => u.type === orig.type) ?? orig;
    hp += Math.max(0, live.hpTotal);
    count += Math.max(0, live.count);
    if (d) max += d.hp * Math.max(1, orig.count);
  }
  return { hp, max, count };
}

export function combatHpFromLog(battle: BattleState, idx: number): Pick<CombatPose, "aHp" | "aMax" | "aCount" | "dHp" | "dMax" | "dCount"> {
  const played = Math.max(-1, idx);
  const a = played < 0 ? cloneRoster(battle.startA) : rosterAt(battle.startA, battle.log, played, "a");
  const d = played < 0 ? cloneRoster(battle.startD) : rosterAt(battle.startD, battle.log, played, "d");
  const as = rosterSum(a, battle.startA);
  const ds = rosterSum(d, battle.startD);
  return { aHp: as.hp, aMax: as.max, aCount: as.count, dHp: ds.hp, dMax: ds.max, dCount: ds.count };
}

export function tooltipText(state: GameState, h: Hex): string[] {
  const cell = hexOf(state, h.q, h.r);
  if (!cell) return [];
  const pid = viewingPlayer(state);
  const fogOn = BALANCE.vision.fog && state.players[pid]?.difficulty === "human";
  const vis = visionSet(state, pid);
  const explored = exploredSet(state, pid);
  const key = hexKey(h.q, h.r);
  if (fogOn && !explored.has(key)) return ["Туман войны", "Неизведанная земля"];
  const seen = !fogOn || vis.has(key);
  const lines = [`${TERRAIN_LABELS[cell.terrain]}  ·  ${h.q},${h.r}`];
  if (cell.owner !== null) {
    const p = playerOf(state, cell.owner);
    lines.push(`Владелец: ${p?.name ?? "?"}`);
  } else if (cell.contested) lines.push("Спорная зона");
  const stl = state.settlements.find((s) => s.q === h.q && s.r === h.r);
  if (stl) {
    lines.push(stl.capitalOf !== null ? "Столица" : "Поселение");
    if (stl.buildings.length && seen) lines.push(stl.buildings.map((b) => BALANCE.buildings[b].name).join(", "));
  }
  const res = state.resources.find((s) => s.q === h.q && s.r === h.r);
  if (res) lines.push(`Ресурс: ${res.kind === "ryo" ? "рё" : res.kind === "supplies" ? "припасы" : "чакра"}`);
  const mission = state.missions?.find((s) => s.q === h.q && s.r === h.r);
  if (mission) lines.push(`Метка: ${BALANCE.missions.kinds[mission.kind].name} (${mission.turnsLeft})`);
  if (!seen) {
    lines.push("Скрыто туманом");
    return lines;
  }
  const stacks = state.stacks.filter((s) => s.q === h.q && s.r === h.r);
  for (const s of stacks) {
    const p = playerOf(state, s.playerId);
    const units = s.units.map((u) => `${BALANCE.units.defs[u.type]?.name ?? u.type} ${u.count}`).join(", ");
    lines.push(`${p?.name ?? "Нейтрал"}: ${units || "командир"}`);
  }
  if (cell.capture) {
    const p = playerOf(state, cell.capture.playerId);
    lines.push(`Захват: ${p?.name} (${cell.capture.turns + 1}/${BALANCE.influence.captureTurns})`);
  }
  return lines;
}
