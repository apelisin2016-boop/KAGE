import type {
  BuildingId,
  CombatStyle,
  Difficulty,
  SkillBranch,
  TacticId,
  TechId,
  Terrain,
  UnitId,
  VillageId,
} from "./balance";

export type HexId = string;
export type PlayerId = number;
export type StackId = string;
export type SettlementId = string;
export type ResourceKind = "ryo" | "supplies" | "chakra";
export type Phase = "main" | "battle" | "gameover";
export type RelationKind = "war" | "peace" | "nap" | "trade" | "alliance";
export type SetupKind = "circle" | "teams";
export type PresetId = "duel" | "standard" | "large" | "continent";

export type UnitSlot = {
  type: UnitId;
  count: number;
  hpTotal: number;
};

export type Stack = {
  id: StackId;
  playerId: PlayerId;
  q: number;
  r: number;
  units: UnitSlot[];
  commanderId: string | null;
  moved: boolean;
  garrison: boolean;
};

export type Commander = {
  id: string;
  defId: string;
  level: number;
  xp: number;
  skills: Record<SkillBranch, number>;
  cooldown: number;
  alive: boolean;
};

export type HexCell = {
  q: number;
  r: number;
  terrain: Terrain;
  owner: PlayerId | null;
  contested: boolean;
  influence: Record<string, number>;
  capture: { playerId: PlayerId; turns: number } | null;
};

export type Settlement = {
  id: SettlementId;
  q: number;
  r: number;
  capitalOf: PlayerId | null;
  owner: PlayerId | null;
  buildings: BuildingId[];
  capturedFrom: PlayerId | null;
  capturedTurn: number;
  builtThisTurn: boolean;
};

export type ResourceNode = {
  id: string;
  q: number;
  r: number;
  kind: ResourceKind;
  owner: PlayerId | null;
  capturedFrom: PlayerId | null;
  capturedTurn: number;
};

export type Player = {
  id: PlayerId;
  name: string;
  village: VillageId;
  difficulty: Difficulty;
  ryo: number;
  supplies: number;
  chakra: number;
  commanders: Commander[];
  startingCommander: string;
  alive: boolean;
  reputation: number;
  hiredSecond: boolean;
  hiredThisTurn: number;
  lastIncome: { ryo: number; supplies: number; chakra: number };
};

export type Relation = {
  a: PlayerId;
  b: PlayerId;
  kind: RelationKind;
  since: number;
};

export type BattleLogLine = {
  round: number;
  text: string;
  kind?: "hit" | "result" | "note" | "tech" | "tactic" | "retreat";
  side?: "a" | "d";
  from?: UnitId;
  to?: UnitId;
  dmg?: number;
  fromCount?: number;
  toHp?: number;
  toCount?: number;
  triangle?: boolean;
};

export type BattleRoster = { type: UnitId; count: number; hpTotal: number };
export type BattlePhase = "tactics" | "playing" | "retreat" | "done";

export type BattleTechReady = {
  commanderId: string;
  tech: TechId;
  name: string;
  cost: number;
  maxRound: number;
};

export type BattleState = {
  attackerStackId: StackId;
  defenderStackId: StackId;
  hexQ: number;
  hexR: number;
  fromQ?: number;
  fromR?: number;
  log: BattleLogLine[];
  round: number;
  done: boolean;
  winner: PlayerId | null;
  skipped: boolean;
  ambush?: boolean;
  terrain?: Terrain;
  attackerName?: string;
  defenderName?: string;
  attackerId?: PlayerId;
  defenderId?: PlayerId;
  attackerVillage?: VillageId | null;
  defenderVillage?: VillageId | null;
  attackerCmd?: string | null;
  defenderCmd?: string | null;
  startA?: BattleRoster[];
  startD?: BattleRoster[];
  endA?: BattleRoster[];
  endD?: BattleRoster[];
  mods?: string[];
  result?: "attacker" | "defender" | "draw" | "retreat";
  battlePhase?: BattlePhase;
  waitingFor?: "attacker" | "defender" | null;
  attackerTactic?: TacticId;
  defenderTactic?: TacticId;
  knownEnemyTactic?: boolean;
  attackerTechRound?: number | null;
  defenderTechRound?: number | null;
  techReady?: BattleTechReady | null;
  liveA?: BattleRoster[];
  liveD?: BattleRoster[];
};

export type MissionKind = "scroll" | "shrine" | "cache" | "bounty";

export type Mission = {
  id: string;
  kind: MissionKind;
  q: number;
  r: number;
  turnsLeft: number;
};

export type GameSetup = {
  preset: PresetId;
  w: number;
  h: number;
  seed: string;
  turnLimit: number;
  placement: SetupKind;
  training?: boolean;
  players: {
    village: VillageId;
    difficulty: Difficulty;
    commanderDefId: string;
    name: string;
  }[];
};

export type GameState = {
  version: number;
  seed: string;
  rngState: number;
  turn: number;
  turnLimit: number;
  phase: Phase;
  currentPlayer: PlayerId;
  w: number;
  h: number;
  hexes: Record<HexId, HexCell>;
  players: Player[];
  stacks: Stack[];
  settlements: Settlement[];
  resources: ResourceNode[];
  relations: Relation[];
  log: string[];
  battle: BattleState | null;
  winner: PlayerId[] | null;
  winReason: string | null;
  territoryHold: Record<string, number>;
  nextStackId: number;
  setup: GameSetup;
  nextId: number;
  /** Per-player explored hex keys (fog of war memory). */
  explored: Record<string, string[]>;
  missions: Mission[];
  combatStats: { fights: number; retreats: number; wipes: number };
};

export type Command =
  | { type: "NEW_GAME"; payload: GameSetup }
  | { type: "TRAINING" }
  | { type: "HIRE"; payload: { unit: UnitId; q: number; r: number; count?: number } }
  | { type: "BUILD"; payload: { building: BuildingId; settlementId: SettlementId } }
  | { type: "MOVE"; payload: { stackId: StackId; q: number; r: number } }
  | { type: "ATTACK"; payload: { stackId: StackId; q: number; r: number } }
  | { type: "TECHNIQUE"; payload: { commanderId: string; q: number; r: number } }
  | { type: "SKILL"; payload: { commanderId: string; branch: SkillBranch } }
  | { type: "HIRE_COMMANDER"; payload: { defId: string } }
  | {
      type: "DIPLOMACY";
      payload: { otherId: PlayerId; action: "nap" | "trade" | "alliance" | "war" | "break" };
    }
  | { type: "SKIP_BATTLE" }
  | { type: "BATTLE_CHOOSE"; payload: { tactic: TacticId; techRound?: number | null } }
  | { type: "BATTLE_CONTINUE" }
  | { type: "BATTLE_RETREAT" }
  | { type: "END_TURN" };

export type GameEvent =
  | { kind: "move"; stackId: StackId; from: { q: number; r: number }; to: { q: number; r: number }; path?: { q: number; r: number }[] }
  | { kind: "damage"; q: number; r: number; text: string; color: string }
  | { kind: "flash"; q: number; r: number; color: string }
  | { kind: "pulse"; q: number; r: number }
  | { kind: "battle"; battle: BattleState }
  | { kind: "log"; text: string }
  | { kind: "turn" }
  | { kind: "win" };

export type ApplyResult = { state: GameState; events: GameEvent[]; error?: string };

export type UnitDefView = {
  id: UnitId;
  name: string;
  style: CombatStyle;
  atk: number;
  def: number;
  hp: number;
  ini: number;
  move: number;
};

export function relKey(a: PlayerId, b: PlayerId): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}
