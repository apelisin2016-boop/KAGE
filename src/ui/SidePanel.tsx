import {
  BALANCE,
  BUILDING_IDS,
  SKILL_BRANCHES,
  STYLE_LABELS,
  TECH_LABELS,
  UNIT_IDS,
  type BuildingId,
  type SkillBranch,
  type TechId,
  type UnitId,
} from "@/game/balance";
import {
  buildingCost,
  canHireUnit,
  estimateIncome,
  hireCost,
  playerOf,
  relationOf,
  skillPointsAvailable,
} from "@/game/rules";
import type { GameState, Stack } from "@/game/types";

export function SidePanel(props: {
  state: GameState;
  selected: Stack | null;
  selectedHex: { q: number; r: number } | null;
  techMode: boolean;
  onHire: (unit: UnitId, q: number, r: number) => void;
  onBuild: (b: BuildingId, settlementId: string) => void;
  onSkill: (commanderId: string, branch: SkillBranch) => void;
  onTech: () => void;
  onHireCommander: (defId: string) => void;
  onDiplo: (otherId: number, action: "nap" | "trade" | "alliance" | "war" | "break") => void;
  onEnd: () => void;
  onSave: () => void;
  onExport: () => void;
  onMenu: () => void;
  onSkipBattle: () => void;
  muted: boolean;
  onMute: () => void;
  error: string | null;
}) {
  const { state } = props;
  const p = playerOf(state, state.currentPlayer);
  if (!p) return null;
  const v = BALANCE.villages[p.village];
  const accent = BALANCE.colors.villages[p.village].accent;
  const human = p.difficulty === "human";
  const ownedAt = (q: number, r: number) =>
    state.settlements.find((s) => s.q === q && s.r === r && s.owner === p.id);
  const capital = state.settlements.find((s) => s.capitalOf === p.id && s.owner === p.id);
  const settlement =
    (props.selectedHex ? ownedAt(props.selectedHex.q, props.selectedHex.r) : undefined) ??
    (props.selected ? ownedAt(props.selected.q, props.selected.r) : undefined) ??
    capital;
  const hexForHire = settlement ?? capital;
  const cmd = p.commanders.find((c) => c.alive) ?? p.commanders[0];
  const selectedCmd = props.selected?.commanderId
    ? p.commanders.find((c) => c.id === props.selected!.commanderId)
    : cmd;
  const income = estimateIncome(state, p.id);
  const idleN = state.stacks.filter((s) => s.playerId === p.id && !s.garrison && !s.moved).length;

  return (
    <aside className="side" style={{ ["--v" as string]: accent }}>
      <header className="side-h">
        <img className="portrait" src={`/sprites/commanders/${p.village}.png`} alt="" />
        <div>
          <p className="kicker">Ход {state.turn} / {state.turnLimit}</p>
          <h2>
            <span className="kanji">{BALANCE.colors.villages[p.village].kanji}</span>
            {p.name}
          </h2>
          <p className="meta">{v.nameJp} · {human ? "ваш ход" : "ходит бот"}</p>
        </div>
        <button type="button" className="icon-btn" onClick={props.onMenu} aria-label="Меню">
          Меню
        </button>
      </header>

      <div className="res">
        <Res label="Рё" value={p.ryo} delta={income.ryo} />
        <Res label="Припасы" value={p.supplies} delta={income.supplies} />
        <Res label="Чакра" value={p.chakra} delta={income.chakra} />
        <Res label="Репутация" value={p.reputation} />
      </div>

      {props.error ? <p className="err">{props.error}</p> : null}

      {human && hexForHire ? (
        <section className="block">
          <h3>Найм</h3>
          <p className="meta">в {hexForHire.capitalOf !== null ? "столице" : `поселении ${hexForHire.q},${hexForHire.r}`}</p>
          <div className="hire-grid">
            {UNIT_IDS.map((id) => {
              const d = BALANCE.units.defs[id];
              const cost = hireCost(state, p.id, id);
              const ok = canHireUnit(state, p.id, id) && p.ryo >= cost.ryo && p.supplies >= cost.supplies && p.chakra >= cost.chakra;
              return (
                <button
                  key={id}
                  type="button"
                  disabled={!ok}
                  onClick={() => props.onHire(id, hexForHire.q, hexForHire.r)}
                  title={`${d.name}: ${cost.ryo} рё`}
                >
                  <img src={`/sprites/units/${id}.png`} alt="" />
                  <strong>{d.name}</strong>
                  <small>
                    {STYLE_LABELS[d.style]} · {cost.ryo}р
                  </small>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {human && settlement ? (
        <section className="block build-block">
          <h3>Постройки · {settlement.capitalOf !== null ? "столица" : "поселение"}</h3>
          <p className="meta">
            {settlement.builtThisTurn ? "уже строили здесь в этот ход" : "одна постройка за ход на поселение"}
          </p>
          <div className="hire-grid">
            {BUILDING_IDS.map((id) => {
              const d = BALANCE.buildings[id];
              const cost = buildingCost(state, p.id, id);
              const has = settlement.buildings.includes(id);
              const ok = !has && !settlement.builtThisTurn && p.ryo >= cost.ryo && p.supplies >= cost.supplies;
              return (
                <button key={id} type="button" disabled={!ok} onClick={() => props.onBuild(id, settlement.id)}>
                  <img src={`/sprites/buildings/${id}.png`} alt="" />
                  <strong>{d.name}</strong>
                  <small>{has ? "есть" : `${cost.ryo}р / ${cost.supplies}п`}</small>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {(state.missions?.length ?? 0) > 0 ? (
        <section className="block">
          <h3>Метки</h3>
          <ul className="missions">
            {state.missions.map((m) => (
              <li key={m.id}>
                <strong>{BALANCE.missions.kinds[m.kind].name}</strong>
                <span>
                  {m.q},{m.r} · {m.turnsLeft} ход.
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.battle && !state.battle.skipped ? (
        <section className="block battle-log">
          <div className="row">
            <h3>Бой</h3>
            <button type="button" onClick={props.onSkipBattle}>
              Пропустить
            </button>
          </div>
          <p className="meta">
            {state.battle.attackerName} против {state.battle.defenderName}
            {state.battle.result === "attacker"
              ? " — атака берёт поле"
              : state.battle.result === "defender"
                ? " — отбой"
                : " — ничья"}
          </p>
        </section>
      ) : null}

      {props.selected ? (
        <section className="block">
          <h3>Отряд</h3>
          <div className="stack-card">
            <img
              src={
                props.selected.playerId < 0
                  ? "/sprites/units/missing.png"
                  : props.selected.commanderId
                    ? `/sprites/commanders/${playerOf(state, props.selected.playerId)?.village ?? "leaf"}.png`
                    : `/sprites/units/${[...props.selected.units].sort((a, b) => b.count - a.count)[0]?.type ?? "genin"}.png`
              }
              alt=""
            />
          </div>
          <ul className="units">
            {props.selected.units.map((u) => (
              <li key={u.type}>
                {BALANCE.units.defs[u.type].name} ×{u.count}
                <small>
                  {STYLE_LABELS[BALANCE.units.defs[u.type].style]} · HP {u.hpTotal}
                </small>
              </li>
            ))}
          </ul>
          {props.selected.commanderId && selectedCmd ? (
            <p className="meta">
              Командир {BALANCE.commanders.defs[selectedCmd.defId as keyof typeof BALANCE.commanders.defs]?.name} · ур.{" "}
              {selectedCmd.level}
            </p>
          ) : null}
        </section>
      ) : null}

      {selectedCmd && human ? (
        <section className="block">
          <h3>
            {BALANCE.commanders.defs[selectedCmd.defId as keyof typeof BALANCE.commanders.defs]?.name} · навыки
            {skillPointsAvailable(selectedCmd) > 0 ? ` · ${skillPointsAvailable(selectedCmd)} очк.` : ""}
          </h3>
          {SKILL_BRANCHES.map((br) => (
            <button
              key={br}
              type="button"
              className="skill"
              disabled={skillPointsAvailable(selectedCmd) <= 0 || selectedCmd.skills[br] >= 5}
              onClick={() => props.onSkill(selectedCmd.id, br)}
            >
              <span>{br === "war" ? "Война" : br === "econ" ? "Экономика" : "Разведка"}</span>
              <em>
                {selectedCmd.skills[br]}/5 · {BALANCE.skills[br][Math.min(4, selectedCmd.skills[br])]?.name}
              </em>
            </button>
          ))}
          <button
            type="button"
            className={props.techMode ? "cta slim on" : "cta slim"}
            disabled={selectedCmd.cooldown > 0 || p.chakra < BALANCE.commanders.techChakra[BALANCE.commanders.defs[selectedCmd.defId as keyof typeof BALANCE.commanders.defs]!.tech as TechId]}
            onClick={props.onTech}
          >
            {TECH_LABELS[BALANCE.commanders.defs[selectedCmd.defId as keyof typeof BALANCE.commanders.defs]!.tech as TechId]}
            {selectedCmd.cooldown > 0 ? ` (${selectedCmd.cooldown})` : ""}
          </button>
        </section>
      ) : null}

      {human && state.turn >= BALANCE.commanders.secondHireTurn && !p.hiredSecond ? (
        <section className="block">
          <h3>Второй командир</h3>
          {Object.values(BALANCE.commanders.defs)
            .filter((d) => d.village === p.village && !p.commanders.some((c) => c.defId === d.id))
            .map((d) => (
              <button key={d.id} type="button" disabled={p.ryo < BALANCE.commanders.secondHireCostRyo} onClick={() => props.onHireCommander(d.id)}>
                {d.name} — {d.title} · {BALANCE.commanders.secondHireCostRyo} рё
              </button>
            ))}
        </section>
      ) : null}

      {human ? (
        <section className="block">
          <h3>Дипломатия</h3>
          {state.players
            .filter((o) => o.id !== p.id && o.alive)
            .map((o) => {
              const rel = relationOf(state, p.id, o.id);
              return (
                <div key={o.id} className="diplo">
                  <span>
                    {o.name} · {rel}
                  </span>
                  <div>
                    <button type="button" onClick={() => props.onDiplo(o.id, "nap")}>
                      Пакт
                    </button>
                    <button type="button" onClick={() => props.onDiplo(o.id, "trade")}>
                      Торг
                    </button>
                    <button type="button" onClick={() => props.onDiplo(o.id, "alliance")}>
                      Союз
                    </button>
                    <button type="button" onClick={() => props.onDiplo(o.id, "war")}>
                      Война
                    </button>
                    <button type="button" onClick={() => props.onDiplo(o.id, "break")}>
                      Разорвать
                    </button>
                  </div>
                </div>
              );
            })}
        </section>
      ) : null}

      <section className="block log">
        <h3>Летопись</h3>
        <ol>
          {state.log.slice(-8).reverse().map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </section>

      <div className="side-actions">
        <button type="button" className="cta" disabled={!human || state.phase === "gameover"} onClick={props.onEnd}>
          {idleN && human ? `Конец хода · ${idleN} ждут` : "Конец хода"}
        </button>
        <div className="row">
          <button type="button" onClick={props.onSave}>
            Сохранить
          </button>
          <button type="button" onClick={props.onExport}>
            Экспорт
          </button>
          <button type="button" onClick={props.onMute}>
            {props.muted ? "Звук" : "Тихо"}
          </button>
        </div>
      </div>
    </aside>
  );
}

function Res({ label, value, delta }: { label: string; value: number; delta?: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{Math.round(value)}</strong>
      {delta !== undefined ? (
        <small className="delta">
          {delta >= 0 ? "+" : ""}
          {delta}/ход
        </small>
      ) : null}
    </div>
  );
}

export function HexHint({ lines, x, y }: { lines: string[]; x: number; y: number }) {
  if (!lines.length) return null;
  return (
    <div className="tip" style={{ left: x + 14, top: y + 14 }}>
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

export function ForecastPanel(props: {
  winChance: number;
  ownLost: { min: number; max: number };
  enemyLost: { min: number; max: number };
  mods: string[];
  warn: boolean;
  x: number;
  y: number;
}) {
  const pct = Math.round(props.winChance * 100);
  return (
    <div
      className={`forecast ${props.warn ? "warn" : ""}`}
      style={{ left: props.x + 16, top: props.y + 16 }}
    >
      <p className="forecast-k">Прогноз боя · 100 симуляций</p>
      <p className={`forecast-win ${props.warn ? "bad" : ""}`}>Победа {pct}%</p>
      <ul>
        <li>
          Свои потери <b>{props.ownLost.min}–{props.ownLost.max}</b>
        </li>
        <li>
          Вражеские <b>{props.enemyLost.min}–{props.enemyLost.max}</b>
        </li>
      </ul>
      {props.warn ? <p className="forecast-warn">Низкий шанс — лучше обойти</p> : null}
      <ol>
        {props.mods.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ol>
    </div>
  );
}
