import { useEffect, useRef } from "react";
import { BALANCE, type Terrain, type UnitId, type VillageId } from "@/game/balance";
import type { BattleLogLine, BattleRoster, BattleState } from "@/game/types";
import { drawSpr, loadSprites, spr } from "./sprites";

type Fighter = {
  id: string;
  side: "a" | "d";
  type: UnitId | "cmd";
  village: VillageId | null;
  homeX: number;
  homeY: number;
  h: number;
  x: number;
  y: number;
  count: number;
  hpFrac: number;
  alpha: number;
  flash: number;
  knock: number;
  dead: boolean;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  color: string;
  kind: "spark" | "slash" | "num" | "dust" | "glow";
  text?: string;
  size: number;
};

type Action = {
  kind: "hit" | "tech" | "idle";
  t0: number;
  dur: number;
  fromId: string | null;
  toId: string | null;
  dmg?: number;
  triangle?: boolean;
  fxDone?: boolean;
};

const SLOTS_A = [
  { x: 0.2, y: 0.56, h: 0.4 },
  { x: 0.36, y: 0.82, h: 0.38 },
  { x: 0.13, y: 0.76, h: 0.3 },
];
const SLOTS_D = SLOTS_A.map((s) => ({ x: 1 - s.x, y: s.y, h: s.h }));

function easeOutCubic(t: number) {
  return 1 - (1 - t) ** 3;
}
function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function artKey(f: Fighter): string {
  if (f.type === "cmd" && f.village) return `commanders/${f.village}`;
  if (f.type !== "cmd") return `units/${f.type}`;
  return f.village ? `units/${f.village}` : "units/missing";
}

function buildFighters(
  side: "a" | "d",
  roster: BattleRoster[],
  cmd: boolean,
  village: VillageId | null,
  w: number,
  h: number,
): Fighter[] {
  const slots = side === "a" ? SLOTS_A : SLOTS_D;
  const top = [...roster].filter((u) => u.count > 0).sort((a, b) => b.count - a.count);
  const items: { type: UnitId | "cmd"; count: number }[] = [];
  if (cmd) items.push({ type: "cmd", count: 1 });
  for (const u of top.slice(0, cmd ? 2 : 3)) items.push({ type: u.type, count: u.count });
  return items.map((it, i) => {
    const sl = slots[Math.min(i, slots.length - 1)]!;
    const hp = it.type === "cmd" ? 1 : (() => {
      const orig = roster.find((r) => r.type === it.type);
      const d = orig ? BALANCE.units.defs[orig.type] : null;
      const max = d ? d.hp * Math.max(1, orig!.count) : 1;
      return Math.max(0, Math.min(1, (orig?.hpTotal ?? 0) / max));
    })();
    return {
      id: `${side}-${it.type}`,
      side,
      type: it.type,
      village,
      homeX: sl.x * w,
      homeY: sl.y * h,
      h: sl.h * h,
      x: sl.x * w + (side === "a" ? -w * 0.22 : w * 0.22),
      y: sl.y * h,
      count: it.count,
      hpFrac: hp,
      alpha: 1,
      flash: 0,
      knock: 0,
      dead: hp <= 0,
    };
  });
}

function syncHp(fs: Fighter[], roster: BattleRoster[]) {
  for (const f of fs) {
    if (f.type === "cmd") continue;
    const u = roster.find((r) => r.type === f.type);
    if (!u) {
      f.count = 0;
      f.hpFrac = 0;
      f.dead = true;
      continue;
    }
    const max = BALANCE.units.defs[u.type].hp * Math.max(1, u.count || 1);
    f.count = u.count;
    f.hpFrac = Math.max(0, Math.min(1, u.hpTotal / Math.max(1, max)));
    if (u.hpTotal <= 0 || u.count <= 0) f.dead = true;
  }
}

function terrainSky(t: Terrain): [string, string] {
  switch (t) {
    case "forest":
      return ["#15241c", "#2a4a38"];
    case "desert":
      return ["#2a2418", "#5a4a2c"];
    case "hill":
      return ["#241c16", "#4a3c2c"];
    case "mountain":
      return ["#1a1c22", "#3a404c"];
    case "river":
      return ["#121c28", "#2a4860"];
    case "scorched":
      return ["#221610", "#3e2a1c"];
    default:
      return ["#161c18", "#3a4a3c"];
  }
}

export function ArenaField(props: {
  battle: BattleState;
  line: BattleLogLine | null;
  idx: number;
  phase: string;
  unitsA: BattleRoster[];
  unitsD: BattleRoster[];
  reduced: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fighters = useRef<Fighter[]>([]);
  const parts = useRef<Particle[]>([]);
  const action = useRef<Action | null>(null);
  const shake = useRef(0);
  const freeze = useRef(0);
  const lastKey = useRef("");
  const lastIdx = useRef(-1);
  const walkBorn = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    void loadSprites();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = propsRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        raf = requestAnimationFrame(loop);
        return;
      }

      const b = p.battle;
      const key = `${b.attackerStackId}:${b.defenderStackId}:${b.fromQ}:${b.fromR}:${Math.round(w)}x${Math.round(h)}`;
      if (lastKey.current !== key) {
        lastKey.current = key;
        fighters.current = [
          ...buildFighters("a", b.startA ?? p.unitsA, !!b.attackerCmd, b.attackerVillage ?? null, w, h),
          ...buildFighters("d", b.startD ?? p.unitsD, !!b.defenderCmd, b.defenderVillage ?? null, w, h),
        ];
        parts.current = [];
        action.current = null;
        walkBorn.current = now;
        lastIdx.current = -1;
        shake.current = 0;
      }

      syncHp(
        fighters.current.filter((f) => f.side === "a"),
        p.unitsA,
      );
      syncHp(
        fighters.current.filter((f) => f.side === "d"),
        p.unitsD,
      );

      if (lastIdx.current !== p.idx) {
        lastIdx.current = p.idx;
        const line = p.line;
        if (line?.kind === "hit" && line.from && line.to) {
          const fromId = `${line.side}-${line.from}`;
          const toSide = line.side === "a" ? "d" : "a";
          const toId = `${toSide}-${line.to}`;
          action.current = {
            kind: "hit",
            t0: now,
            dur: p.reduced ? 80 : BALANCE.fx.arenaHitMs,
            fromId,
            toId,
            dmg: line.dmg,
            triangle: line.triangle,
          };
        } else if (line?.kind === "tech") {
          const side = line.side ?? "a";
          action.current = {
            kind: "tech",
            t0: now,
            dur: p.reduced ? 80 : BALANCE.fx.arenaTechMs,
            fromId: `${side}-cmd`,
            toId: null,
          };
        }
      }

      const walkT = p.reduced ? 1 : Math.min(1, (now - walkBorn.current) / BALANCE.fx.arenaWalkMs);
      const walk = easeOutCubic(walkT);
      const frozen = now < freeze.current;
      const act = action.current;
      const at = act ? Math.min(1, (now - act.t0) / act.dur) : 1;

      if (!frozen) {
        if (act?.kind === "hit" && act.dmg && at > 0.42 && !fighters.current.some((f) => f.id === act.fromId)) {
          const tgt = fighters.current.find((x) => x.id === act.toId);
          if (tgt) {
            tgt.flash = 1;
            tgt.knock = 12;
            spawnHit(parts.current, now, tgt.x, tgt.y - tgt.h * 0.45, act.dmg, act.triangle);
            shake.current = Math.min(1, shake.current + 0.4);
          }
          act.dmg = undefined;
        }
        for (const f of fighters.current) {
          const hx = f.homeX;
          const hy = f.homeY;
          const enterX = hx + (f.side === "a" ? -w * 0.28 : w * 0.28);
          let tx = enterX + (hx - enterX) * walk;
          let ty = hy;
          if (act?.kind === "hit" && act.fromId === f.id && !f.dead) {
            const tgt = fighters.current.find((x) => x.id === act.toId);
            const dir = f.side === "a" ? 1 : -1;
            if (at < 0.18) {
              const u = at / 0.18;
              tx = hx - dir * 14 * u;
            } else if (at < 0.48) {
              const u = easeInOut((at - 0.18) / 0.3);
              const gx = tgt ? tgt.x - dir * 28 : hx + dir * 70;
              const gy = tgt ? tgt.y - 8 : hy;
              tx = hx + (gx - hx) * u;
              ty = hy + (gy - hy) * u;
            } else {
              const u = easeOutCubic((at - 0.48) / 0.52);
              const gx = tgt ? tgt.x - dir * 28 : hx + dir * 70;
              tx = gx + (hx - gx) * u;
              ty = (tgt ? tgt.y - 8 : hy) + (hy - (tgt ? tgt.y - 8 : hy)) * u;
            }
            if (at > 0.42 && at < 0.55 && act.dmg) {
              shake.current = Math.min(1, shake.current + 0.55);
              freeze.current = now + 45;
              f.flash = 0.4;
              if (tgt) {
                tgt.flash = 1;
                tgt.knock = (f.side === "a" ? 1 : -1) * 16;
                spawnHit(parts.current, now, tgt.x, tgt.y - tgt.h * 0.45, act.dmg, act.triangle);
              }
              act.dmg = undefined;
            }
          } else if (act?.kind === "tech" && act.fromId && f.id === act.fromId) {
            ty = hy - Math.sin(at * Math.PI) * 10;
            f.flash = Math.max(f.flash, Math.sin(at * Math.PI) * 0.7);
            if (!act.fxDone) {
              act.fxDone = true;
              spawnGlow(parts.current, now, f.x, f.y - f.h * 0.5);
            }
          }
          f.x += (tx - f.x) * (1 - Math.exp(-14 * dt));
          f.y += (ty + f.knock - f.y) * (1 - Math.exp(-12 * dt));
          f.knock *= Math.exp(-8 * dt);
          f.flash *= Math.exp(-6 * dt);
          if (f.dead) f.alpha += (0.28 - f.alpha) * (1 - Math.exp(-3 * dt));
          else f.alpha += (1 - f.alpha) * (1 - Math.exp(-8 * dt));
        }
      }

      shake.current = Math.max(0, shake.current - dt * 3.2);
      parts.current = parts.current.filter((pr) => now - pr.born < pr.life);
      for (const pr of parts.current) {
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        pr.vy += (pr.kind === "num" ? -40 : 80) * dt;
        pr.vx *= 0.98;
      }

      const sx = (Math.random() * 2 - 1) * shake.current * shake.current * BALANCE.fx.arenaShakePx;
      const sy = (Math.random() * 2 - 1) * shake.current * shake.current * BALANCE.fx.arenaShakePx * 0.6;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBg(ctx, w, h, (b.terrain ?? "plains") as Terrain, now, b);
      ctx.save();
      ctx.translate(sx, sy);
      const ordered = fighters.current.slice().sort((a, c) => a.y - c.y);
      for (const f of ordered) drawFighter(ctx, f, now, walk);
      drawParts(ctx, parts.current, now);
      ctx.restore();
      drawVignette(ctx, w, h);

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="arena-stage" ref={wrapRef}>
      <canvas ref={ref} aria-hidden />
    </div>
  );
}

function spawnHit(parts: Particle[], now: number, x: number, y: number, dmg: number, triangle?: boolean) {
  parts.push({
    x,
    y: y - 12,
    vx: 0,
    vy: -28,
    born: now,
    life: 700,
    color: triangle ? "#e8cc5a" : "#f2e6d4",
    kind: "num",
    text: `−${dmg}`,
    size: 18,
  });
  parts.push({
    x,
    y,
    vx: 0,
    vy: 0,
    born: now,
    life: 280,
    color: "#f4e4c8",
    kind: "slash",
    size: 42,
  });
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    parts.push({
      x,
      y,
      vx: Math.cos(a) * (40 + Math.random() * 80),
      vy: Math.sin(a) * (30 + Math.random() * 60),
      born: now,
      life: 280 + Math.random() * 180,
      color: i % 2 ? "#f0d8a8" : "#c45c4a",
      kind: "spark",
      size: 1.4 + Math.random() * 1.6,
    });
  }
  for (let i = 0; i < 4; i++) {
    parts.push({
      x: x + (Math.random() - 0.5) * 20,
      y: y + 18,
      vx: (Math.random() - 0.5) * 20,
      vy: -8,
      born: now,
      life: 420,
      color: "rgba(200,204,212,0.25)",
      kind: "dust",
      size: 6 + Math.random() * 8,
    });
  }
}

function spawnGlow(parts: Particle[], now: number, x: number, y: number) {
  parts.push({
    x,
    y,
    vx: 0,
    vy: -10,
    born: now,
    life: 520,
    color: "#e8cc5a",
    kind: "glow",
    size: 60,
  });
}

function drawBg(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  terrain: Terrain,
  now: number,
  b: BattleState,
) {
  const [c0, c1] = terrainSky(terrain);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, c0);
  g.addColorStop(0.55, c1);
  g.addColorStop(1, "#12151c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const groundY = h * 0.72;
  const tg = ctx.createLinearGradient(0, groundY - 20, 0, h);
  tg.addColorStop(0, "rgba(8,10,14,0)");
  tg.addColorStop(0.15, BALANCE.colors.terrain[terrain][0]);
  tg.addColorStop(1, BALANCE.colors.terrain[terrain][1]);
  ctx.fillStyle = tg;
  ctx.fillRect(0, groundY - 8, w, h - groundY + 8);

  const trees = spr("terrain/trees") ?? spr(`terrain/${terrain}`);
  if (trees) {
    ctx.globalAlpha = 0.35;
    const th = h * 0.55;
    const tw = (trees.naturalWidth / trees.naturalHeight) * th;
    ctx.drawImage(trees, w * 0.5 - tw * 0.55, h * 0.08, tw, th);
    ctx.globalAlpha = 1;
  }

  const va = b.attackerVillage ? spr(`bases/${b.attackerVillage}`) : null;
  const vd = b.defenderVillage ? spr(`bases/${b.defenderVillage}`) : spr("bases/settlement");
  if (va) {
    ctx.globalAlpha = 0.22;
    const bh = h * 0.42;
    const bw = (va.naturalWidth / va.naturalHeight) * bh;
    ctx.drawImage(va, -bw * 0.25, h * 0.12, bw, bh);
    ctx.globalAlpha = 1;
  }
  if (vd) {
    ctx.globalAlpha = 0.22;
    const bh = h * 0.42;
    const bw = (vd.naturalWidth / vd.naturalHeight) * bh;
    ctx.drawImage(vd, w - bw * 0.75, h * 0.12, bw, bh);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = "rgba(200,204,212,0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = groundY + i * 10;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.quadraticCurveTo(w / 2, y + 6, w, y);
    ctx.stroke();
  }

  const mist = (Math.sin(now / 1400) + 1) * 0.04;
  ctx.fillStyle = `rgba(180,200,210,${0.04 + mist})`;
  ctx.fillRect(0, groundY - 30, w, 50);
}

function drawFighter(ctx: CanvasRenderingContext2D, f: Fighter, now: number, walk: number) {
  const bob = f.dead ? 0 : Math.sin(now / 280 + f.homeX) * 2.2;
  const x = f.x;
  const y = f.y + bob;
  ctx.save();
  ctx.globalAlpha = f.alpha * Math.min(1, walk + 0.15);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(x, f.y + 4, f.h * 0.16, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(x, y);
  if (f.side === "d") ctx.scale(-1, 1);
  if (f.flash > 0.05) ctx.filter = `brightness(${1 + f.flash * 1.8})`;
  const drew = drawSpr(ctx, artKey(f), 0, 0, f.h, { anchor: "feet" });
  if (!drew) {
    ctx.fillStyle = f.village ? BALANCE.colors.villages[f.village].accent : "#8b909c";
    ctx.beginPath();
    ctx.arc(0, -f.h * 0.35, f.h * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = "none";
  ctx.restore();

  if (f.type !== "cmd" && f.count > 0) {
    ctx.save();
    ctx.globalAlpha = f.alpha;
    const bw = 36;
    const bx = x - bw / 2;
    const by = y + 6;
    ctx.fillStyle = "rgba(8,10,14,0.7)";
    ctx.fillRect(bx, by, bw, 4);
    ctx.fillStyle = f.village ? BALANCE.colors.villages[f.village].glow : "#c8ccd4";
    ctx.fillRect(bx, by, bw * f.hpFrac, 4);
    ctx.fillStyle = "#e8e6df";
    ctx.font = "600 10px Segoe UI, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`×${f.count}`, x, by + 14);
    ctx.restore();
  }
}

function drawParts(ctx: CanvasRenderingContext2D, parts: Particle[], now: number) {
  for (const p of parts) {
    const t = Math.min(1, (now - p.born) / p.life);
    ctx.globalAlpha = 1 - t;
    if (p.kind === "num") {
      ctx.fillStyle = p.color;
      ctx.font = `700 ${p.size}px Palatino Linotype, Palatino, serif`;
      ctx.textAlign = "center";
      ctx.fillText(p.text ?? "", p.x, p.y - t * 18);
    } else if (p.kind === "slash") {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-0.8 + t * 1.6);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.arc(0, 0, p.size * (0.6 + t * 0.5), -1, 1.2);
      ctx.stroke();
      ctx.restore();
    } else if (p.kind === "glow") {
      const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.size * (1 + t));
      g.addColorStop(0, "rgba(232,204,90,0.45)");
      g.addColorStop(1, "rgba(232,204,90,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 + t), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (p.kind === "dust" ? 1 + t : 1), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.2, w / 2, h * 0.55, h * 0.85);
  g.addColorStop(0, "rgba(8,10,14,0)");
  g.addColorStop(1, "rgba(8,10,14,0.45)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
