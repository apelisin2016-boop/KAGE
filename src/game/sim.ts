import { BALANCE, VILLAGE_IDS, type VillageId } from "./balance";
import {
  applyRetreatLoss,
  cloneStack,
  fight,
  pickTactic,
  randomArmy,
  remainingWinChance,
  stackCount,
  stackPower,
} from "./combat";
import { createRng } from "./rng";
import { applyCommand } from "./rules";
import { botTurn } from "./ai";
import { commandersForVillage } from "./mapgen";
import type { GameSetup, GameState, Player, UnitSlot } from "./types";

export type BattleSimRow = {
  a: string;
  b: string;
  winner: "a" | "b" | "draw" | "retreat";
  rounds: number;
};

export type BattleSimResult = {
  fights: number;
  aWins: number;
  bWins: number;
  draws: number;
  retreats: number;
  wipes: number;
  avgRounds: number;
  byStyle: Record<string, { n: number; wins: number }>;
};

export function simBattles(n: number, seed: string, opts?: { retreat?: boolean }): BattleSimResult {
  const useRetreat = opts?.retreat ?? true;
  const rng = createRng(seed + ":battles");
  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  let retreats = 0;
  let wipes = 0;
  let rounds = 0;
  const byStyle: Record<string, { n: number; wins: number }> = {};
  const dummyPlayer = (id: number, v: VillageId): Player => ({
    id,
    name: v,
    village: v,
    difficulty: "medium",
    ryo: 0,
    supplies: 0,
    chakra: 0,
    commanders: [],
    startingCommander: "",
    alive: true,
    reputation: 50,
    hiredSecond: false,
    hiredThisTurn: 0,
    lastIncome: { ryo: 0, supplies: 0, chakra: 0 },
  });
  for (let i = 0; i < n; i++) {
    const va = rng.pick(VILLAGE_IDS);
    const vb = rng.pick(VILLAGE_IDS);
    const A: UnitSlot[] = randomArmy(rng, rng.intRange(80, 220));
    const B: UnitSlot[] = randomArmy(rng, rng.intRange(80, 220));
    const stackA = {
      id: "a",
      playerId: 0,
      q: 0,
      r: 0,
      units: A,
      commanderId: null,
      moved: false,
      garrison: false,
    };
    const stackB = {
      id: "b",
      playerId: 1,
      q: 0,
      r: 0,
      units: B,
      commanderId: null,
      moved: false,
      garrison: rng.chance(0.15),
    };
    const tacA = pickTactic(stackPower(stackA, va), stackPower(stackB, vb), "a");
    const tacB = pickTactic(stackPower(stackA, va), stackPower(stackB, vb), "d");
    const ctx = {
      terrain: rng.pick(["plains", "forest", "hill", "desert"] as const),
      attackerVillage: va,
      defenderVillage: vb,
      attackerCommander: null,
      defenderCommander: null,
      attackerIsGarrison: false,
      defenderIsGarrison: stackB.garrison,
      attackerPlayer: dummyPlayer(0, va),
      defenderPlayer: dummyPlayer(1, vb),
      defenderWall: false,
      attackerTactic: tacA,
      defenderTactic: tacB,
    };
    const own0 = stackCount(stackA);
    const en0 = stackCount(stackB);
    const r1 = fight(rng, cloneStack(stackA), cloneStack(stackB), ctx, { maxRounds: 1 });
    let res = r1;
    let retreated = false;
    if (r1.attacker.units.some((u) => u.hpTotal > 0) && r1.defender.units.some((u) => u.hpTotal > 0)) {
      if (useRetreat) {
        const chance = remainingWinChance(rng, r1.attacker, r1.defender, ctx);
        if (chance < BALANCE.combat.retreatWinChance) {
          applyRetreatLoss(r1.attacker, tacA);
          retreated = true;
          res = { ...r1, winner: "draw", rounds: 1 };
        }
      }
      if (!retreated) {
        res = fight(rng, r1.attacker, r1.defender, ctx, { startRound: 2, firstA: false, firstD: false });
        res = { ...res, rounds: 1 + res.rounds };
      }
    }
    rounds += res.rounds;
    if (retreated) retreats++;
    else if (res.winner === "attacker") aWins++;
    else if (res.winner === "defender") bWins++;
    else draws++;
    const aLeft = stackCount(res.attacker);
    const bLeft = stackCount(res.defender);
    const aLost = Math.max(0, own0 - aLeft);
    const bLost = Math.max(0, en0 - bLeft);
    if (!retreated && ((aLeft === 0 && bLost / Math.max(1, en0) < 0.2) || (bLeft === 0 && aLost / Math.max(1, own0) < 0.2))) {
      wipes++;
    }
    const key = A.map((u) => u.type).sort().join("+") || "empty";
    byStyle[key] ??= { n: 0, wins: 0 };
    byStyle[key].n++;
    if (res.winner === "attacker") byStyle[key].wins++;
  }
  return {
    fights: n,
    aWins,
    bWins,
    draws,
    retreats,
    wipes,
    avgRounds: rounds / Math.max(1, n),
    byStyle,
  };
}

export type MatchSimRow = {
  villages: VillageId[];
  winner: VillageId | "draw";
  turns: number;
  skills: Record<string, number>;
  units: Record<string, number>;
};

export type MatchSimResult = {
  games: number;
  winRate: Record<VillageId, { games: number; wins: number; rate: number }>;
  avgTurns: number;
  unitPick: Record<string, number>;
  skillPick: Record<string, number>;
  rows: MatchSimRow[];
};

function playBotGame(seed: string, villages: VillageId[]): { state: GameState; units: Record<string, number>; skills: Record<string, number> } {
  const setup: GameSetup = {
    preset: "duel",
    w: BALANCE.map.presets.duel.w,
    h: BALANCE.map.presets.duel.h,
    seed,
    turnLimit: BALANCE.map.presets.duel.turnLimit,
    placement: "circle",
    players: villages.map((v, i) => ({
      village: v,
      difficulty: "medium",
      commanderDefId: commandersForVillage(v)[i % 3] ?? commandersForVillage(v)[0]!,
      name: BALANCE.villages[v].name,
    })),
  };
  let r = applyCommand(null, { type: "NEW_GAME", payload: setup });
  if (r.error || !r.state.players) {
    throw new Error(r.error ?? "sim start failed");
  }
  let s = r.state;
  const units: Record<string, number> = {};
  const skills: Record<string, number> = {};
  let guard = 0;
  while (s.phase !== "gameover" && guard++ < 220) {
    const before = s.turn;
    const who = s.currentPlayer;
    s = botTurn(s);
    for (const st of s.stacks) {
      if (st.playerId !== who) continue;
      for (const u of st.units) units[u.type] = (units[u.type] ?? 0) + 1;
    }
    const p = s.players[who];
    if (p) {
      for (const c of p.commanders) {
        for (const [br, n] of Object.entries(c.skills)) {
          if (n) skills[br] = (skills[br] ?? 0) + n;
        }
      }
    }
    if (s.battle && !s.battle.done) {
      if (s.battle.battlePhase === "tactics") {
        const end = applyCommand(s, { type: "BATTLE_CHOOSE", payload: { tactic: "assault" } });
        s = end.state;
      }
      if (s.battle && !s.battle.done && s.battle.battlePhase === "retreat") {
        const end = applyCommand(s, { type: "BATTLE_CONTINUE" });
        s = end.state;
      }
    }
    if (s.currentPlayer === who && s.turn === before && s.phase !== "gameover") {
      const end = applyCommand(s, { type: "END_TURN" });
      s = end.state;
    }
  }
  return { state: s, units, skills };
}

export async function simMatches(
  n: number,
  seed: string,
  onProgress?: (i: number, row: MatchSimRow) => void,
): Promise<MatchSimResult> {
  const rng = createRng(seed + ":matches");
  const rows: MatchSimRow[] = [];
  const winRate = Object.fromEntries(VILLAGE_IDS.map((v) => [v, { games: 0, wins: 0, rate: 0 }])) as MatchSimResult["winRate"];
  const unitPick: Record<string, number> = {};
  const skillPick: Record<string, number> = {};
  let turns = 0;
  for (let i = 0; i < n; i++) {
    const a = rng.pick(VILLAGE_IDS);
    let b = rng.pick(VILLAGE_IDS);
    if (n <= VILLAGE_IDS.length * (VILLAGE_IDS.length - 1) && i < n) {
      b = VILLAGE_IDS[(i + 1) % VILLAGE_IDS.length]!;
      if (b === a) b = VILLAGE_IDS[(i + 2) % VILLAGE_IDS.length]!;
    }
    const { state, units, skills } = playBotGame(`${seed}-${i}-${rng.int(1e9)}`, [a, b]);
    const winnerId = state.winner?.[0];
    const winnerVillage = winnerId !== undefined ? state.players[winnerId]?.village : undefined;
    const winner: VillageId | "draw" = winnerVillage ?? "draw";
    winRate[a].games++;
    winRate[b].games++;
    if (winner !== "draw") winRate[winner].wins++;
    turns += state.turn;
    for (const [k, v] of Object.entries(units)) unitPick[k] = (unitPick[k] ?? 0) + v;
    for (const [k, v] of Object.entries(skills)) skillPick[k] = (skillPick[k] ?? 0) + v;
    const row: MatchSimRow = { villages: [a, b], winner, turns: state.turn, skills, units };
    rows.push(row);
    onProgress?.(i + 1, row);
    await new Promise((r) => setTimeout(r, 0));
  }
  for (const v of VILLAGE_IDS) {
    winRate[v].rate = winRate[v].games ? winRate[v].wins / winRate[v].games : 0;
  }
  return {
    games: n,
    winRate,
    avgTurns: turns / Math.max(1, n),
    unitPick,
    skillPick,
    rows,
  };
}