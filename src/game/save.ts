import { BALANCE } from "./balance";
import type { GameState } from "./types";

const KEY = "kage.save.v1";
const KEY_SETUP = "kage.settings.v1";

export function cloneState<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(raw: string): GameState {
  const s = JSON.parse(raw) as GameState;
  if (!s || typeof s !== "object") throw new Error("Пустой файл");
  if (typeof s.version !== "number") s.version = 1;
  if (s.version > BALANCE.saveVersion) throw new Error("Сохранение от новой версии");
  if (!s.hexes || !s.players || !s.stacks) throw new Error("Повреждённое сохранение");
  if (!s.explored) s.explored = {};
  if (!s.missions) s.missions = [];
  if (!s.combatStats) s.combatStats = { fights: 0, retreats: 0, wipes: 0 };
  for (const p of s.players) {
    if (!p.lastIncome) p.lastIncome = { ryo: 0, supplies: 0, chakra: 0 };
  }
  s.version = BALANCE.saveVersion;
  return s;
}

export function saveLocal(state: GameState) {
  try {
    const blob = serialize(state);
    localStorage.setItem(KEY, blob);
    localStorage.setItem(KEY + ".bak", blob);
  } catch {
    /* quota / private mode */
  }
}

export function loadLocal(): GameState | null {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(KEY + ".bak");
    if (!raw) return null;
    return deserialize(raw);
  } catch {
    return null;
  }
}

export function hasLocal(): boolean {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

export function downloadSave(state: GameState) {
  const blob = new Blob([serialize(state)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kage-${state.seed}-t${state.turn}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function saveSettings(json: unknown) {
  try {
    localStorage.setItem(KEY_SETUP, JSON.stringify(json));
  } catch {
    /* ignore */
  }
}

export function loadSettings<T>(fallback: T): T {
  try {
    const raw = localStorage.getItem(KEY_SETUP);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
