import {
  BALANCE,
  TERRAIN_LABELS,
  type CombatStyle,
  type TacticId,
  type TechId,
  type Terrain,
  type UnitId,
  type VillageId,
} from "./balance";
import type { Rng } from "./rng";
import type { BattleLogLine, Commander, Player, Stack, UnitSlot } from "./types";

export type FightContext = {
  terrain: Terrain;
  attackerVillage: VillageId;
  defenderVillage: VillageId | null;
  attackerCommander: Commander | null;
  defenderCommander: Commander | null;
  attackerIsGarrison: boolean;
  defenderIsGarrison: boolean;
  attackerPlayer: Player;
  defenderPlayer: Player | null;
  defenderWall: boolean;
  ambush?: boolean;
  attackerTactic?: TacticId;
  defenderTactic?: TacticId;
  attackerTech?: { tech: TechId; level: number; round: number } | null;
  defenderTech?: { tech: TechId; level: number; round: number } | null;
};

export type FightOpts = {
  maxRounds?: number;
  startRound?: number;
  firstA?: boolean;
  firstD?: boolean;
};

export type FightResult = {
  attacker: Stack;
  defender: Stack;
  log: BattleLogLine[];
  winner: "attacker" | "defender" | "draw";
  rounds: number;
};

export type FightForecast = {
  winChance: number;
  loseChance: number;
  drawChance: number;
  ownLost: { min: number; max: number };
  enemyLost: { min: number; max: number };
  mods: string[];
  warn: boolean;
};

function styleOf(id: UnitId): CombatStyle {
  return BALANCE.units.defs[id].style;
}

function triangleMult(atk: CombatStyle, def: CombatStyle, extra: number): number {
  if (atk === "siege" || atk === "elite" || def === "siege" || def === "elite") return 1;
  if (BALANCE.combat.triangle[atk] === def) return 1 + BALANCE.combat.triangleBonus + extra;
  return 1;
}

function countOf(slot: UnitSlot): number {
  const hp = BALANCE.units.defs[slot.type].hp;
  if (hp <= 0) return 0;
  return Math.max(0, Math.ceil(slot.hpTotal / hp - 1e-9));
}

function syncCount(slot: UnitSlot) {
  slot.count = countOf(slot);
}

function skill(cmd: Commander | null, branch: "war" | "econ" | "scout", min: number): boolean {
  return !!cmd && cmd.skills[branch] >= min;
}

function villageAtk(v: VillageId) {
  return BALANCE.villages[v].attackMult;
}
function villageDef(v: VillageId) {
  return BALANCE.villages[v].defenseMult;
}

function tacticOf(id: TacticId | undefined) {
  return id ? BALANCE.combat.tactics[id] : { atk: 1, def: 1, retreatLoss: BALANCE.combat.retreatLoss, noCounterRound1: false };
}

function initiativeOf(slot: UnitSlot, village: VillageId, cmd: Commander | null, extraIni: number): number {
  let ini = BALANCE.units.defs[slot.type].ini + BALANCE.villages[village].initiativeDelta + extraIni;
  if (cmd && BALANCE.commanders.defs[cmd.defId as keyof typeof BALANCE.commanders.defs]?.passive === "ini") {
    ini += 1;
  }
  if (skill(cmd, "war", 3)) ini += BALANCE.combat.firstStrikeInitBonus;
  return ini;
}

function passive(cmd: Commander | null): string | null {
  if (!cmd) return null;
  const d = BALANCE.commanders.defs[cmd.defId as keyof typeof BALANCE.commanders.defs];
  return d?.passive ?? null;
}

export function cloneStack(stack: Stack): Stack {
  return { ...stack, units: stack.units.map((u) => ({ ...u })) };
}

export function stackCount(stack: Stack): number {
  return stack.units.reduce((n, u) => n + u.count, 0);
}

export function stackPower(stack: Stack, village: VillageId | null): number {
  let p = 0;
  const vm = village ? BALANCE.villages[village] : null;
  for (const u of stack.units) {
    const d = BALANCE.units.defs[u.type];
    const atk = d.atk * (vm?.attackMult ?? 1);
    const def = d.def * (vm?.defenseMult ?? 1);
    p += ((atk + def) / 2) * u.count;
  }
  return p;
}

export function pickTactic(atkPower: number, defPower: number, side: "a" | "d"): TacticId {
  const ratio = atkPower / Math.max(1, defPower);
  if (side === "a") {
    if (ratio >= 1.2) return "assault";
    if (ratio <= 0.8) return "defend";
    return "flank";
  }
  if (ratio >= 1.15) return "defend";
  if (ratio <= 0.75) return "assault";
  return "flank";
}

function pct(x: number): string {
  const n = Math.round(x * 100);
  return `${n > 0 ? "+" : ""}${n}%`;
}

export function describeFightMods(ctx: FightContext, attacker: Stack, defender: Stack): string[] {
  const mods: string[] = [TERRAIN_LABELS[ctx.terrain]];
  const atkV = BALANCE.villages[ctx.attackerVillage];
  const defV = ctx.defenderVillage ? BALANCE.villages[ctx.defenderVillage] : null;
  if (ctx.terrain === "forest") {
    if (atkV.forestAmbush > 0) mods.push(`лес: засада +${Math.round(atkV.forestAmbush * 100)}% первого удара`);
    if (skill(ctx.attackerCommander, "scout", 4) || skill(ctx.defenderCommander, "scout", 4)) {
      mods.push(`лес: чаща ${pct(BALANCE.skills.scoutForest)} урона`);
    }
  }
  if (ctx.terrain === "hill" && defV && defV.hillDefMult !== 1) {
    mods.push(`холм: ${pct(defV.hillDefMult - 1)} защиты цели`);
  }
  if (ctx.terrain === "plains" && atkV.plainsDamageMult !== 1) {
    mods.push(`равнина: ${pct(atkV.plainsDamageMult - 1)} урона атакующего`);
  }
  if (ctx.defenderIsGarrison) mods.push("гарнизон");
  if (ctx.defenderWall) {
    mods.push(`стена: +${Math.round(BALANCE.buildings.wall.garrisonDefBonus * 100)}% защиты гарнизона`);
  }
  if (ctx.ambush) {
    mods.push(
      `засада в тумане: атака ×${BALANCE.combat.fogAmbushAtk}, защита ×${BALANCE.combat.fogAmbushDef}`,
    );
  }
  if (defV && defV.sandShield > 0) mods.push(`щит песка: −${Math.round(defV.sandShield * 100)}% первого удара`);
  let tri = false;
  for (const a of attacker.units) {
    for (const d of defender.units) {
      if (triangleMult(styleOf(a.type), styleOf(d.type), 0) > 1) tri = true;
    }
  }
  if (tri) mods.push(`слабость стихии: +${Math.round(BALANCE.combat.triangleBonus * 100)}% твоего урона`);
  if (ctx.attackerTactic) {
    const t = BALANCE.combat.tactics[ctx.attackerTactic];
    mods.push(`атака: ${t.name} (${t.text})`);
  }
  if (ctx.defenderTactic) {
    const t = BALANCE.combat.tactics[ctx.defenderTactic];
    mods.push(`защита: ${t.name} (${t.text})`);
  }
  return mods;
}

function applyArenaTech(
  from: Stack,
  to: Stack,
  spec: { tech: TechId; level: number },
  side: "a" | "d",
  round: number,
  log: BattleLogLine[],
): number {
  const extraIni = 0;
  if (spec.tech === "line") {
    const live = to.units.filter((u) => u.hpTotal > 0);
    const target = live.reduce<(typeof live)[0] | null>((b, u) => (!b || u.hpTotal > b.hpTotal ? u : b), null);
    if (target) {
      const dmg = Math.max(1, Math.round(BALANCE.commanders.lineDamage * spec.level));
      target.hpTotal = Math.max(0, target.hpTotal - dmg);
      syncCount(target);
      log.push({
        round,
        kind: "tech",
        side,
        dmg,
        to: target.type,
        toHp: target.hpTotal,
        toCount: target.count,
        text: `Техника линии — ${dmg} по ${BALANCE.units.defs[target.type].name}`,
      });
    }
  } else if (spec.tech === "heal") {
    for (const u of from.units) {
      const max = BALANCE.units.defs[u.type].hp * Math.max(u.count, 1);
      const add = Math.round(max * BALANCE.commanders.healFrac);
      u.hpTotal = Math.min(max, u.hpTotal + add);
      syncCount(u);
    }
    log.push({
      round,
      kind: "tech",
      side,
      text: "Техника исцеления — отряд восстанавливает силы",
    });
  } else if (spec.tech === "teleport") {
    log.push({
      round,
      kind: "tech",
      side,
      text: "Телепорт — вспышка инициативы в этом раунде",
    });
    return BALANCE.combat.arenaTeleportIni;
  } else if (spec.tech === "subjugate") {
    const live = to.units.filter((u) => u.hpTotal > 0);
    const target = live.reduce<(typeof live)[0] | null>((b, u) => (!b || u.hpTotal < b.hpTotal ? u : b), null);
    if (target) {
      const dmg = Math.max(1, Math.round(target.hpTotal * BALANCE.combat.arenaSubjugateFrac));
      target.hpTotal = Math.max(0, target.hpTotal - dmg);
      syncCount(target);
      log.push({
        round,
        kind: "tech",
        side,
        dmg,
        to: target.type,
        toHp: target.hpTotal,
        toCount: target.count,
        text: `Подчинение — давление ${dmg} по ${BALANCE.units.defs[target.type].name}`,
      });
    }
  }
  return extraIni;
}

export function applyRetreatLoss(stack: Stack, tactic: TacticId | undefined): Stack {
  const loss = tactic ? BALANCE.combat.tactics[tactic].retreatLoss : BALANCE.combat.retreatLoss;
  if (loss <= 0) return stack;
  for (const u of stack.units) {
    u.hpTotal = Math.max(0, Math.round(u.hpTotal * (1 - loss)));
    syncCount(u);
  }
  stack.units = stack.units.filter((u) => u.hpTotal > 0);
  return stack;
}

export function fight(rng: Rng, attacker: Stack, defender: Stack, ctx: FightContext, opts?: FightOpts): FightResult {
  const A = cloneStack(attacker);
  const D = cloneStack(defender);
  const log: BattleLogLine[] = [];
  const vA = ctx.attackerVillage;
  const vD = ctx.defenderVillage;
  const defV = vD ? BALANCE.villages[vD] : null;
  const atkV = BALANCE.villages[vA];
  const tacA = tacticOf(ctx.attackerTactic);
  const tacD = tacticOf(ctx.defenderTactic);

  let sandShieldLeft = 0;
  let sandShieldDef = defV?.sandShield ?? 0;
  if (passive(ctx.attackerCommander) === "shield") sandShieldLeft += 0.1;
  if (passive(ctx.defenderCommander) === "shield") sandShieldDef += 0.1;
  let firstA = opts?.firstA ?? true;
  let firstD = opts?.firstD ?? true;
  const startRound = opts?.startRound ?? 1;
  const capRounds = opts?.maxRounds ?? BALANCE.combat.maxRounds;

  const warTri = skill(ctx.attackerCommander, "war", 4) ? BALANCE.skills.warTriangle : 0;

  const roundActors = (extraA: number, extraD: number) => {
    type Actor = { side: "a" | "d"; slot: UnitSlot; ini: number };
    const list: Actor[] = [];
    for (const s of A.units) {
      if (s.hpTotal > 0)
        list.push({
          side: "a",
          slot: s,
          ini: initiativeOf(s, vA, ctx.attackerCommander, extraA),
        });
    }
    if (vD) {
      for (const s of D.units) {
        if (s.hpTotal > 0)
          list.push({
            side: "d",
            slot: s,
            ini: initiativeOf(s, vD, ctx.defenderCommander, extraD),
          });
      }
    } else {
      for (const s of D.units) {
        if (s.hpTotal > 0) list.push({ side: "d", slot: s, ini: BALANCE.units.defs[s.type].ini + extraD });
      }
    }
    list.sort((x, y) => y.ini - x.ini || (x.side === "a" ? -1 : 1));
    return list;
  };

  const dmgMultTerrain = (side: "a" | "d") => {
    const village = side === "a" ? atkV : defV;
    if (!village) return 1;
    let m = 1;
    if (ctx.terrain === "plains") m *= village.plainsDamageMult;
    if (ctx.terrain === "forest" && village.forestAmbush > 0 && side === "a" && firstA) {
      m *= 1 + village.forestAmbush;
    }
    if (ctx.terrain === "forest" && skill(side === "a" ? ctx.attackerCommander : ctx.defenderCommander, "scout", 4)) {
      m *= 1 + BALANCE.skills.scoutForest;
    }
    if (ctx.terrain === "hill" && side === "d") m *= village.hillDefMult;
    if (passive(side === "a" ? ctx.attackerCommander : ctx.defenderCommander) === "ambush" && ctx.terrain === "forest") {
      m *= 1.15;
    }
    return m;
  };

  const deal = (from: UnitSlot, toSide: Stack, toVillage: VillageId | null, side: "a" | "d") => {
    if (from.hpTotal <= 0) return null;
    const live = toSide.units.filter((u) => u.hpTotal > 0);
    if (!live.length) return null;
    const target = live.reduce((b, u) => (u.hpTotal > b.hpTotal ? u : b));
    const defn = BALANCE.units.defs[target.type];
    const atkDef = BALANCE.units.defs[from.type];
    const fromV = side === "a" ? vA : vD;
    const myTac = side === "a" ? tacA : tacD;
    const theirTac = side === "a" ? tacD : tacA;
    let atk = atkDef.atk * from.count * (fromV ? villageAtk(fromV) : 1) * myTac.atk;
    if (skill(side === "a" ? ctx.attackerCommander : ctx.defenderCommander, "war", 1)) atk *= 1 + BALANCE.skills.warAtk;
    if (passive(side === "a" ? ctx.attackerCommander : ctx.defenderCommander) === "atk10") atk *= 1.1;
    if (passive(side === "a" ? ctx.attackerCommander : ctx.defenderCommander) === "vsNeutral" && toSide.playerId < 0) {
      atk *= 1.2;
    }

    let def = defn.def * (toVillage ? villageDef(toVillage) : 1) * theirTac.def;
    const defCmd = side === "a" ? ctx.defenderCommander : ctx.attackerCommander;
    if (skill(defCmd, "war", 2)) def *= 1 + BALANCE.skills.warDef;
    if (passive(defCmd) === "def") def *= 1.15;
    if (toSide.garrison) {
      const gv = toVillage ? BALANCE.villages[toVillage].garrisonDefMult : 1;
      def *= gv;
      if (passive(defCmd) === "garrison") def *= 1.2;
      if (side === "a" && ctx.defenderWall) def *= 1 + BALANCE.buildings.wall.garrisonDefBonus;
    }
    if (atkDef.style === "siege" && toSide.garrison) {
      atk *= 1 + BALANCE.combat.siegeVsGarrison;
    }
    if (skill(side === "a" ? ctx.attackerCommander : ctx.defenderCommander, "war", 5) && toSide.garrison) {
      atk *= 1 + BALANCE.skills.warSiege;
    }
    if (passive(side === "a" ? ctx.attackerCommander : ctx.defenderCommander) === "siege" && toSide.garrison) {
      atk *= 1.15;
    }

    const tri = triangleMult(styleOf(from.type), styleOf(target.type), warTri);
    let raw = atk * (1 - def / (def + BALANCE.combat.defenseK)) * tri * dmgMultTerrain(side);
    raw *= rng.signed(BALANCE.combat.damageVariance);

    const isFirst = side === "a" ? firstA : firstD;
    if (isFirst && side === "d" && sandShieldDef > 0) raw *= 1 - sandShieldDef;
    if (isFirst && side === "a" && sandShieldLeft > 0) raw *= 1 - sandShieldLeft;
    if (isFirst && ctx.ambush) {
      raw *= side === "a" ? BALANCE.combat.fogAmbushAtk : BALANCE.combat.fogAmbushDef;
    }

    const dmg = Math.max(1, Math.round(raw));
    target.hpTotal = Math.max(0, target.hpTotal - dmg);
    syncCount(target);
    return {
      dmg,
      to: target.type,
      triangle: tri > 1,
      toHp: target.hpTotal,
      toCount: target.count,
    };
  };

  const roster = (s: Stack) =>
    s.units
      .filter((u) => u.count > 0)
      .map((u) => `${BALANCE.units.defs[u.type].name}×${u.count}`)
      .join(", ");
  if (startRound <= 1) {
    log.push({
      round: 0,
      kind: "note",
      text: `${roster(A) || "пусто"}  →  ${roster(D) || "пусто"}`,
    });
  }

  let round = startRound - 1;
  const lastRound = Math.min(BALANCE.combat.maxRounds, startRound - 1 + capRounds);
  while (round < lastRound) {
    round++;
    let extraA = 0;
    let extraD = 0;
    if (ctx.attackerTech && ctx.attackerTech.round === round) {
      extraA = applyArenaTech(A, D, ctx.attackerTech, "a", round, log);
    }
    if (ctx.defenderTech && ctx.defenderTech.round === round) {
      extraD = applyArenaTech(D, A, ctx.defenderTech, "d", round, log);
    }
    A.units = A.units.filter((u) => u.hpTotal > 0);
    D.units = D.units.filter((u) => u.hpTotal > 0);
    if (!A.units.length || !D.units.length) break;

    const actors = roundActors(extraA, extraD);
    const skipDef = round === 1 && tacA.noCounterRound1;
    const skipAtk = round === 1 && tacD.noCounterRound1;
    for (const act of actors) {
      if (act.slot.hpTotal <= 0) continue;
      if (act.side === "a" && skipAtk) continue;
      if (act.side === "d" && skipDef) continue;
      if (act.side === "a") {
        const hit = deal(act.slot, D, vD, "a");
        if (hit && hit.dmg > 0) {
          const fromN = BALANCE.units.defs[act.slot.type].name;
          const toN = BALANCE.units.defs[hit.to].name;
          log.push({
            round,
            kind: "hit",
            side: "a",
            from: act.slot.type,
            to: hit.to,
            dmg: hit.dmg,
            fromCount: act.slot.count,
            toHp: hit.toHp,
            toCount: hit.toCount,
            triangle: hit.triangle,
            text: `${fromN} ×${act.slot.count} бьёт ${toN} — ${hit.dmg}${hit.triangle ? " · слабость" : ""}`,
          });
        }
        firstA = false;
      } else {
        const hit = deal(act.slot, A, vA, "d");
        if (hit && hit.dmg > 0) {
          const fromN = BALANCE.units.defs[act.slot.type].name;
          const toN = BALANCE.units.defs[hit.to].name;
          log.push({
            round,
            kind: "hit",
            side: "d",
            from: act.slot.type,
            to: hit.to,
            dmg: hit.dmg,
            fromCount: act.slot.count,
            toHp: hit.toHp,
            toCount: hit.toCount,
            triangle: hit.triangle,
            text: `${fromN} ×${act.slot.count} отвечает ${toN} — ${hit.dmg}${hit.triangle ? " · слабость" : ""}`,
          });
        }
        firstD = false;
      }
      if (!A.units.some((u) => u.hpTotal > 0) || !D.units.some((u) => u.hpTotal > 0)) break;
    }
    A.units = A.units.filter((u) => u.hpTotal > 0);
    D.units = D.units.filter((u) => u.hpTotal > 0);
    if (!A.units.length || !D.units.length) break;
  }

  const aLive = A.units.some((u) => u.hpTotal > 0);
  const dLive = D.units.some((u) => u.hpTotal > 0);
  const winner = aLive && !dLive ? "attacker" : dLive && !aLive ? "defender" : "draw";
  if (opts?.maxRounds === 1 && aLive && dLive) {
    /* mid-fight pause — no result line yet */
  } else if (winner === "draw") {
    log.push({ round, kind: "result", text: "Ничья — оба отряда отступают" });
  } else {
    log.push({
      round,
      kind: "result",
      text: winner === "attacker" ? "Атакующий берёт поле" : "Защитник удерживает поле",
    });
  }
  return { attacker: A, defender: D, log, winner, rounds: Math.max(0, round - startRound + 1) };
}

export function forecastFight(
  seedRng: Rng,
  attacker: Stack,
  defender: Stack,
  ctx: FightContext,
  sims = BALANCE.combat.previewSims,
): FightForecast {
  const n = Math.max(1, sims);
  const own0 = stackCount(attacker);
  const en0 = stackCount(defender);
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let ownMin = Infinity;
  let ownMax = 0;
  let enMin = Infinity;
  let enMax = 0;
  for (let i = 0; i < n; i++) {
    const res = fight(seedRng.fork(i + 1), cloneStack(attacker), cloneStack(defender), ctx);
    if (res.winner === "attacker") wins++;
    else if (res.winner === "defender") losses++;
    else draws++;
    const ownLost = Math.max(0, own0 - stackCount(res.attacker));
    const enLost = Math.max(0, en0 - stackCount(res.defender));
    if (ownLost < ownMin) ownMin = ownLost;
    if (ownLost > ownMax) ownMax = ownLost;
    if (enLost < enMin) enMin = enLost;
    if (enLost > enMax) enMax = enLost;
  }
  const winChance = wins / n;
  return {
    winChance,
    loseChance: losses / n,
    drawChance: draws / n,
    ownLost: { min: ownMin === Infinity ? 0 : ownMin, max: ownMax },
    enemyLost: { min: enMin === Infinity ? 0 : enMin, max: enMax },
    mods: describeFightMods(ctx, attacker, defender),
    warn: winChance < BALANCE.combat.previewWarnChance,
  };
}

export function remainingWinChance(seedRng: Rng, attacker: Stack, defender: Stack, ctx: FightContext): number {
  const n = BALANCE.combat.retreatSims;
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const res = fight(seedRng.fork(9000 + i), cloneStack(attacker), cloneStack(defender), ctx, {
      startRound: 2,
      firstA: false,
      firstD: false,
    });
    if (res.winner === "attacker") wins++;
  }
  return wins / Math.max(1, n);
}

export function randomArmy(rng: Rng, budget: number): UnitSlot[] {
  const ids = Object.keys(BALANCE.units.defs) as UnitId[];
  const units: UnitSlot[] = [];
  let left = budget;
  while (left > 0) {
    const id = rng.pick(ids);
    const cost = BALANCE.units.defs[id].costRyo;
    if (cost > left && units.length) break;
    const n = Math.max(1, Math.min(8, Math.floor(left / Math.max(cost, 1))));
    const existing = units.find((u) => u.type === id);
    const hp = BALANCE.units.defs[id].hp * n;
    if (existing) {
      existing.count += n;
      existing.hpTotal += hp;
    } else {
      units.push({ type: id, count: n, hpTotal: hp });
    }
    left -= cost * n;
    if (rng.chance(0.25)) break;
  }
  if (!units.length) {
    units.push({ type: "genin", count: 4, hpTotal: BALANCE.units.defs.genin.hp * 4 });
  }
  return units;
}
