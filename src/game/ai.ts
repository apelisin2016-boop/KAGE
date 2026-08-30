import { BALANCE, UNIT_IDS, type BuildingId, type UnitId } from "./balance";
import { stackPower } from "./combat";
import { hexDist, hexKey } from "./hex";
import { createRng } from "./rng";
import {
  allied,
  applyCommand,
  atWar,
  attackForecast,
  attackTargets,
  buildingCost,
  canHireUnit,
  hireCost,
  hostile,
  playerOf,
  reachable,
  skillPointsAvailable,
  stacksAt,
} from "./rules";
import { cloneState } from "./save";
import type { Command, GameState, PlayerId, Stack } from "./types";

function rng(state: GameState) {
  const r = createRng(0);
  r.setState(state.rngState);
  return r;
}

function perceived(state: GameState, raw: number, difficulty: string): number {
  if (difficulty !== "easy") return raw;
  const r = rng(state);
  return raw * r.range(BALANCE.ai.easyMisjudgeMin, BALANCE.ai.easyMisjudgeMax);
}

function armyPower(state: GameState, pid: PlayerId): number {
  const p = playerOf(state, pid);
  let n = 0;
  for (const s of state.stacks) {
    if (s.playerId !== pid || s.garrison) continue;
    n += stackPower(s, p?.village ?? "leaf");
  }
  return n;
}

function goals(state: GameState, pid: PlayerId): { q: number; r: number; score: number }[] {
  const p = playerOf(state, pid)!;
  const out: { q: number; r: number; score: number }[] = [];
  for (const r of state.resources) {
    if (r.owner === pid) continue;
    const def = stacksAt(state, r.q, r.r).filter((s) => s.playerId !== pid);
    const defP = def.reduce((a, s) => a + stackPower(s, null), 0);
    out.push({ q: r.q, r: r.r, score: 120 - defP * 0.4 });
  }
  for (const s of state.settlements) {
    if (s.owner === pid) continue;
    const def = stacksAt(state, s.q, s.r).filter((x) => x.playerId !== pid);
    const defP = def.reduce((a, x) => a + stackPower(x, null), 0);
    const cap = s.capitalOf !== null && s.capitalOf !== pid;
    const ownerPower = s.owner !== null && s.owner >= 0 ? armyPower(state, s.owner) : 8;
    let score = cap ? 200 : 90;
    score -= defP * 0.5;
    if (s.owner !== null && s.owner >= 0 && !hostile(state, pid, s.owner) && !atWar(state, pid, s.owner)) {
      if (allied(state, pid, s.owner)) continue;
    }
    if (s.owner !== null && s.owner >= 0 && armyPower(state, pid) < ownerPower * BALANCE.ai.attackThreshold) {
      score -= 80;
    }
    out.push({ q: s.q, r: s.r, score });
  }
  for (const m of state.missions ?? []) {
    const def = stacksAt(state, m.q, m.r).filter((x) => x.playerId !== pid);
    const defP = def.reduce((a, x) => a + stackPower(x, null), 0);
    const bonus = m.kind === "bounty" ? 70 : m.kind === "cache" ? 55 : 40;
    out.push({ q: m.q, r: m.r, score: bonus - defP * 0.3 });
  }
  void p;
  out.sort((a, b) => b.score - a.score);
  return out;
}

function nearestStack(state: GameState, pid: PlayerId, q: number, r: number): Stack | null {
  const ss = state.stacks.filter((s) => s.playerId === pid && !s.garrison && !s.moved && s.units.length);
  if (!ss.length) return null;
  ss.sort((a, b) => hexDist({ q: a.q, r: a.r }, { q, r }) - hexDist({ q: b.q, r: b.r }, { q, r }));
  return ss[0] ?? null;
}

function pickHire(state: GameState, pid: PlayerId): UnitId | null {
  const p = playerOf(state, pid)!;
  const order: UnitId[] = p.village === "cloud" ? ["cavalry", "anbu", "chunin", "genin", "siege", "illusion"] : ["chunin", "genin", "illusion", "cavalry", "siege", "anbu"];
  for (const u of order) {
    if (!canHireUnit(state, pid, u)) continue;
    const c = hireCost(state, pid, u);
    if (p.ryo >= c.ryo && p.supplies >= c.supplies && p.chakra >= c.chakra) return u;
  }
  return null;
}

function apply(state: GameState, cmd: Command): GameState {
  const r = applyCommand(state, cmd, { inplace: true });
  return r.error ? state : r.state;
}

export function botTurn(state: GameState): GameState {
  let s: GameState;
  try {
    s = cloneState(state);
  } catch {
    return state;
  }
  if (s.battle && !s.battle.done) {
    if (s.battle.battlePhase === "tactics") {
      s = apply(s, { type: "BATTLE_CHOOSE", payload: { tactic: "assault" } });
    }
    if (s.battle && !s.battle.done && s.battle.battlePhase === "retreat") {
      s = apply(s, { type: "BATTLE_CONTINUE" });
    }
    if (s.battle && !s.battle.done) return s;
  }
  const pid = s.currentPlayer;
  const p = playerOf(s, pid);
  if (!p || p.difficulty === "human" || !p.alive) return s;

  const cap = s.settlements.find((x) => x.capitalOf === pid && x.owner === pid);
  if (cap) {
    const bOrder: BuildingId[] = p.village === "stone" ? ["wall", "academy", "market", "hospital", "temple"] : ["academy", "market", "temple", "hospital", "wall"];
    for (const b of bOrder) {
      if (cap.buildings.includes(b) || cap.builtThisTurn) continue;
      const c = buildingCost(s, pid, b);
      if (p.ryo >= c.ryo && p.supplies >= c.supplies) {
        s = apply(s, { type: "BUILD", payload: { building: b, settlementId: cap.id } });
        break;
      }
    }
  }

  const targetArmy = BALANCE.ai.targetArmy + (p.difficulty === "hard" ? 6 : 0);
  let hired = 0;
  while (hired < BALANCE.ai.hirePerTurn) {
    const cur = playerOf(s, pid)!;
    const units = s.stacks.filter((x) => x.playerId === pid && !x.garrison).reduce((n, x) => n + x.units.reduce((a, u) => a + u.count, 0), 0);
    if (units >= targetArmy && cur.ryo < 80) break;
    const u = pickHire(s, pid);
    if (!u || !cap) break;
    const before = cur.ryo;
    s = apply(s, { type: "HIRE", payload: { unit: u, q: cap.q, r: cap.r, count: 1 } });
    if (playerOf(s, pid)!.ryo === before) break;
    hired++;
  }

  for (const c of playerOf(s, pid)!.commanders) {
    while (skillPointsAvailable(c) > 0) {
      const branch = p.difficulty === "hard" ? (c.skills.war < 3 ? "war" : c.skills.econ < 2 ? "econ" : "scout") : c.skills.war < 5 ? "war" : "econ";
      const before = c.skills[branch];
      s = apply(s, { type: "SKILL", payload: { commanderId: c.id, branch } });
      const now = playerOf(s, pid)!.commanders.find((x) => x.id === c.id);
      if (!now || now.skills[branch] === before) break;
    }
  }

  if (s.turn >= BALANCE.commanders.secondHireTurn && !playerOf(s, pid)!.hiredSecond) {
    const used = new Set(playerOf(s, pid)!.commanders.map((c) => c.defId));
    const next = Object.values(BALANCE.commanders.defs).find((d) => d.village === p.village && !used.has(d.id));
    if (next && playerOf(s, pid)!.ryo >= BALANCE.commanders.secondHireCostRyo) {
      s = apply(s, { type: "HIRE_COMMANDER", payload: { defId: next.id } });
    }
  }

  const g = goals(s, pid);
  const moved = new Set<string>();
  for (const goal of g.slice(0, 6)) {
    const st = nearestStack(s, pid, goal.q, goal.r);
    if (!st || moved.has(st.id)) continue;
    const fresh = s.stacks.find((x) => x.id === st.id);
    if (!fresh || fresh.moved) continue;
    const reach = reachable(s, fresh);
    const attacks = attackTargets(s, fresh);
    const goalKey = hexKey(goal.q, goal.r);
    if (attacks.has(goalKey)) {
      const def = stacksAt(s, goal.q, goal.r).filter((x) => x.playerId !== pid);
      const defP = def.reduce((a, x) => a + stackPower(x, null), 0);
      const mine = perceived(s, stackPower(fresh, p.village), p.difficulty);
      if (!(def.length && mine < defP * BALANCE.ai.attackThreshold)) {
        const fc = attackForecast(s, fresh, goal.q, goal.r, BALANCE.combat.botForecastSims);
        if (!fc || fc.winChance >= BALANCE.combat.previewWarnChance) {
          s = apply(s, { type: "ATTACK", payload: { stackId: fresh.id, q: goal.q, r: goal.r } });
          moved.add(fresh.id);
          continue;
        }
      }
    }
    let best: { q: number; r: number; d: number } | null = null;
    for (const [k, cost] of reach) {
      const [q, r] = k.split(",").map(Number);
      const d = hexDist({ q: q!, r: r! }, { q: goal.q, r: goal.r });
      if (!best || d < best.d || (d === best.d && cost < (reach.get(hexKey(best.q, best.r)) ?? 99))) {
        best = { q: q!, r: r!, d };
      }
    }
    if (best && (best.q !== fresh.q || best.r !== fresh.r)) {
      s = apply(s, { type: "MOVE", payload: { stackId: fresh.id, q: best.q, r: best.r } });
      moved.add(fresh.id);
    }
  }

  for (const c of playerOf(s, pid)!.commanders) {
    if (!c.alive || c.cooldown > 0) continue;
    const def = BALANCE.commanders.defs[c.defId as keyof typeof BALANCE.commanders.defs];
    const st = s.stacks.find((x) => x.commanderId === c.id);
    if (!st || !def) continue;
    if (def.tech === "heal" && st.units.some((u) => u.hpTotal < BALANCE.units.defs[u.type].hp * u.count * 0.7)) {
      s = apply(s, { type: "TECHNIQUE", payload: { commanderId: c.id, q: st.q, r: st.r } });
    } else if (def.tech === "line") {
      const foe = s.stacks.find(
        (x) => x.playerId !== pid && hostile(s, pid, x.playerId) && hexDist({ q: x.q, r: x.r }, { q: st.q, r: st.r }) <= 3,
      );
      if (foe) s = apply(s, { type: "TECHNIQUE", payload: { commanderId: c.id, q: foe.q, r: foe.r } });
    } else if (def.tech === "subjugate") {
      const n = s.stacks.find((x) => x.playerId < 0 && hexDist({ q: x.q, r: x.r }, { q: st.q, r: st.r }) <= 2);
      if (n) s = apply(s, { type: "TECHNIQUE", payload: { commanderId: c.id, q: n.q, r: n.r } });
    }
  }

  if (p.difficulty === "hard") {
    for (const o of s.players) {
      if (o.id === pid || !o.alive) continue;
      const rel = s.relations.find((r) => (r.a === pid && r.b === o.id) || (r.a === o.id && r.b === pid));
      const kind = rel?.kind ?? "peace";
      if (kind === "peace" && armyPower(s, pid) < armyPower(s, o.id) * 0.9 && p.reputation >= BALANCE.diplomacy.napRepMin) {
        s = apply(s, { type: "DIPLOMACY", payload: { otherId: o.id, action: "nap" } });
      } else if ((kind === "peace" || kind === "nap") && armyPower(s, pid) > armyPower(s, o.id) * 1.3) {
        s = apply(s, { type: "DIPLOMACY", payload: { otherId: o.id, action: "war" } });
      }
    }
  }

  s = apply(s, { type: "END_TURN" });
  void UNIT_IDS;
  return s;
}

export function botUntilHuman(state: GameState, maxSteps = 12): GameState {
  try {
    let s = state;
    let n = 0;
    while (n++ < maxSteps) {
      const p = playerOf(s, s.currentPlayer);
      if (!p || s.phase === "gameover") break;
      if (p.difficulty === "human") break;
      s = botTurn(s);
    }
    return s;
  } catch {
    return state;
  }
}
