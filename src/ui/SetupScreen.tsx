import { useEffect, useMemo, useState } from "react";
import {
  BALANCE,
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  FACTION_BUDGET,
  PRESET_LABELS,
  VILLAGE_IDS,
  type Difficulty,
  type VillageId,
} from "@/game/balance";
import { commandersForVillage } from "@/game/mapgen";
import { randomSeedString } from "@/game/rng";
import type { GameSetup, PresetId, SetupKind } from "@/game/types";
import { hasLocal } from "@/game/save";

type Slot = {
  village: VillageId;
  difficulty: Difficulty;
  commanderDefId: string;
  name: string;
};

const PRESETS: PresetId[] = ["duel", "standard", "large", "continent"];

function defaultSlots(n: number): Slot[] {
  return Array.from({ length: n }, (_, i) => {
    const village = VILLAGE_IDS[i % VILLAGE_IDS.length]!;
    const cmds = commandersForVillage(village);
    return {
      village,
      difficulty: i === 0 ? "human" : "medium",
      commanderDefId: cmds[0]!,
      name: i === 0 ? "Вы" : BALANCE.villages[village].name,
    };
  });
}

export function SetupScreen(props: {
  onStart: (setup: GameSetup) => void;
  onContinue: () => void;
  onSim: () => void;
  onTrain: () => void;
  error?: string | null;
}) {
  const [preset, setPreset] = useState<PresetId>("duel");
  const spec = BALANCE.map.presets[preset];
  const [playerCount, setPlayerCount] = useState<number>(spec.playersMin);
  const [seed, setSeed] = useState("");
  const [placement, setPlacement] = useState<SetupKind>("circle");
  const [turnLimit, setTurnLimit] = useState<number>(spec.turnLimit);
  const [slots, setSlots] = useState<Slot[]>(() => defaultSlots(spec.playersMin));
  const [tab, setTab] = useState<"play" | "budget">("play");
  const [canContinue, setCanContinue] = useState(false);

  useEffect(() => {
    setSeed(randomSeedString());
    setCanContinue(hasLocal());
  }, []);

  const applyPreset = (id: PresetId) => {
    const p = BALANCE.map.presets[id];
    setPreset(id);
    setPlayerCount(p.playersMin);
    setTurnLimit(p.turnLimit);
    setSlots(defaultSlots(p.playersMin));
  };

  const setCount = (n: number) => {
    setPlayerCount(n);
    setSlots((prev) => {
      const next = prev.slice(0, n);
      while (next.length < n) next.push(defaultSlots(n)[next.length]!);
      return next;
    });
  };

  const patch = (i: number, part: Partial<Slot>) => {
    setSlots((prev) => {
      const next = prev.slice();
      const cur = { ...next[i]!, ...part };
      if (part.village) {
        const cmds = commandersForVillage(part.village);
        cur.commanderDefId = cmds[0]!;
        if (i !== 0) cur.name = BALANCE.villages[part.village].name;
      }
      next[i] = cur;
      return next;
    });
  };

  const start = () => {
    const p = BALANCE.map.presets[preset];
    props.onStart({
      preset,
      w: p.w,
      h: p.h,
      seed: seed.trim() || randomSeedString(),
      turnLimit,
      placement,
      players: slots.slice(0, playerCount).map((s, i) => ({
        ...s,
        name: s.difficulty === "human" && i === 0 ? "Вы" : s.name,
      })),
    });
  };

  const counts = useMemo(() => `${spec.w}×${spec.h} · ${playerCount} игроков · лимит ${turnLimit}`, [spec, playerCount, turnLimit]);

  return (
    <div className="setup">
      <div className="setup-bg" aria-hidden />
      <header className="setup-hero">
        <p className="kicker">Война пяти деревень</p>
        <h1>KAGE</h1>
        <p className="lede">
          Пошаговая стратегия на гексах. Захватите столицы, удержите землю, переиграйте каге.
        </p>
      </header>

      <div className="setup-tabs" role="tablist">
        <button type="button" className={tab === "play" ? "on" : ""} onClick={() => setTab("play")}>
          Партия
        </button>
        <button type="button" className={tab === "budget" ? "on" : ""} onClick={() => setTab("budget")}>
          Бюджет фракций
        </button>
      </div>

      {tab === "budget" ? (
        <BudgetTable />
      ) : (
        <div className="setup-grid">
          <section className="panel">
            <h2>Карта</h2>
            <div className="preset-row">
              {PRESETS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={preset === id ? "preset on" : "preset"}
                  onClick={() => applyPreset(id)}
                >
                  <span>{PRESET_LABELS[id]}</span>
                  <small>
                    {BALANCE.map.presets[id].w}×{BALANCE.map.presets[id].h} · столицы {BALANCE.map.presets[id].capitalDistMin}+
                  </small>
                </button>
              ))}
            </div>
            <label className="field">
              <span>Игроков</span>
              <input
                type="range"
                min={spec.playersMin}
                max={spec.playersMax}
                value={playerCount}
                onChange={(e) => setCount(Number(e.target.value))}
              />
              <em>{playerCount}</em>
            </label>
            <label className="field">
              <span>Лимит ходов</span>
              <input
                type="number"
                min={20}
                max={150}
                value={turnLimit}
                onChange={(e) => setTurnLimit(Number(e.target.value) || spec.turnLimit)}
              />
            </label>
            <label className="field">
              <span>Сид</span>
              <div className="seed-row">
                <input value={seed} onChange={(e) => setSeed(e.target.value.toUpperCase())} maxLength={12} />
                <button type="button" onClick={() => setSeed(randomSeedString())}>
                  Новый
                </button>
              </div>
            </label>
            <div className="seg">
              <button type="button" className={placement === "circle" ? "on" : ""} onClick={() => setPlacement("circle")}>
                По кругу
              </button>
              <button
                type="button"
                className={placement === "teams" ? "on" : ""}
                onClick={() => setPlacement("teams")}
                disabled={playerCount < 4}
              >
                Команды
              </button>
            </div>
            <p className="meta">{counts}</p>
          </section>

          <section className="panel slots">
            <h2>Деревни</h2>
            {slots.slice(0, playerCount).map((s, i) => {
              const cmds = commandersForVillage(s.village);
              const v = BALANCE.villages[s.village];
              return (
                <div key={i} className="slot" style={{ ["--v" as string]: BALANCE.colors.villages[s.village].accent }}>
                  <div className="slot-h">
                    <span className="kanji">{BALANCE.colors.villages[s.village].kanji}</span>
                    <strong>{v.name}</strong>
                    <small>{v.nameJp}</small>
                  </div>
                  <select value={s.village} onChange={(e) => patch(i, { village: e.target.value as VillageId })}>
                    {VILLAGE_IDS.map((id) => (
                      <option key={id} value={id}>
                        {BALANCE.villages[id].name}
                      </option>
                    ))}
                  </select>
                  <select value={s.difficulty} onChange={(e) => patch(i, { difficulty: e.target.value as Difficulty })}>
                    {DIFFICULTIES.map((d) => (
                      <option key={d} value={d}>
                        {DIFFICULTY_LABELS[d]}
                      </option>
                    ))}
                  </select>
                  <select
                    value={s.commanderDefId}
                    onChange={(e) => patch(i, { commanderDefId: e.target.value })}
                  >
                    {cmds.map((id) => {
                      const c = BALANCE.commanders.defs[id as keyof typeof BALANCE.commanders.defs];
                      return (
                        <option key={id} value={id}>
                          {c.name} — {c.title}
                        </option>
                      );
                    })}
                  </select>
                </div>
              );
            })}
          </section>
        </div>
      )}

      {props.error ? <p className="err">{props.error}</p> : null}

      <footer className="setup-actions">
        <button type="button" className="cta" onClick={start}>
          Начать войну
        </button>
        <button type="button" className="ghost" onClick={props.onTrain}>
          Тренировочный бой
        </button>
        {canContinue ? (
          <button type="button" className="ghost" onClick={props.onContinue}>
            Продолжить
          </button>
        ) : null}
        <button type="button" className="ghost" onClick={props.onSim}>
          Симуляция баланса
        </button>
      </footer>
    </div>
  );
}

function BudgetTable() {
  return (
    <section className="panel budget">
      <h2>Сумма бонусов каждой деревни = 100, штрафы компенсируют</h2>
      <div className="budget-grid">
        {FACTION_BUDGET.map((f) => (
          <article key={f.id} style={{ ["--v" as string]: BALANCE.colors.villages[f.id].accent }}>
            <h3>
              {BALANCE.colors.villages[f.id].kanji} {f.name}
            </h3>
            <ul>
              {f.bonuses.map((b) => (
                <li key={b.text}>
                  <b>+{b.pts}</b> {b.text}
                </li>
              ))}
            </ul>
            <ul className="pen">
              {f.penalties.map((b) => (
                <li key={b.text}>
                  <b>−{b.pts}</b> {b.text}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
