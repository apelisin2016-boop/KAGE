// @ts-nocheck
import { BALANCE, TECH_LABELS, TERRAIN_LABELS, type BuildingId, type SkillBranch, type TacticId, type TechId, type Terrain, type UnitId, type VillageId } from "./balance";
import {
  applyRetreatLoss,
  describeFightMods,
  fight,
  forecastFight,
  pickTactic,
  remainingWinChance,
  stackPower,
  type FightContext,
} from "./combat";
import {
  dijkstra,
  hexDist,
  hexKey,
  hexesInRange,
  neighbors,
  parseHexKey,
  reconstructPath,
  offsetToAxial,
  axialToOffset,
  type Hex,
} from "./hex";
import { allHexes, generateMap, makePlayers, startingStacks } from "./mapgen";
import { createRng, hashSeed, type Rng } from "./rng";
import { cloneState } from "./save";
import type {
  ApplyResult,
  BattleLogLine,
  BattleRoster,
  BattleState,
  BattleTechReady,
  Command,
  Commander,
  GameEvent,
  GameSetup,
  GameState,
  HexCell,
  Player,
  PlayerId,
  RelationKind,
  Stack,
  StackId,
  UnitSlot,
} from "./types";

function rngOf(state: GameState) {
  const rng = createRng(0);
  rng.setState(state.rngState);
  return rng;
}

function commitRng(state: GameState, rng: Rng) {
  state.rngState = rng.getState();
}

export function hexOf(state: GameState, q: number, r: number): HexCell | undefined {
  return state.hexes[hexKey(q, r)];
}

export function stacksAt(state: GameState, q: number, r: number): Stack[] {
  return state.stacks.filter((s) => s.q === q && s.r === r);
}

export function playerOf(state: GameState, id: PlayerId): Player | undefined {
  return state.players.find((p) => p.id === id);
}

export function villageOf(state: GameState, id: PlayerId) {
  return playerOf(state, id)?.village ?? null;
}

export function relationOf(state: GameState, a: PlayerId, b: PlayerId): RelationKind {
  if (a === b) return "alliance";
  const rel = state.relations.find(
    (r) => r.a === a && r.b === b || r.a === b && r.b === a
  );
  return rel?.kind ?? "peace";
}

export function atWar(state: GameState, a: PlayerId, b: PlayerId) {
  if (a < 0 || b < 0) return true;
  const k = relationOf(state, a, b);
  return k === "war" || k === "peace";
}

export function allied(state: GameState, a: PlayerId, b: PlayerId) {
  return relationOf(state, a, b) === "alliance";
}

export function hostile(state: GameState, a: PlayerId, b: PlayerId) {
  if (b < 0) return true;
  if (a === b) return false;
  const k = relationOf(state, a, b);
  return k === "war" || k === "peace";
}

function cmdDef(id: string) {
  return BALANCE.commanders.defs[id];
}

function commanderById(state: GameState, id: string) {
  for (const p of state.players) {
    const c = p.commanders.find((x) => x.id === id);
    if (c) return { player: p, commander: c };
  }
  return null;
}

function skillRank(state: GameState, playerId: PlayerId, branch: SkillBranch) {
  const p = playerOf(state, playerId);
  if (!p) return 0;
  return Math.max(0, ...p.commanders.map((c) => c.skills[branch]));
}

function unitCount(state: GameState, playerId: PlayerId) {
  let n = 0;
  for (const s of state.stacks) {
    if (s.playerId !== playerId || s.garrison) continue;
    for (const u of s.units) n += u.count;
  }
  return n;
}

export function unitCostMult(state: GameState, playerId: PlayerId) {
  const p = playerOf(state, playerId);
  if (!p) return 1;
  let m = BALANCE.villages[p.village].unitCostMult;
  const n = unitCount(state, playerId);
  const over = n - BALANCE.units.overCap;
  if (over > 0) m *= Math.pow(BALANCE.units.overCapCostMult, over);
  if (skillRank(state, playerId, "econ") >= 3) m *= 1 - BALANCE.skills.econUnitCost;
  return m;
}

export function hireCost(state: GameState, playerId: PlayerId, unit: UnitId): { ryo: number; supplies: number; chakra: number }



{
  const d = BALANCE.units.defs[unit];
  const p = playerOf(state, playerId);
  let ryo = d.costRyo * unitCostMult(state, playerId);
  if (unit === "anbu") ryo *= BALANCE.villages[p.village].eliteCostMult;
  return {
    ryo: Math.round(ryo),
    supplies: d.costSupplies,
    chakra: d.costChakra
  };
}

export function buildingCost(state: GameState, playerId: PlayerId, b: BuildingId): { ryo: number; supplies: number; chakra: number }


{
  const d = BALANCE.buildings[b];
  const p = playerOf(state, playerId);
  const m = BALANCE.villages[p.village].buildingCostMult;
  return { ryo: Math.round(d.costRyo * m), supplies: Math.round(d.costSupplies * m) };
}

export function stackMovePoints(state: GameState, stack: Stack) {
  if (stack.garrison) return 0;
  const p = playerOf(state, stack.playerId);
  if (!p) return BALANCE.units.baseMove;
  let mv = BALANCE.units.baseMove;
  if (stack.units.length) {
    mv = Math.min(...stack.units.map((u) => BALANCE.units.defs[u.type].move));
  }
  mv += BALANCE.villages[p.village].moveDelta;
  if (stack.units.some((u) => u.type === "cavalry")) mv += BALANCE.units.cavalryMoveBonus;
  if (skillRank(state, stack.playerId, "scout") >= 1) mv += 1;
  if (stack.commanderId) {
    const c = p.commanders.find((x) => x.id === stack.commanderId);
    if (c && cmdDef(c.defId)?.passive === "move") mv += 1;
  }
  return Math.max(1, mv);
}

function ignoresZoc(state: GameState, stack: Stack) {
  const p = playerOf(state, stack.playerId);
  if (!p) return false;
  if (BALANCE.villages[p.village].ignoreZoc) return true;
  if (skillRank(state, stack.playerId, "scout") >= 3) return true;
  if (stack.commanderId) {
    const c = p.commanders.find((x) => x.id === stack.commanderId);
    if (c && cmdDef(c.defId)?.passive === "zoc") return true;
  }
  return false;
}

function enemyZoc(state: GameState, playerId, h) {
  for (const n of neighbors(h)) {
    const ss = stacksAt(state, n.q, n.r);
    if (ss.some((s) => s.playerId !== playerId && s.playerId >= 0 && hostile(state, playerId, s.playerId))) {
      return true;
    }
  }
  return false;
}

export function moveCost(state: GameState, stack: Stack, from: Hex, to: Hex) {
  const cell = hexOf(state, to.q, to.r);
  if (!cell) return 99;
  let c = BALANCE.map.moveCost[cell.terrain];
  const p = playerOf(state, stack.playerId);
  if (cell.terrain === "desert" && p && !BALANCE.villages[p.village].desertMoveFree) {
    c += BALANCE.map.desertMovePenalty;
  }
  if (c >= 99) return 99;
  const occ = stacksAt(state, to.q, to.r).filter((s) => s.id !== stack.id);
  if (occ.some((s) => s.playerId !== stack.playerId && s.playerId >= 0 && allied(state, stack.playerId, s.playerId))) {
    return 99;
  }
  if (occ.some((s) => s.playerId !== stack.playerId && hostile(state, stack.playerId, s.playerId))) {
    return 99;
  }
  if (occ.some((s) => s.playerId === stack.playerId && s.garrison !== stack.garrison && s.garrison)) {

    /* can enter own garrison hex to merge after fight? allow */}
  if (!ignoresZoc(state, stack) && enemyZoc(state, stack.playerId, to) && !enemyZoc(state, stack.playerId, from)) {
    c = Math.max(c, stackMovePoints(state, stack));
  }
  return c;
}

export function reachable(state: GameState, stack: Stack): Map<string, number> {
  const mp = stack.moved ? 0 : stackMovePoints(state, stack);
  const { dist } = dijkstra(
    { q: stack.q, r: stack.r },
    mp,
    (from, to) => moveCost(state, stack, from, to),
    (h) => !!hexOf(state, h.q, h.r)
  );
  return dist;
}

export function pathTo(state: GameState, stack: Stack, dest: Hex): Hex[] {
  const mp = stack.moved ? 0 : stackMovePoints(state, stack);
  const { prev, dist } = dijkstra(
    { q: stack.q, r: stack.r },
    mp,
    (from, to) => moveCost(state, stack, from, to),
    (h) => !!hexOf(state, h.q, h.r)
  );
  if (!dist.has(hexKey(dest.q, dest.r))) return [];
  return reconstructPath(prev, dest);
}

export function hostilesAt(state: GameState, stack: Stack, dest: Hex) {
  return stacksAt(state, dest.q, dest.r).filter(
    (s) => s.id !== stack.id && s.playerId !== stack.playerId && hostile(state, stack.playerId, s.playerId)
  );
}

export function approachHex(state: GameState, stack: Stack, dest: Hex): Hex | null {
  if (!hexOf(state, dest.q, dest.r)) return null;
  if (hexDist(stack, dest) === 1) return { q: stack.q, r: stack.r };
  const reach = reachable(state, stack);
  let best = null;
  let bestCost = Infinity;
  for (const n of neighbors(dest)) {
    if (!hexOf(state, n.q, n.r)) continue;
    const c = reach.get(hexKey(n.q, n.r));
    if (c === undefined) continue;
    if (hostilesAt(state, stack, n).length) continue;
    if (c < bestCost) {
      bestCost = c;
      best = n;
    }
  }
  return best;
}

export function attackTargets(state: GameState, stack: Stack): Set<string> {
  const out = new Set();
  if (stack.moved || stack.garrison) return out;
  const reach = reachable(state, stack);
  for (const k of reach.keys()) {
    const h = parseHexKey(k);
    for (const n of neighbors(h)) {
      if (hostilesAt(state, stack, n).length) out.add(hexKey(n.q, n.r));
    }
  }
  return out;
}

function occupyHex(state: GameState, stack: Stack, dest: Hex) {
  if (hostilesAt(state, stack, dest).length) return false;
  stack.q = dest.q;
  stack.r = dest.r;
  mergeStacks(state, dest.q, dest.r, stack.playerId);
  return true;
}

function hasAcademy(state: GameState, playerId) {
  return state.settlements.some(
    (s) => s.owner === playerId && s.buildings.includes("academy")
  );
}

export function canHireUnit(state: GameState, playerId: PlayerId, unit: UnitId) {
  const d = BALANCE.units.defs[unit];
  const p = playerOf(state, playerId);
  if (!p) return false;
  if (d.needAcademy && !hasAcademy(state, playerId)) {
    if (unit === "cavalry" && BALANCE.villages[p.village].cavalryFromStart) return true;
    return false;
  }
  return true;
}

export function recomputeInfluence(state: GameState) {
  for (const cell of Object.values(state.hexes)) {
    cell.influence = {};
    cell.owner = null;
    cell.contested = false;
  }
  const add = (h, pid, amount) => {
    const cell = hexOf(state, h.q, h.r);
    if (!cell) return;
    const k = String(pid);
    cell.influence[k] = (cell.influence[k] ?? 0) + amount;
  };
  for (const s of state.settlements) {
    if (s.owner === null) continue;
    const isCap = s.capitalOf === s.owner || s.capitalOf !== null && s.owner === s.capitalOf;
    const range = isCap && s.capitalOf !== null ? BALANCE.influence.capitalRange : BALANCE.influence.settlementRange;
    const self = isCap && s.capitalOf !== null ? BALANCE.influence.capitalSelf : BALANCE.influence.settlementSelf;
    for (const h of hexesInRange({ q: s.q, r: s.r }, range)) {
      const d = hexDist({ q: s.q, r: s.r }, h);
      add(h, s.owner, Math.max(1, self - d));
    }
  }
  for (const cell of Object.values(state.hexes)) {
    const entries = Object.entries(cell.influence);
    if (!entries.length) continue;
    entries.sort((a, b) => b[1] - a[1]);
    if (entries.length > 1 && entries[0][1] === entries[1][1]) {
      cell.contested = true;
      cell.owner = null;
    } else {
      cell.owner = Number(entries[0][0]);
      cell.contested = false;
    }
  }
}

function incomeMult(state: GameState, p: Player, terrain: Terrain, capturedTurn: number, capturedFrom: PlayerId | null, ownerCounts: number[])
{
  const v = BALANCE.villages[p.village];
  let m = 1;
  m *= v.ryoIncomeMult;
  if (p.difficulty === "hard") m *= BALANCE.ai.hardIncome;
  if (v.slowStartTurns > 0 && state.turn <= v.slowStartTurns) m *= v.slowStartIncome;
  if (terrain === "desert") m *= v.desertIncomeMult;else
  if (terrain === "forest") m *= v.forestIncomeMult;else
  m *= v.otherIncomeMult;
  if (capturedFrom !== null && capturedFrom !== p.id) {
    if (state.turn - capturedTurn < BALANCE.income.capturedPenaltyTurns) m *= BALANCE.income.capturedPenaltyRate;
  }
  if (skillRank(state, p.id, "econ") >= 1) m *= 1 + BALANCE.skills.econRyo;
  const mine = ownerCounts[p.id] ?? 0;
  let best = 0;
  for (let i = 0; i < ownerCounts.length; i++) {
    if (state.players[i]?.alive) best = Math.max(best, ownerCounts[i] ?? 0);
  }
  if (best > 0 && mine < best * (1 - BALANCE.income.trailingShare)) {
    m *= 1 + BALANCE.income.trailingIncomeBonus;
  }
  return m;
}

function applyIncome(state: GameState, pid: PlayerId, events: GameEvent[]) {
  const p = playerOf(state, pid);
  if (!p || !p.alive) return;
  const v = BALANCE.villages[p.village];
  const ownerCounts = new Array(state.players.length).fill(0);
  for (const h of Object.values(state.hexes)) {
    if (h.owner !== null && h.owner >= 0) ownerCounts[h.owner] = (ownerCounts[h.owner] ?? 0) + 1;
  }
  const cap = state.settlements.find((s) => s.capitalOf === pid && s.owner === pid);
  let ryo = 0;
  let sup = 0;
  let chk = 0;
  if (cap) {
    const cell = hexOf(state, cap.q, cap.r);
    const m = incomeMult(state, p, cell?.terrain ?? "plains", cap.capturedTurn, cap.capturedFrom, ownerCounts);
    ryo += BALANCE.income.capitalRyo * v.capitalIncomeMult * m;
    sup += BALANCE.income.capitalSupplies * m;
    chk += BALANCE.income.capitalChakra;
  }
  for (const s of state.settlements) {
    if (s.owner !== pid || s.capitalOf === pid) continue;
    const cell = hexOf(state, s.q, s.r);
    const m = incomeMult(state, p, cell?.terrain ?? "plains", s.capturedTurn, s.capturedFrom, ownerCounts);
    ryo += BALANCE.income.settlementRyo * m;
    sup += BALANCE.income.settlementSupplies * m;
    if (s.buildings.includes("market")) ryo += BALANCE.income.settlementRyo * m * BALANCE.buildings.market.ryoBonus;
    if (s.buildings.includes("temple")) chk += BALANCE.buildings.temple.chakra;
  }
  if (cap?.buildings.includes("market")) ryo += BALANCE.income.capitalRyo * BALANCE.buildings.market.ryoBonus;
  if (cap?.buildings.includes("temple")) chk += BALANCE.buildings.temple.chakra;
  for (const r of state.resources) {
    if (r.owner !== pid) continue;
    const cell = hexOf(state, r.q, r.r);
    const m = incomeMult(state, p, cell?.terrain ?? "plains", r.capturedTurn, r.capturedFrom, ownerCounts);
    const y = BALANCE.income.resourceYield * m;
    if (r.kind === "ryo") ryo += y;else
    if (r.kind === "supplies") sup += y;else
    chk += Math.max(1, Math.round(y / 20));
  }
  if (skillRank(state, pid, "econ") >= 2) sup *= 1 + BALANCE.skills.econSupplies;
  if (skillRank(state, pid, "econ") >= 4) chk += BALANCE.skills.econChakra;

  const tradePartners = state.relations.filter(
    (rel) => (rel.a === pid || rel.b === pid) && (rel.kind === "trade" || rel.kind === "alliance")
  ).length;
  ryo *= 1 + tradePartners * BALANCE.diplomacy.tradeIncome;

  const units = unitCount(state, pid);
  const upkeep = Math.floor(units / BALANCE.income.upkeepPerUnits) * BALANCE.income.upkeepSupplies;
  sup -= upkeep;

  const inc = { ryo: Math.round(ryo), supplies: Math.round(sup), chakra: Math.round(chk) };
  p.ryo += inc.ryo;
  p.supplies += inc.supplies;
  p.chakra += inc.chakra;
  p.lastIncome = inc;

  if (p.supplies < 0) {
    p.supplies = 0;
    let frac = BALANCE.income.desertionFrac;
    if (skillRank(state, pid, "econ") >= 5) frac *= 0.5;
    for (const s of state.stacks) {
      if (s.playerId !== pid || s.garrison) continue;
      for (const u of s.units) {
        const lose = Math.max(1, Math.round(u.count * frac));
        const hpEach = BALANCE.units.defs[u.type].hp;
        u.count = Math.max(0, u.count - lose);
        u.hpTotal = u.count * hpEach;
      }
      s.units = s.units.filter((u) => u.count > 0);
    }
    state.stacks = state.stacks.filter((s) => s.units.length || s.commanderId);
    events.push({ kind: "log", text: `${p.name}: дезертирство — нет припасов` });
  }
  events.push({
    kind: "log",
    text: `${p.name}: +${Math.round(ryo)} рё, ${Math.round(sup) >= 0 ? "+" : ""}${Math.round(sup)} припасов, +${Math.round(chk)} чакры`
  });
}

function hospitalHeal(state: GameState, pid: PlayerId) {
  const has = state.settlements.some((s) => s.owner === pid && s.buildings.includes("hospital"));
  if (!has) return;
  const frac = BALANCE.buildings.hospital.heal;
  for (const s of state.stacks) {
    if (s.playerId !== pid) continue;
    for (const u of s.units) {
      const max = BALANCE.units.defs[u.type].hp * u.count;
      u.hpTotal = Math.min(max, u.hpTotal + Math.round(max * frac));
    }
  }
}

function grantXp(state: GameState, pid: PlayerId, amount: number, events: GameEvent[]) {
  const p = playerOf(state, pid);
  if (!p) return;
  const xp = Math.round(amount * BALANCE.villages[p.village].commanderXp);
  for (const c of p.commanders) {
    if (!c.alive) continue;
    c.xp += xp;
    while (c.level < BALANCE.commanders.maxLevel && c.xp >= BALANCE.commanders.xpLevels[c.level]) {
      c.level += 1;
      events.push({ kind: "log", text: `${p.name}: ${cmdDef(c.defId)?.name ?? "командир"} — ур. ${c.level}` });
    }
  }
}

export function skillPointsAvailable(c: Commander): number {
  const spent = (c.skills.war ?? 0) + (c.skills.econ ?? 0) + (c.skills.scout ?? 0);
  return Math.max(0, c.level - 1 - spent);
}

function mergeStacks(state: GameState, q, r, playerId) {
  const here = state.stacks.filter((s) => s.q === q && s.r === r && s.playerId === playerId && !s.garrison);
  if (here.length <= 1) return;
  const keep = here.find((s) => s.commanderId) ?? here[0];
  for (const s of here) {
    if (s.id === keep.id) continue;
    for (const u of s.units) {
      const ex = keep.units.find((x) => x.type === u.type);
      if (ex) {
        ex.count += u.count;
        ex.hpTotal += u.hpTotal;
      } else keep.units.push(u);
    }
    if (s.commanderId && !keep.commanderId) keep.commanderId = s.commanderId;
    state.stacks = state.stacks.filter((x) => x.id !== s.id);
  }
}

function humanSide(state: GameState, pid: PlayerId) {
  if (pid < 0) return false;
  return playerOf(state, pid)?.difficulty === "human";
}

function rosterOf(s: Stack) {
  return s.units.map((u) => ({ type: u.type, count: u.count, hpTotal: u.hpTotal }));
}

function writeRoster(stack: Stack, roster: BattleRoster[]) {
  stack.units = roster.map((u) => ({ ...u })).filter((u) => u.hpTotal > 0);
}

function makeFightCtx(state: GameState, attacker: Stack, defender: Stack, ambush = false, extra?: Partial<FightContext>)





{
  const aP = playerOf(state, attacker.playerId);
  const dP = defender.playerId >= 0 ? playerOf(state, defender.playerId) ?? null : null;
  const cell = hexOf(state, defender.q, defender.r);
  const aCmd = attacker.commanderId ? aP.commanders.find((c) => c.id === attacker.commanderId) ?? null : null;
  const dCmd =
  defender.commanderId && dP ? dP.commanders.find((c) => c.id === defender.commanderId) ?? null : null;
  return {
    terrain: cell?.terrain ?? "plains",
    attackerVillage: aP.village,
    defenderVillage: dP?.village ?? null,
    attackerCommander: aCmd,
    defenderCommander: dCmd,
    attackerIsGarrison: attacker.garrison,
    defenderIsGarrison: defender.garrison,
    attackerPlayer: aP,
    defenderPlayer: dP,
    defenderWall: state.settlements.some(
      (s) => s.q === defender.q && s.r === defender.r && s.buildings.includes("wall")
    ),
    ambush,
    attackerTactic: extra?.attackerTactic,
    defenderTactic: extra?.defenderTactic,
    attackerTech: extra?.attackerTech,
    defenderTech: extra?.defenderTech
  };
}

function techReadyOf(state: GameState, stack: Stack) {
  if (!stack.commanderId) return null;
  const found = commanderById(state, stack.commanderId);
  if (!found || !found.commander.alive || found.commander.cooldown > 0) return null;
  const def = cmdDef(found.commander.defId);
  if (!def) return null;
  const tech = def.tech;
  const cost = BALANCE.commanders.techChakra[tech];
  if (found.player.chakra < cost) return null;
  return {
    commanderId: found.commander.id,
    tech,
    name: TECH_LABELS[tech],
    cost,
    maxRound: BALANCE.combat.maxRounds
  };
}

function battleTechSpec(
state,
stack,
round)
{
  if (!round || !stack.commanderId) return null;
  const found = commanderById(state, stack.commanderId);
  if (!found) return null;
  const def = cmdDef(found.commander.defId);
  if (!def) return null;
  return { tech: def.tech, level: Math.max(1, found.commander.level), round };
}

function spendArenaTech(state: GameState, stack: Stack, round: number, events: GameEvent[]) {
  if (!round) return;
  const ready = techReadyOf(state, stack);
  if (!ready || !stack.commanderId) return;
  const found = commanderById(state, stack.commanderId);
  if (!found || found.player.chakra < ready.cost) return;
  found.player.chakra -= ready.cost;
  found.commander.cooldown = BALANCE.commanders.techCd[ready.tech];
  events.push({
    kind: "log",
    text: `${cmdDef(found.commander.defId)?.name ?? "Командир"} готовит ${ready.name} к раунду ${round}`
  });
}

export function attackForecast(state: GameState, stack: Stack, q: number, r: number, sims?: number) {
  const foes = stacksAt(state, q, r).filter(
    (s) => s.id !== stack.id && s.playerId !== stack.playerId && hostile(state, stack.playerId, s.playerId)
  );
  if (!foes.length) return null;
  const defender = foes[0];
  const seen = visionSet(state, stack.playerId).has(hexKey(q, r));
  const ambush = BALANCE.vision.fog && !seen;
  const ctx = makeFightCtx(state, stack, defender, ambush);
  return forecastFight(rngOf(state), stack, defender, ctx, sims);
}

function ctxFromBattle(state: GameState, attacker: Stack, defender: Stack) {
  const b = state.battle;
  return makeFightCtx(state, attacker, defender, !!b.ambush, {
    attackerTactic: b.attackerTactic,
    defenderTactic: b.defenderTactic,
    attackerTech: battleTechSpec(state, attacker, b.attackerTechRound),
    defenderTech: battleTechSpec(state, defender, b.defenderTechRound)
  });
}

function botTacticFor(state: GameState, attacker, defender, side) {
  const aP = playerOf(state, attacker.playerId);
  const dP = defender.playerId >= 0 ? playerOf(state, defender.playerId) : null;
  return pickTactic(stackPower(attacker, aP?.village ?? "leaf"), stackPower(defender, dP?.village ?? null), side);
}

function botTechRound(tactic, ready) {
  if (ready.tech === "heal") return tactic === "defend" ? 1 : 2;
  return 1;
}

function fillBotChoices(state: GameState, events: GameEvent[]) {
  const b = state.battle;
  if (!b) return;
  const atk = state.stacks.find((s) => s.id === b.attackerStackId);
  const def = state.stacks.find((s) => s.id === b.defenderStackId);
  if (!atk || !def) return;
  if (!b.attackerTactic && !humanSide(state, atk.playerId)) {
    b.attackerTactic = botTacticFor(state, atk, def, "a");
    const ready = techReadyOf(state, atk);
    if (ready) {
      b.attackerTechRound = botTechRound(b.attackerTactic, ready);
      spendArenaTech(state, atk, b.attackerTechRound, events);
    }
  }
  if (!b.defenderTactic && !humanSide(state, def.playerId)) {
    b.defenderTactic = botTacticFor(state, atk, def, "d");
    const ready = techReadyOf(state, def);
    if (ready) {
      b.defenderTechRound = botTechRound(b.defenderTactic, ready);
      spendArenaTech(state, def, b.defenderTechRound, events);
    }
  }
}

function tacticLabel(id, hidden) {
  if (!id) return "…";
  if (hidden) return "скрыто";
  return BALANCE.combat.tactics[id].name;
}

function pushTacticLine(state: GameState, events: GameEvent[]) {
  const b = state.battle;
  if (!b) return;
  const hideD = humanSide(state, b.attackerId ?? -1) && skillRank(state, b.attackerId ?? -1, "scout") < BALANCE.combat.scoutRevealRank;
  const hideA = humanSide(state, b.defenderId ?? -1) && skillRank(state, b.defenderId ?? -1, "scout") < BALANCE.combat.scoutRevealRank;
  const text = `${tacticLabel(b.attackerTactic, hideA)} против ${tacticLabel(b.defenderTactic, hideD)}`;
  b.log = [{ round: 0, kind: "tactic", text }, ...(b.log ?? []).filter((l) => l.kind !== "tactic")];
  events.push({ kind: "log", text: `Тактика: ${text}` });
}

function finishBattle(state: GameState, rng: Rng, events: GameEvent[], winner: "attacker" | "defender" | "draw" | "retreat")
{
  const b = state.battle;
  if (!b) return winner;
  const attacker = state.stacks.find((s) => s.id === b.attackerStackId);
  const defender = state.stacks.find((s) => s.id === b.defenderStackId);
  if (!attacker) {
    b.done = true;
    b.battlePhase = "done";
    b.result = winner === "retreat" ? "retreat" : "defender";
    return "defender";
  }
  const aP = playerOf(state, attacker.playerId);
  const dP = defender && defender.playerId >= 0 ? playerOf(state, defender.playerId) ?? null : null;
  const dest = { q: b.hexQ, r: b.hexR };
  const from = { q: b.fromQ ?? attacker.q, r: b.fromR ?? attacker.r };

  b.result = winner;
  b.done = true;
  b.battlePhase = "done";
  b.endA = rosterOf(attacker);
  b.endD = defender ? rosterOf(defender) : [];
  b.round = Math.max(b.round, 1);
  b.winner =
  winner === "attacker" ? attacker.playerId : winner === "defender" && defender ? defender.playerId : null;
  state.combatStats ??= { fights: 0, retreats: 0, wipes: 0 };
  state.combatStats.fights += 1;
  if (winner === "retreat") state.combatStats.retreats += 1;else
  {
    const aLeft = attacker.units.reduce((n, u) => n + u.count, 0);
    const dLeft = defender ? defender.units.reduce((n, u) => n + u.count, 0) : 0;
    const a0 = (b.startA ?? []).reduce((n, u) => n + u.count, 0);
    const d0 = (b.startD ?? []).reduce((n, u) => n + u.count, 0);
    if (aLeft === 0 && d0 > 0 && (d0 - dLeft) / d0 < 0.2 || dLeft === 0 && a0 > 0 && (a0 - aLeft) / a0 < 0.2) {
      state.combatStats.wipes += 1;
    }
  }

  const dmgColor = BALANCE.colors.villages[aP.village].glow;
  events.push({ kind: "flash", q: dest.q, r: dest.r, color: dmgColor });
  events.push({
    kind: "damage",
    q: dest.q,
    r: dest.r,
    text:
    winner === "attacker" ?
    "победа" :
    winner === "defender" ?
    "отбой" :
    winner === "retreat" ?
    "отход" :
    "ничья",
    color: dmgColor
  });

  if (winner === "retreat") {
    applyRetreatLoss(attacker, b.attackerTactic);
    attacker.units = attacker.units.filter((u) => u.hpTotal > 0);
    attacker.q = from.q;
    attacker.r = from.r;
    attacker.moved = true;
    b.endA = rosterOf(attacker);
    b.log = [
    ...(b.log ?? []),
    {
      round: b.round,
      kind: "retreat",
      side: "a",
      text:
      b.attackerTactic === "defend" ?
      "Отступление: оборона сохраняет состав" :
      `Отступление: −${Math.round(BALANCE.combat.retreatLoss * 100)}% состава`
    }];

    events.push({ kind: "log", text: `${aP.name} отступает с поля` });
    grantXp(state, attacker.playerId, BALANCE.commanders.xpBattleLoss, events);
    return "retreat";
  }

  if (winner === "attacker") {
    grantXp(state, attacker.playerId, BALANCE.commanders.xpBattleWin + BALANCE.commanders.xpKill, events);
    if (defender && defender.playerId >= 0) grantXp(state, defender.playerId, BALANCE.commanders.xpBattleLoss, events);
    if (defender?.commanderId && dP) {
      const c = dP.commanders.find((x) => x.id === defender.commanderId);
      if (c) {
        const cap = state.settlements.find((s) => s.capitalOf === dP.id && s.owner === dP.id);
        if (cap) {
          defender.commanderId = null;
          const retreat = state.stacks.find(
            (s) => s.playerId === dP.id && s.q === cap.q && s.r === cap.r && !s.garrison
          );
          if (retreat) retreat.commanderId = c.id;else
          {
            state.stacks.push({
              id: `s${state.nextStackId++}`,
              playerId: dP.id,
              q: cap.q,
              r: cap.r,
              units: [],
              commanderId: c.id,
              moved: true,
              garrison: false
            });
          }
          events.push({ kind: "log", text: `${cmdDef(c.defId)?.name} отступает в столицу` });
        } else {
          c.alive = false;
          events.push({ kind: "log", text: `${cmdDef(c.defId)?.name} пал` });
        }
      }
    }
    if (defender) state.stacks = state.stacks.filter((s) => s.id !== defender.id);
  } else if (winner === "defender") {
    if (defender && defender.playerId >= 0) grantXp(state, defender.playerId, BALANCE.commanders.xpBattleWin, events);
    grantXp(state, attacker.playerId, BALANCE.commanders.xpBattleLoss, events);
    if (attacker.commanderId) {
      const c = aP.commanders.find((x) => x.id === attacker.commanderId);
      const cap = state.settlements.find((s) => s.capitalOf === aP.id && s.owner === aP.id);
      if (c && cap) {
        attacker.commanderId = null;
        const retreat = state.stacks.find(
          (s) => s.playerId === aP.id && s.q === cap.q && s.r === cap.r && !s.garrison
        );
        if (retreat) retreat.commanderId = c.id;else
        {
          state.stacks.push({
            id: `s${state.nextStackId++}`,
            playerId: aP.id,
            q: cap.q,
            r: cap.r,
            units: [],
            commanderId: c.id,
            moved: true,
            garrison: false
          });
        }
      } else if (c) c.alive = false;
    }
    state.stacks = state.stacks.filter((s) => s.id !== attacker.id);
  } else {
    attacker.q = from.q;
    attacker.r = from.r;
  }
  if (attacker) attacker.units = attacker.units.filter((u) => u.hpTotal > 0);
  if (defender) defender.units = defender.units.filter((u) => u.hpTotal > 0);
  return winner;
}

function occupyIfWon(state: GameState, rng: Rng, events: GameEvent[]) {
  const b = state.battle;
  if (!b || !b.done || b.result !== "attacker") return;
  const attacker = state.stacks.find((s) => s.id === b.attackerStackId);
  if (!attacker || !attacker.units.length) return;
  const dest = { q: b.hexQ, r: b.hexR };
  let guard = 0;
  while (guard++ < 8) {
    const leftover = hostilesAt(state, attacker, dest);
    if (leftover[0]) {
      const seen = visionSet(state, attacker.playerId).has(hexKey(dest.q, dest.r));
      const result = fightAt(state, rng, attacker, leftover[0], events, BALANCE.vision.fog && !seen);
      if (result === "pending" || result === "retreat") return;
      if (result !== "attacker") return;
      if (!state.stacks.some((s) => s.id === attacker.id) || !attacker.units.length) return;
      continue;
    }
    if (attacker.q === dest.q && attacker.r === dest.r) return;
    const from = { q: attacker.q, r: attacker.r };
    if (occupyHex(state, attacker, dest)) {
      events.push({ kind: "move", stackId: attacker.id, from, to: dest });
      completeMission(state, attacker, events);
    }
    return;
  }
}

function runRound1(state: GameState, rng: Rng, events: GameEvent[]) {
  const b = state.battle;
  if (!b) return "draw";
  const attacker = state.stacks.find((s) => s.id === b.attackerStackId);
  const defender = state.stacks.find((s) => s.id === b.defenderStackId);
  if (!attacker || !defender) return finishBattle(state, rng, events, !attacker ? "defender" : "attacker");
  pushTacticLine(state, events);
  const ctx = ctxFromBattle(state, attacker, defender);
  const res = fight(rng, attacker, defender, ctx, { maxRounds: 1 });
  b.log = [...(b.log ?? []).filter((l) => l.kind === "tactic"), ...res.log];
  b.liveA = rosterOf(res.attacker);
  b.liveD = rosterOf(res.defender);
  b.round = 1;
  writeRoster(attacker, b.liveA);
  writeRoster(defender, b.liveD);
  b.mods = describeFightMods(ctx, attacker, defender);
  events.push({ kind: "battle", battle: b });

  if (!attacker.units.length || !defender.units.length) {
    const w = attacker.units.length ? "attacker" : defender.units.length ? "defender" : "draw";
    return finishBattle(state, rng, events, w);
  }

  b.battlePhase = "retreat";
  b.done = false;
  if (!humanSide(state, attacker.playerId)) {
    const chance = remainingWinChance(rng, attacker, defender, ctxFromBattle(state, attacker, defender));
    if (chance < BALANCE.combat.retreatWinChance) {
      return finishBattle(state, rng, events, "retreat");
    }
    return runRest(state, rng, events);
  }
  b.waitingFor = "attacker";
  return "pending";
}

function runRest(state: GameState, rng: Rng, events: GameEvent[]) {
  const b = state.battle;
  if (!b) return "draw";
  const attacker = state.stacks.find((s) => s.id === b.attackerStackId);
  const defender = state.stacks.find((s) => s.id === b.defenderStackId);
  if (!attacker || !defender) return finishBattle(state, rng, events, !attacker ? "defender" : "attacker");
  const ctx = ctxFromBattle(state, attacker, defender);
  const res = fight(rng, attacker, defender, ctx, { startRound: 2, firstA: false, firstD: false });
  b.log = [...(b.log ?? []), ...res.log];
  writeRoster(attacker, rosterOf(res.attacker));
  writeRoster(defender, rosterOf(res.defender));
  b.liveA = rosterOf(attacker);
  b.liveD = rosterOf(defender);
  b.round = Math.max(b.round, 1 + res.rounds);
  b.battlePhase = "playing";
  events.push({ kind: "battle", battle: b });
  return finishBattle(state, rng, events, res.winner);
}

function applyBattleChoose(state: GameState, rng: Rng, events: GameEvent[], tactic: TacticId, techRound: number | null | undefined)
{
  const b = state.battle;
  if (!b || b.done) return b?.result === "retreat" ? "retreat" : b?.result ?? "draw";
  const attacker = state.stacks.find((s) => s.id === b.attackerStackId);
  const defender = state.stacks.find((s) => s.id === b.defenderStackId);
  if (!attacker || !defender) return finishBattle(state, rng, events, "draw");
  const wait = b.waitingFor ?? "attacker";
  if (wait === "attacker") {
    b.attackerTactic = tactic;
    if (techRound) {
      b.attackerTechRound = techRound;
      spendArenaTech(state, attacker, techRound, events);
    }
  } else {
    b.defenderTactic = tactic;
    if (techRound) {
      b.defenderTechRound = techRound;
      spendArenaTech(state, defender, techRound, events);
    }
  }
  fillBotChoices(state, events);
  if (!b.attackerTactic) {
    b.waitingFor = "attacker";
    b.battlePhase = "tactics";
    b.techReady = techReadyOf(state, attacker);
    return "pending";
  }
  if (!b.defenderTactic) {
    b.waitingFor = "defender";
    b.battlePhase = "tactics";
    b.techReady = techReadyOf(state, defender);
    return "pending";
  }
  b.waitingFor = null;
  b.knownEnemyTactic =
  skillRank(state, attacker.playerId, "scout") >= BALANCE.combat.scoutRevealRank ||
  skillRank(state, defender.playerId, "scout") >= BALANCE.combat.scoutRevealRank;
  return runRound1(state, rng, events);
}

function fightAt(state: GameState, rng: Rng, attacker: Stack, defender: Stack, events: GameEvent[], ambush = false)
{
  const aP = playerOf(state, attacker.playerId);
  const dP = defender.playerId >= 0 ? playerOf(state, defender.playerId) ?? null : null;
  const ctx = makeFightCtx(state, attacker, defender, ambush);
  const aCmd = ctx.attackerCommander;
  const dCmd = ctx.defenderCommander;
  if (ambush) {
    events.push({ kind: "log", text: "Засада в тумане!" });
    events.push({ kind: "flash", q: defender.q, r: defender.r, color: "#9ab0d0" });
  }
  const aCmdName = aCmd ? cmdDef(aCmd.defId)?.name ?? "Командир" : null;
  const dCmdName = dCmd ? cmdDef(dCmd.defId)?.name ?? "Командир" : null;
  const defenderName = dP ? dP.name : defender.garrison ? "Гарнизон" : "Нукенин";
  const humanAtk = humanSide(state, attacker.playerId);
  const humanDef = humanSide(state, defender.playerId);
  const battle = {
    attackerStackId: attacker.id,
    defenderStackId: defender.id,
    hexQ: defender.q,
    hexR: defender.r,
    fromQ: attacker.q,
    fromR: attacker.r,
    log: [],
    round: 0,
    done: false,
    winner: null,
    skipped: false,
    ambush,
    terrain: ctx.terrain,
    attackerName: aP.name,
    defenderName,
    attackerId: attacker.playerId,
    defenderId: defender.playerId,
    attackerVillage: aP.village,
    defenderVillage: dP?.village ?? null,
    attackerCmd: aCmdName,
    defenderCmd: dCmdName,
    startA: rosterOf(attacker),
    startD: rosterOf(defender),
    liveA: rosterOf(attacker),
    liveD: rosterOf(defender),
    mods: describeFightMods(ctx, attacker, defender),
    battlePhase: "tactics",
    waitingFor: humanAtk ? "attacker" : humanDef ? "defender" : null,
    attackerTactic: undefined,
    defenderTactic: undefined,
    knownEnemyTactic:
    skillRank(state, attacker.playerId, "scout") >= BALANCE.combat.scoutRevealRank ||
    skillRank(state, defender.playerId, "scout") >= BALANCE.combat.scoutRevealRank,
    attackerTechRound: null,
    defenderTechRound: null,
    techReady: techReadyOf(state, humanAtk ? attacker : humanDef ? defender : attacker)
  };
  state.battle = battle;
  events.push({ kind: "battle", battle });
  fillBotChoices(state, events);
  if (humanAtk && !battle.attackerTactic) {
    battle.waitingFor = "attacker";
    battle.techReady = techReadyOf(state, attacker);
    return "pending";
  }
  if (humanDef && !battle.defenderTactic) {
    battle.waitingFor = "defender";
    battle.techReady = techReadyOf(state, defender);
    return "pending";
  }
  return runRound1(state, rng, events);
}

function executeAttack(state: GameState, rng: Rng, stack: Stack, dest: Hex, events: GameEvent[])
{
  const foes = hostilesAt(state, stack, dest);
  if (!foes.length) return "Нет цели";
  const approach = approachHex(state, stack, dest);
  if (!approach) return "Слишком далеко";
  const start = { q: stack.q, r: stack.r };
  if (approach.q !== stack.q || approach.r !== stack.r) {
    const path = pathTo(state, stack, approach);
    if (!occupyHex(state, stack, approach)) return "Нельзя подойти";
    events.push({
      kind: "move",
      stackId: stack.id,
      from: start,
      to: approach,
      path: path.length >= 2 ? path : [start, approach],
    });
  }
  stack.moved = true;
  const seen = visionSet(state, stack.playerId).has(hexKey(dest.q, dest.r));
  const ambush = BALANCE.vision.fog && !seen;
  const result = fightAt(state, rng, stack, foes[0], events, ambush);
  if (result === "attacker") occupyIfWon(state, rng, events);
  return null;
}

function tickCapture(state: GameState, events: GameEvent[]) {
  for (const s of state.settlements) {
    const here = stacksAt(state, s.q, s.r).filter((x) => !x.garrison);
    const occ = here.find((x) => x.playerId >= 0);
    const foes = here.filter((x) => occ && x.playerId !== occ.playerId);
    if (!occ || foes.length || stacksAt(state, s.q, s.r).some((x) => x.garrison && x.playerId !== occ.playerId)) {
      const cell = hexOf(state, s.q, s.r);
      if (cell) cell.capture = null;
      continue;
    }
    if (s.owner === occ.playerId) continue;
    const p = playerOf(state, occ.playerId);
    const instant =
    skillRank(state, occ.playerId, "scout") >= 5 ||
    p.commanders.some((c) => c.alive && cmdDef(c.defId)?.passive === "capture");
    const cell = hexOf(state, s.q, s.r);
    if (instant) {
      captureSettlement(state, s, occ.playerId, events);
    } else {
      if (!cell?.capture || cell.capture.playerId !== occ.playerId) {
        if (cell) cell.capture = { playerId: occ.playerId, turns: 0 };
        events.push({ kind: "pulse", q: s.q, r: s.r });
      } else {
        cell.capture.turns += 1;
        if (cell.capture.turns >= BALANCE.influence.captureTurns) {
          captureSettlement(state, s, occ.playerId, events);
        }
      }
    }
  }
  for (const r of state.resources) {
    const here = stacksAt(state, r.q, r.r).filter((x) => !x.garrison && x.playerId >= 0);
    const occ = here[0];
    if (!occ) continue;
    if (stacksAt(state, r.q, r.r).some((x) => x.garrison && x.playerId !== occ.playerId)) continue;
    if (r.owner === occ.playerId) continue;
    r.capturedFrom = r.owner;
    r.capturedTurn = state.turn;
    r.owner = occ.playerId;
    events.push({ kind: "log", text: `${playerOf(state, occ.playerId)?.name} занимает ресурс` });
    events.push({ kind: "pulse", q: r.q, r: r.r });
  }
}

function captureSettlement(state: GameState, s: { q: number; r: number; owner: PlayerId | null; capitalOf: PlayerId | null; capturedFrom: PlayerId | null; capturedTurn: number; id: string }, pid: PlayerId, events: GameEvent[])
{
  const prev = s.owner;
  s.capturedFrom = prev;
  s.capturedTurn = state.turn;
  s.owner = pid;
  const cell = hexOf(state, s.q, s.r);
  if (cell) cell.capture = null;
  const p = playerOf(state, pid);
  events.push({ kind: "log", text: `${p.name} захватывает ${s.capitalOf !== null ? "столицу" : "поселение"}` });
  grantXp(state, pid, s.capitalOf !== null ? BALANCE.commanders.xpCapital : BALANCE.commanders.xpCapture, events);
  if (s.capitalOf !== null && s.capitalOf !== pid) {
    eliminate(state, s.capitalOf, pid, events);
  }
  recomputeInfluence(state);
}

function eliminate(state: GameState, pid, by, events) {
  const p = playerOf(state, pid);
  if (!p || !p.alive) return;
  p.alive = false;
  events.push({ kind: "log", text: `${p.name} пал. Столица захвачена.` });
  for (const s of state.settlements) {
    if (s.owner === pid) {
      s.owner = by;
      s.capturedFrom = pid;
      s.capturedTurn = state.turn;
    }
  }
  for (const r of state.resources) {
    if (r.owner === pid) {
      r.owner = by;
      r.capturedFrom = pid;
      r.capturedTurn = state.turn;
    }
  }
  state.stacks = state.stacks.filter((s) => s.playerId !== pid);
  p.commanders.forEach((c) => {
    c.alive = false;
  });
}

function checkVictory(state: GameState, events: GameEvent[]) {
  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    const w = alive[0];
    const allies = w ?
    state.players.filter((p) => p.id === w.id || (p.alive === false ? false : allied(state, p.id, w.id) && p.alive)) :
    [];
    const winners = w ? [w.id, ...state.players.filter((p) => p.alive && allied(state, p.id, w.id) && p.id !== w.id).map((p) => p.id)] : [];
    state.winner = winners.length ? winners : w ? [w.id] : [];
    state.winReason = "Все столицы пали";
    state.phase = "gameover";
    events.push({ kind: "win" });
    void allies;
    return;
  }
  const total = Object.keys(state.hexes).length;
  for (const p of alive) {
    const n = Object.values(state.hexes).filter((h) => h.owner === p.id).length;
    const share = n / Math.max(1, total);
    const key = String(p.id);
    if (share >= BALANCE.victory.territoryShare) {
      state.territoryHold[key] = (state.territoryHold[key] ?? 0) + 1;
    } else {
      state.territoryHold[key] = 0;
    }
    if ((state.territoryHold[key] ?? 0) >= BALANCE.victory.territoryHoldTurns) {
      const winners = [p.id, ...alive.filter((x) => x.id !== p.id && allied(state, x.id, p.id)).map((x) => x.id)];
      state.winner = winners;
      state.winReason = `${Math.round(share * 100)}% территории удержано`;
      state.phase = "gameover";
      events.push({ kind: "win" });
      return;
    }
  }
  if (state.turn >= state.turnLimit) {
    const scored = alive.
    map((p) => ({
      id: p.id,
      score:
      Object.values(state.hexes).filter((h) => h.owner === p.id).length * 2 +
      state.settlements.filter((s) => s.owner === p.id).length * 15 +
      p.ryo / 10 +
      stackPower(
        {
          id: "x",
          playerId: p.id,
          q: 0,
          r: 0,
          units: state.stacks.filter((s) => s.playerId === p.id).flatMap((s) => s.units),
          commanderId: null,
          moved: false,
          garrison: false
        },
        p.village
      ) + (
      state.settlements.some((s) => s.capitalOf === p.id && s.owner === p.id) ? 100 : 0)
    })).
    sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top) {
      const p = playerOf(state, top.id);
      const winners = [p.id, ...alive.filter((x) => x.id !== p.id && allied(state, x.id, p.id)).map((x) => x.id)];
      state.winner = winners;
      state.winReason = `Лимит ходов. Счёт ${Math.round(top.score)}`;
      state.phase = "gameover";
      events.push({ kind: "win" });
    }
  }
}

function resetTurnFlags(state: GameState, pid: PlayerId) {
  for (const s of state.stacks) {
    if (s.playerId === pid) s.moved = false;
  }
  for (const s of state.settlements) {
    if (s.owner === pid) s.builtThisTurn = false;
  }
  const p = playerOf(state, pid);
  if (p) p.hiredThisTurn = 0;
  for (const c of p?.commanders ?? []) {
    if (c.cooldown > 0) c.cooldown -= 1;
  }
}

export function visionSet(state: GameState, pid: PlayerId): Set<string> {
  const vis = new Set();
  const p = playerOf(state, pid);
  if (!p) return vis;
  let bonus = skillRank(state, pid, "scout") >= 2 ? 1 : 0;
  const fog = Math.max(
    0,
    ...state.players.
    filter((x) => x.alive && x.id !== pid && hostile(state, pid, x.id)).
    map((x) => BALANCE.villages[x.village].visionPenaltyToEnemies)
  );
  const add = (h, range) => {
    const r = Math.max(1, range + bonus - fog);
    for (const x of hexesInRange(h, r)) {
      if (state.hexes[hexKey(x.q, x.r)]) vis.add(hexKey(x.q, x.r));
    }
  };
  for (const s of state.stacks) {
    if (s.playerId !== pid && !allied(state, pid, s.playerId)) continue;
    let range = s.commanderId ? BALANCE.units.commanderVision : BALANCE.units.vision;
    if (s.commanderId) {
      const found = commanderById(state, s.commanderId);
      if (found && cmdDef(found.commander.defId)?.passive === "vision") range += 1;
    }
    add({ q: s.q, r: s.r }, range);
  }
  for (const s of state.settlements) {
    if (s.owner !== pid && !(s.owner !== null && allied(state, pid, s.owner))) continue;
    add({ q: s.q, r: s.r }, s.capitalOf !== null ? BALANCE.units.capitalVision : BALANCE.units.settlementVision);
  }
  for (const r of state.resources) {
    if (r.owner !== pid && !(r.owner !== null && allied(state, pid, r.owner))) continue;
    add({ q: r.q, r: r.r }, BALANCE.units.resourceVision);
  }
  return vis;
}

export function viewingPlayer(state: GameState): PlayerId {
  const cur = playerOf(state, state.currentPlayer);
  if (cur?.difficulty === "human") return cur.id;
  const human = state.players.find((p) => p.alive && p.difficulty === "human");
  return human?.id ?? state.currentPlayer;
}

export function exploredSet(state: GameState, pid: PlayerId): Set<string> {
  return new Set(state.explored?.[String(pid)] ?? []);
}

export function isVisible(state: GameState, pid: PlayerId, q: number, r: number) {
  return visionSet(state, pid).has(hexKey(q, r));
}

export function isExplored(state: GameState, pid: PlayerId, q: number, r: number) {
  return exploredSet(state, pid).has(hexKey(q, r));
}

export function revealFor(state: GameState, pid: PlayerId) {
  if (!state.explored) state.explored = {};
  const key = String(pid);
  const vis = visionSet(state, pid);
  const prev = state.explored[key];
  if (!prev) {
    state.explored[key] = [...vis];
    return;
  }
  const have = new Set(prev);
  for (const k of vis) {
    if (!have.has(k)) prev.push(k);
  }
}

export function hydrateVision(state: GameState) {
  if (!state.explored) state.explored = {};
  for (const p of state.players) {
    if (p.alive && p.difficulty === "human") revealFor(state, p.id);
  }
}

const MISSION_KINDS = ["scroll", "shrine", "cache", "bounty"];

function hexBusy(state: GameState, q, r) {
  if (state.settlements.some((s) => s.q === q && s.r === r)) return true;
  if (state.resources.some((s) => s.q === q && s.r === r)) return true;
  if (state.missions?.some((s) => s.q === q && s.r === r)) return true;
  if (state.stacks.some((s) => s.q === q && s.r === r)) return true;
  return false;
}

function pickMissionHex(state: GameState, rng) {
  const cells = Object.values(state.hexes);
  for (let i = 0; i < 48; i++) {
    const cell = cells[rng.int(cells.length)];
    if (cell.terrain === "mountain" || cell.terrain === "river") continue;
    if (hexBusy(state, cell.q, cell.r)) continue;
    const nearCap = state.settlements.some(
      (s) => s.capitalOf !== null && hexDist({ q: s.q, r: s.r }, cell) < 3
    );
    if (nearCap) continue;
    return { q: cell.q, r: cell.r };
  }
  return null;
}

function tickMissions(state: GameState, rng: Rng, events: GameEvent[]) {
  if (!state.missions) state.missions = [];
  state.missions = state.missions.filter((m) => {
    m.turnsLeft -= 1;
    return m.turnsLeft > 0;
  });
  const target = Math.min(BALANCE.missions.max, BALANCE.missions.spawnStart + Math.floor((state.turn - 1) / 2));
  while (state.missions.length < target) {
    const hex = pickMissionHex(state, rng);
    if (!hex) break;
    const kind = MISSION_KINDS[rng.int(MISSION_KINDS.length)];
    state.missions.push({
      id: `m${state.nextId++}`,
      kind,
      q: hex.q,
      r: hex.r,
      turnsLeft: BALANCE.missions.lifetime
    });
    if (kind === "bounty") {
      const hp = BALANCE.units.defs.genin.hp * 4;
      state.stacks.push({
        id: `s${state.nextStackId++}`,
        playerId: -1,
        q: hex.q,
        r: hex.r,
        units: [{ type: "genin", count: 4, hpTotal: hp }],
        commanderId: null,
        moved: true,
        garrison: false
      });
    }
    events.push({
      kind: "log",
      text: `Новая метка: ${BALANCE.missions.kinds[kind].name}`
    });
  }
}

function completeMission(state: GameState, stack: Stack, events: GameEvent[]) {
  if (!state.missions || stack.playerId < 0) return;
  const i = state.missions.findIndex((m) => m.q === stack.q && m.r === stack.r);
  if (i < 0) return;
  const m = state.missions[i];
  const p = playerOf(state, stack.playerId);
  if (!p) return;
  if (m.kind === "bounty") {
    const foes = stacksAt(state, m.q, m.r).filter((s) => s.playerId < 0);
    if (foes.length) return;
  }
  const def = BALANCE.missions.kinds[m.kind];
  p.ryo += def.ryo;
  p.supplies += def.supplies;
  p.chakra += def.chakra;
  if (def.heal > 0) {
    for (const u of stack.units) {
      const max = BALANCE.units.defs[u.type].hp * Math.max(1, u.count);
      u.hpTotal = Math.min(max, Math.round(u.hpTotal + max * def.heal));
    }
  }
  grantXp(state, stack.playerId, def.xp, events);
  events.push({ kind: "log", text: `${p.name} выполняет: ${def.name}` });
  events.push({ kind: "pulse", q: m.q, r: m.r });
  events.push({ kind: "flash", q: m.q, r: m.r, color: "#e8cc5a" });
  state.missions.splice(i, 1);
}

export function createGame(setup: GameSetup) {
  const rng = createRng(hashSeed(setup.seed));
  const map = generateMap(rng, setup);
  const nextId = { n: 1 };
  const stacks = startingStacks(setup, map.capitals, map.settlements, map.resources, nextId);
  const relations = [];
  if (setup.placement === "teams") {
    const n = setup.players.length;
    const teamSize = n === 6 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const same = Math.floor(i / teamSize) === Math.floor(j / teamSize);
        relations.push({
          a: i,
          b: j,
          kind: same ? "alliance" : "war",
          since: 1
        });
      }
    }
  }
  const state = {
    version: BALANCE.saveVersion,
    seed: setup.seed,
    rngState: rng.getState(),
    turn: 1,
    turnLimit: setup.turnLimit,
    phase: "main",
    currentPlayer: 0,
    w: setup.w,
    h: setup.h,
    hexes: map.hexes,
    players: makePlayers(setup),
    stacks,
    settlements: map.settlements,
    resources: map.resources,
    relations,
    log: [`Сид ${setup.seed}. Война начинается.`],
    battle: null,
    winner: null,
    winReason: null,
    territoryHold: {},
    nextStackId: nextId.n,
    setup,
    nextId: 1,
    explored: {},
    missions: [],
    combatStats: { fights: 0, retreats: 0, wipes: 0 }
  };
  recomputeInfluence(state);
  applyIncome(state, 0, []);
  tickMissions(state, rng, []);
  hydrateVision(state);
  state.rngState = rng.getState();
  return state;
}

function err(state: GameState, error: string) {
  return { state, events: [], error };
}

function nextAlive(state: GameState, from: PlayerId) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const id = (from + i) % n;
    if (state.players[id]?.alive) return id;
  }
  return from;
}


export function estimateIncome(state: GameState, pid: PlayerId): { ryo: number; supplies: number; chakra: number } {
  const p = playerOf(state, pid);
  if (!p) return { ryo: 0, supplies: 0, chakra: 0 };
  const snap = { ryo: p.ryo, supplies: p.supplies, chakra: p.chakra, last: p.lastIncome };
  const stacksSnap = state.stacks.map((s) => ({
    id: s.id,
    units: s.units.map((u) => ({ ...u })),
  }));
  applyIncome(state, pid, []);
  const out = {
    ryo: p.ryo - snap.ryo,
    supplies: p.supplies - snap.supplies,
    chakra: p.chakra - snap.chakra,
  };
  p.ryo = snap.ryo;
  p.supplies = snap.supplies;
  p.chakra = snap.chakra;
  p.lastIncome = snap.last;
  for (const s of state.stacks) {
    const orig = stacksSnap.find((x) => x.id === s.id);
    if (orig) s.units = orig.units;
  }
  return out;
}

function hpOf(type: UnitId, n: number) {
  return BALANCE.units.defs[type].hp * n;
}

function createTrainingGame(): ApplyResult {
  const setup: GameSetup = {
    preset: "duel",
    w: 8,
    h: 5,
    seed: "ARENA",
    turnLimit: 20,
    placement: "circle",
    training: true,
    players: [
      { village: "leaf", difficulty: "human", commanderDefId: "leaf_kaen", name: "Вы" },
      { village: "stone", difficulty: "medium", commanderDefId: "stone_dogan", name: "Деревня Скалы" },
    ],
  };
  const rng = createRng(hashSeed(setup.seed));
  const hexes: Record<string, HexCell> = {};
  for (const hx of allHexes(setup.w, setup.h)) {
    const o = axialToOffset(hx);
    const { col, row } = o;
    const terrain: Terrain =
      col >= 3 && col <= 4 ? "forest" : col <= 1 || col >= 6 ? "hill" : "plains";
    hexes[hexKey(hx.q, hx.r)] = {
      q: hx.q,
      r: hx.r,
      terrain,
      owner: col <= 2 ? 0 : col >= 5 ? 1 : null,
      contested: false,
      influence: {},
      capture: null,
    };
  }
  const capA = offsetToAxial(1, 2);
  const capB = offsetToAxial(6, 2);
  const posA = offsetToAxial(3, 2);
  const posB = offsetToAxial(4, 2);
  const players = makePlayers(setup);
  const settlements = [
    {
      id: "cap-0",
      q: capA.q,
      r: capA.r,
      capitalOf: 0,
      owner: 0,
      buildings: [] as BuildingId[],
      capturedFrom: null,
      capturedTurn: -99,
      builtThisTurn: false,
    },
    {
      id: "cap-1",
      q: capB.q,
      r: capB.r,
      capitalOf: 1,
      owner: 1,
      buildings: [] as BuildingId[],
      capturedFrom: null,
      capturedTurn: -99,
      builtThisTurn: false,
    },
  ];
  const stacks: Stack[] = [
    {
      id: "s1",
      playerId: 0,
      q: posA.q,
      r: posA.r,
      units: [
        { type: "genin", count: 8, hpTotal: hpOf("genin", 8) },
        { type: "chunin", count: 2, hpTotal: hpOf("chunin", 2) },
      ],
      commanderId: "cmd-0-0",
      moved: false,
      garrison: false,
    },
    {
      id: "s2",
      playerId: 1,
      q: posB.q,
      r: posB.r,
      units: [
        { type: "genin", count: 10, hpTotal: hpOf("genin", 10) },
        { type: "chunin", count: 3, hpTotal: hpOf("chunin", 3) },
      ],
      commanderId: "cmd-1-0",
      moved: false,
      garrison: false,
    },
    {
      id: "s3",
      playerId: 0,
      q: capA.q,
      r: capA.r,
      units: [{ type: "genin", count: 6, hpTotal: hpOf("genin", 6) }],
      commanderId: null,
      moved: false,
      garrison: true,
    },
    {
      id: "s4",
      playerId: 1,
      q: capB.q,
      r: capB.r,
      units: [{ type: "genin", count: 6, hpTotal: hpOf("genin", 6) }],
      commanderId: null,
      moved: false,
      garrison: true,
    },
  ];
  const state: GameState = {
    version: BALANCE.saveVersion,
    seed: setup.seed,
    rngState: rng.getState(),
    turn: 1,
    turnLimit: setup.turnLimit,
    phase: "main",
    currentPlayer: 0,
    w: setup.w,
    h: setup.h,
    hexes,
    players,
    stacks,
    settlements,
    resources: [],
    relations: [{ a: 0, b: 1, kind: "war", since: 1 }],
    log: ["Тренировочный бой на опушке леса."],
    battle: null,
    winner: null,
    winReason: null,
    territoryHold: {},
    nextStackId: 5,
    setup,
    nextId: 1,
    explored: {},
    missions: [],
    combatStats: { fights: 0, retreats: 0, wipes: 0 },
  };
  const events: GameEvent[] = [{ kind: "log", text: "Тренировочный бой. Выберите тактику." }];
  hydrateVision(state);
  const atk = state.stacks.find((s) => s.id === "s1")!;
  const def = state.stacks.find((s) => s.id === "s2")!;
  fightAt(state, rng, atk, def, events, false);
  commitRng(state, rng);
  return { state, events };
}

export function applyCommand(state: GameState | null, cmd: Command, opts?: { inplace?: boolean }): ApplyResult {
  try {
    return applyCommandInner(state, cmd, opts);
  } catch (e) {
    return {
      state: state ?? ({} as GameState),
      events: [],
      error: e instanceof Error ? e.message : "Сбой команды",
    };
  }
}

function applyCommandInner(state: GameState | null, cmd: Command, opts?: { inplace?: boolean }): ApplyResult {
  if (cmd.type === "NEW_GAME") {
    try {
      const s = createGame(cmd.payload);
      return { state: s, events: [{ kind: "turn" }] };
    } catch (e) {
      return {
        state: state ?? ({} as GameState),
        events: [],
        error: e instanceof Error ? e.message : "Ошибка генерации",
      };
    }
  }
  if (cmd.type === "TRAINING") {
    try {
      return createTrainingGame();
    } catch (e) {
      return {
        state: state ?? ({} as GameState),
        events: [],
        error: e instanceof Error ? e.message : "Ошибка арены",
      };
    }
  }
  if (!state) return { state: state as unknown as GameState, events: [], error: "Нет партии" };
  if (state.phase === "gameover") return err(state, "Партия окончена");

  const next = (opts?.inplace ? state : cloneState(state)) as GameState;
  const events = [];
  const rng = rngOf(next);
  const pid = next.currentPlayer;
  const me = playerOf(next, pid);

  if (
  next.battle &&
  !next.battle.done &&
  cmd.type !== "BATTLE_CHOOSE" &&
  cmd.type !== "BATTLE_CONTINUE" &&
  cmd.type !== "BATTLE_RETREAT" &&
  cmd.type !== "SKIP_BATTLE")
  {
    return err(state, "Сначала завершите бой");
  }

  const spend = (ryo, sup, chk) => {
    if (!me) return false;
    if (me.ryo < ryo || me.supplies < sup || me.chakra < chk) return false;
    me.ryo -= ryo;
    me.supplies -= sup;
    me.chakra -= chk;
    return true;
  };

  switch (cmd.type) {
    case "HIRE":{
        if (!me?.alive) return err(state, "Не ваш ход");
        const { unit, q, r, count } = cmd.payload;
        const n = count ?? 1;
        if (!canHireUnit(next, pid, unit)) return err(state, "Нужна академия");
        const cap = next.settlements.find((s) => s.owner === pid && s.q === q && s.r === r);
        if (!cap) return err(state, "Нанимать можно в своём поселении");
        if (me.hiredThisTurn + n > 8) return err(state, "Лимит найма в ход");
        const cost = hireCost(next, pid, unit);
        if (!spend(cost.ryo * n, cost.supplies * n, cost.chakra * n)) return err(state, "Недостаточно ресурсов");
        const def = BALANCE.units.defs[unit];
        let stack = next.stacks.find((s) => s.q === q && s.r === r && s.playerId === pid && !s.garrison);
        if (!stack) {
          stack = {
            id: `s${next.nextStackId++}`,
            playerId: pid,
            q,
            r,
            units: [],
            commanderId: null,
            moved: false,
            garrison: false
          };
          next.stacks.push(stack);
        }
        const slot = stack.units.find((u) => u.type === unit);
        if (slot) {
          slot.count += n;
          slot.hpTotal += def.hp * n;
        } else {
          stack.units.push({ type: unit, count: n, hpTotal: def.hp * n });
        }
        me.hiredThisTurn += n;
        events.push({ kind: "log", text: `${me.name} нанимает ${def.name} ×${n}` });
        events.push({ kind: "flash", q, r, color: BALANCE.colors.villages[me.village].glow });
        break;
      }
    case "BUILD":{
        if (!me?.alive) return err(state, "Не ваш ход");
        const s = next.settlements.find((x) => x.id === cmd.payload.settlementId);
        if (!s || s.owner !== pid) return err(state, "Не своё поселение");
        if (s.builtThisTurn) return err(state, "Уже строили здесь");
        if (s.buildings.includes(cmd.payload.building)) return err(state, "Уже построено");
        const cost = buildingCost(next, pid, cmd.payload.building);
        if (!spend(cost.ryo, cost.supplies, 0)) return err(state, "Недостаточно ресурсов");
        s.buildings.push(cmd.payload.building);
        s.builtThisTurn = true;
        events.push({
          kind: "log",
          text: `${me.name} строит ${BALANCE.buildings[cmd.payload.building].name}`
        });
        events.push({ kind: "flash", q: s.q, r: s.r, color: BALANCE.colors.villages[me.village].glow });
        break;
      }
    case "MOVE":{
        if (!me?.alive) return err(state, "Не ваш ход");
        const stack = next.stacks.find((s) => s.id === cmd.payload.stackId);
        if (!stack || stack.playerId !== pid) return err(state, "Не ваш отряд");
        if (stack.moved) return err(state, "Отряд уже ходил");
        if (stack.garrison) return err(state, "Гарнизон не ходит");
        const dest = { q: cmd.payload.q, r: cmd.payload.r };
        if (hostilesAt(next, stack, dest).length) {
          const fail = executeAttack(next, rng, stack, dest, events);
          if (fail) return err(state, fail);
          break;
        }
        const distMap = reachable(next, stack);
        if (!distMap.has(hexKey(dest.q, dest.r))) return err(state, "Слишком далеко");
        const from = { q: stack.q, r: stack.r };
        const path = pathTo(next, stack, dest);
        if (!occupyHex(next, stack, dest)) return err(state, "Клетка занята");
        stack.moved = true;
        events.push({
          kind: "move",
          stackId: stack.id,
          from,
          to: dest,
          path: path.length >= 2 ? path : [from, dest],
        });
        completeMission(next, stack, events);
        break;
      }
    case "ATTACK":{
        if (!me?.alive) return err(state, "Не ваш ход");
        const stack = next.stacks.find((s) => s.id === cmd.payload.stackId);
        if (!stack || stack.playerId !== pid) return err(state, "Не ваш отряд");
        if (stack.moved) return err(state, "Отряд уже ходил");
        if (stack.garrison) return err(state, "Гарнизон не ходит");
        const fail = executeAttack(next, rng, stack, { q: cmd.payload.q, r: cmd.payload.r }, events);
        if (fail) return err(state, fail);
        break;
      }
    case "TECHNIQUE":{
        if (!me?.alive) return err(state, "Не ваш ход");
        const found = commanderById(next, cmd.payload.commanderId);
        if (!found || found.player.id !== pid) return err(state, "Не ваш командир");
        const c = found.commander;
        if (c.cooldown > 0) return err(state, `Перезарядка ${c.cooldown}`);
        const def = cmdDef(c.defId);
        if (!def) return err(state, "Нет техники");
        const tech = def.tech;
        const cost = BALANCE.commanders.techChakra[tech];
        if (!spend(0, 0, cost)) return err(state, "Нужна чакра");
        const originStack = next.stacks.find((s) => s.commanderId === c.id);
        if (!originStack) return err(state, "Командир без отряда");
        const target = { q: cmd.payload.q, r: cmd.payload.r };
        c.cooldown = BALANCE.commanders.techCd[tech];
        events.push({ kind: "flash", q: target.q, r: target.r, color: BALANCE.colors.villages[me.village].glow });
        if (tech === "line") {
          const line = hexLine({ q: originStack.q, r: originStack.r }, target).slice(1, 1 + BALANCE.commanders.lineLen);
          const dmg = BALANCE.commanders.lineDamage * c.level;
          for (const h of line) {
            events.push({ kind: "flash", q: h.q, r: h.r, color: BALANCE.colors.villages[me.village].accent });
            for (const s of stacksAt(next, h.q, h.r)) {
              if (s.playerId === pid || allied(next, pid, s.playerId)) continue;
              for (const u of s.units) {
                u.hpTotal = Math.max(0, u.hpTotal - dmg);
                u.count = Math.ceil(u.hpTotal / Math.max(1, BALANCE.units.defs[u.type].hp));
              }
              s.units = s.units.filter((u) => u.hpTotal > 0);
              events.push({ kind: "damage", q: h.q, r: h.r, text: `−${dmg}`, color: BALANCE.colors.villages[me.village].glow });
            }
          }
          next.stacks = next.stacks.filter((s) => s.units.length || s.commanderId);
          events.push({ kind: "log", text: `${def.name} использует технику линии` });
        } else if (tech === "heal") {
          for (const s of next.stacks) {
            if (s.playerId !== pid) continue;
            if (hexDist({ q: s.q, r: s.r }, { q: originStack.q, r: originStack.r }) > 2) continue;
            for (const u of s.units) {
              const max = BALANCE.units.defs[u.type].hp * Math.max(u.count, 1);
              const add = Math.round(max * BALANCE.commanders.healFrac);
              u.hpTotal = Math.min(max, u.hpTotal + add);
              u.count = Math.max(u.count, Math.ceil(u.hpTotal / BALANCE.units.defs[u.type].hp));
            }
          }
          events.push({ kind: "log", text: `${def.name} исцеляет отряды` });
        } else if (tech === "teleport") {
          const cell = hexOf(next, target.q, target.r);
          if (!cell || cell.owner !== pid) return err(state, "Только на свою территорию");
          if (hexDist({ q: originStack.q, r: originStack.r }, target) > BALANCE.commanders.teleportRange) {
            return err(state, "Слишком далеко");
          }
          const from = { q: originStack.q, r: originStack.r };
          originStack.q = target.q;
          originStack.r = target.r;
          originStack.moved = true;
          mergeStacks(next, target.q, target.r, pid);
          events.push({ kind: "move", stackId: originStack.id, from, to: target });
          events.push({ kind: "log", text: `${def.name} телепортируется` });
        } else if (tech === "subjugate") {
          const neut = next.stacks.find(
            (s) => s.q === target.q && s.r === target.r && s.playerId < 0 && s.garrison
          );
          if (!neut) return err(state, "Нет нейтралов");
          if (hexDist({ q: originStack.q, r: originStack.r }, target) > 2) return err(state, "Подойдите ближе");
          const mine = stackPower(originStack, me.village);
          const theirs = stackPower(neut, null);
          if (mine < theirs * 0.7) return err(state, "Нейтралы слишком сильны");
          neut.playerId = pid;
          neut.garrison = false;
          events.push({ kind: "log", text: `${def.name} подчиняет гарнизон` });
          events.push({ kind: "pulse", q: target.q, r: target.r });
        }
        break;
      }
    case "SKILL":{
        if (!me?.alive) return err(state, "Не ваш ход");
        const found = commanderById(next, cmd.payload.commanderId);
        if (!found || found.player.id !== pid) return err(state, "Не ваш командир");
        const c = found.commander;
        if (skillPointsAvailable(c) <= 0) return err(state, "Нет очков навыков");
        if (c.skills[cmd.payload.branch] >= 5) return err(state, "Ветка полна");
        c.skills[cmd.payload.branch] += 1;
        const name = BALANCE.skills[cmd.payload.branch][c.skills[cmd.payload.branch] - 1]?.name;
        events.push({ kind: "log", text: `${cmdDef(c.defId)?.name}: ${name}` });
        break;
      }
    case "HIRE_COMMANDER":{
        if (!me?.alive) return err(state, "Не ваш ход");
        if (next.turn < BALANCE.commanders.secondHireTurn) return err(state, `Доступно с хода ${BALANCE.commanders.secondHireTurn}`);
        if (me.hiredSecond) return err(state, "Второй командир уже нанят");
        const def = cmdDef(cmd.payload.defId);
        if (!def || def.village !== me.village) return err(state, "Чужой командир");
        if (me.commanders.some((c) => c.defId === cmd.payload.defId)) return err(state, "Уже в отряде");
        if (!spend(BALANCE.commanders.secondHireCostRyo, 0, 0)) return err(state, "Нужно 200 рё");
        const cap = next.settlements.find((s) => s.capitalOf === pid && s.owner === pid);
        if (!cap) return err(state, "Нет столицы");
        const id = `cmd-${pid}-${me.commanders.length}`;
        me.commanders.push({
          id,
          defId: cmd.payload.defId,
          level: 1,
          xp: 0,
          skills: { war: 0, econ: 0, scout: 0 },
          cooldown: 0,
          alive: true
        });
        me.hiredSecond = true;
        let stack = next.stacks.find((s) => s.q === cap.q && s.r === cap.r && s.playerId === pid && !s.garrison);
        if (!stack) {
          stack = {
            id: `s${next.nextStackId++}`,
            playerId: pid,
            q: cap.q,
            r: cap.r,
            units: [],
            commanderId: id,
            moved: false,
            garrison: false
          };
          next.stacks.push(stack);
        } else if (!stack.commanderId) stack.commanderId = id;else
        {
          next.stacks.push({
            id: `s${next.nextStackId++}`,
            playerId: pid,
            q: cap.q,
            r: cap.r,
            units: [{ type: "genin", count: 4, hpTotal: BALANCE.units.defs.genin.hp * 4 }],
            commanderId: id,
            moved: false,
            garrison: false
          });
        }
        events.push({ kind: "log", text: `${me.name} призывает ${def.name}` });
        break;
      }
    case "DIPLOMACY":{
        if (!me?.alive) return err(state, "Не ваш ход");
        const other = playerOf(next, cmd.payload.otherId);
        if (!other || !other.alive) return err(state, "Нет цели");
        const existing = next.relations.find(
          (r) =>
          r.a === pid && r.b === other.id || r.a === other.id && r.b === pid
        );
        const action = cmd.payload.action;
        if (action === "war") {
          if (existing) existing.kind = "war";else
          next.relations.push({ a: pid, b: other.id, kind: "war", since: next.turn });
          me.reputation = Math.max(0, me.reputation - BALANCE.diplomacy.declareWarRepHit);
          events.push({ kind: "log", text: `${me.name} объявляет войну ${other.name}` });
        } else if (action === "break") {
          if (existing && (existing.kind === "nap" || existing.kind === "alliance" || existing.kind === "trade")) {
            existing.kind = "war";
            me.reputation = Math.max(0, me.reputation - BALANCE.diplomacy.breakPactRepHit);
            events.push({ kind: "log", text: `${me.name} разрывает договор с ${other.name}` });
          }
        } else {
          const need =
          action === "nap" ?
          BALANCE.diplomacy.napRepMin :
          action === "trade" ?
          BALANCE.diplomacy.tradeRepMin :
          BALANCE.diplomacy.allianceRepMin;
          if (me.reputation < need || other.reputation < BALANCE.diplomacy.lowRepThreshold && other.difficulty !== "human") {
            if (other.difficulty !== "human" && me.reputation < need) return err(state, "Низкая репутация");
          }
          if (action === "alliance") {
            const cost = Math.round(BALANCE.diplomacy.allianceCost * BALANCE.villages[me.village].allianceCostMult);
            if (!spend(cost, 0, 0)) return err(state, "Нужны рё на союз");
          }
          if (action === "trade" && !spend(BALANCE.diplomacy.tradeRyo, 0, 0)) return err(state, "Нужны рё");
          const kind = action;
          if (existing) existing.kind = kind;else
          next.relations.push({ a: pid, b: other.id, kind, since: next.turn });
          events.push({ kind: "log", text: `${me.name} → ${other.name}: ${action}` });
        }
        break;
      }
    case "SKIP_BATTLE":{
        if (!next.battle) break;
        if (next.battle.done) {
          next.battle.skipped = true;
          break;
        }
        if (next.battle.battlePhase === "tactics") {
          applyBattleChoose(next, rng, events, "assault", null);
          occupyIfWon(next, rng, events);
          break;
        }
        if (next.battle.battlePhase === "retreat") {
          runRest(next, rng, events);
          occupyIfWon(next, rng, events);
          break;
        }
        next.battle.skipped = true;
        break;
      }
    case "BATTLE_CHOOSE":{
        if (!next.battle || next.battle.done) return err(state, "Нет выбора");
        if (next.battle.battlePhase !== "tactics") return err(state, "Тактика уже выбрана");
        applyBattleChoose(next, rng, events, cmd.payload.tactic, cmd.payload.techRound ?? null);
        occupyIfWon(next, rng, events);
        break;
      }
    case "BATTLE_CONTINUE":{
        if (!next.battle || next.battle.done) return err(state, "Бой уже закончен");
        if (next.battle.battlePhase !== "retreat" && next.battle.battlePhase !== "playing") {
          return err(state, "Рано продолжать");
        }
        runRest(next, rng, events);
        occupyIfWon(next, rng, events);
        break;
      }
    case "BATTLE_RETREAT":{
        if (!next.battle || next.battle.done) return err(state, "Нельзя отойти");
        if (next.battle.battlePhase !== "retreat") return err(state, "Отступление после первого раунда");
        finishBattle(next, rng, events, "retreat");
        break;
      }
    case "END_TURN":{
        if (!me) return err(state, "Нет игрока");
        tickCapture(next, events);
        recomputeInfluence(next);
        hospitalHeal(next, pid);
        checkVictory(next, events);
        if (next.phase === "gameover") break;
        const nxt = nextAlive(next, pid);
        if (nxt <= pid) {
          next.turn += 1;
          tickMissions(next, rng, events);
        }
        next.currentPlayer = nxt;
        next.battle = null;
        resetTurnFlags(next, nxt);
        applyIncome(next, nxt, events);
        events.push({ kind: "turn" });
        events.push({ kind: "log", text: `Ход ${next.turn}. ${playerOf(next, nxt)?.name}` });
        checkVictory(next, events);
        break;
      }
    default:
      return err(state, "Неизвестная команда");
  }

  commitRng(next, rng);
  for (const e of events) {
    if (e.kind === "log") next.log.push(e.text);
  }
  if (next.log.length > 80) next.log = next.log.slice(-80);
  if (cmd.type === "MOVE" || cmd.type === "ATTACK" || cmd.type === "TECHNIQUE" || cmd.type === "END_TURN" || cmd.type === "HIRE") {
    hydrateVision(next);
  }
  return { state: next, events };
}

export function legalHires(state: GameState, pid: PlayerId) {
  return Object.keys(BALANCE.units.defs).filter((u) => canHireUnit(state, pid, u));
}

export function currentIsHuman(state: GameState): boolean {
  return playerOf(state, state.currentPlayer)?.difficulty === "human";
}
