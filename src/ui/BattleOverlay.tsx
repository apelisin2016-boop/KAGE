import { useEffect, useMemo, useState } from "react";
import { BALANCE, TACTIC_IDS, TERRAIN_LABELS, type TacticId } from "@/game/balance";
import { sfx } from "@/game/audio";
import type { BattleLogLine, BattleRoster, BattleState, GameState } from "@/game/types";
import { viewingPlayer } from "@/game/rules";

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

function hpFrac(units: BattleRoster[], start: BattleRoster[]): number {
  const orig = start.length ? start : units;
  let hp = 0;
  let max = 0;
  for (const o of orig) {
    const d = BALANCE.units.defs[o.type];
    const u = units.find((x) => x.type === o.type) ?? o;
    hp += Math.max(0, u.hpTotal);
    if (d) max += d.hp * Math.max(1, o.count);
  }
  return max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
}

function SideChip(props: {
  name: string;
  village: string | null;
  units: BattleRoster[];
  start: BattleRoster[];
  tactic?: string | null;
  flash?: boolean;
}) {
  const v = props.village as keyof typeof BALANCE.colors.villages | null;
  const col = v ? BALANCE.colors.villages[v].accent : "#8b909c";
  const frac = hpFrac(props.units, props.start);
  return (
    <div className={`battle-chip${props.flash ? " hit" : ""}`} style={{ ["--v" as string]: col }}>
      <strong>{props.name}</strong>
      {props.tactic ? <em>{props.tactic}</em> : null}
      <i className="hp">
        <b style={{ width: `${frac * 100}%` }} />
      </i>
    </div>
  );
}

export function BattleOverlay(props: {
  state: GameState;
  battle: BattleState;
  reduced: boolean;
  onClose: () => void;
  onChoose: (tactic: TacticId, techRound: number | null) => void;
  onContinue: () => void;
  onRetreat: () => void;
  onStrike?: (idx: number, line: BattleLogLine | null) => void;
}) {
  const { battle } = props;
  const log = battle.log;
  const humanId = viewingPlayer(props.state);
  const mine = battle.attackerId === humanId || battle.defenderId === humanId;
  const iAmAtk = battle.attackerId === humanId;
  const iAmDef = battle.defenderId === humanId;
  const phase = battle.battlePhase ?? (battle.done ? "done" : "playing");
  const scoutRank = (() => {
    const p = props.state.players.find((x) => x.id === humanId);
    if (!p) return 0;
    return Math.max(0, ...p.commanders.map((c) => c.skills.scout));
  })();
  const seeEnemy = scoutRank >= BALANCE.combat.scoutRevealRank;
  const waitId = battle.waitingFor === "defender" ? battle.defenderId : battle.attackerId;
  const waiter = props.state.players.find((p) => p.id === waitId);
  const waitingMine = phase === "tactics" && waiter?.difficulty === "human";

  const [idx, setIdx] = useState(0);
  const [techRound, setTechRound] = useState<number | null>(battle.techReady ? 1 : null);
  const stepMs = props.reduced ? 90 : mine ? BALANCE.fx.hitStepMs : 280;

  useEffect(() => {
    setIdx(0);
  }, [battle.attackerStackId, battle.defenderStackId, battle.fromQ, battle.fromR]);

  useEffect(() => {
    if (phase === "tactics") return;
    if (idx >= log.length - 1) return;
    const t = window.setTimeout(() => setIdx((i) => Math.min(log.length - 1, i + 1)), stepMs);
    return () => window.clearTimeout(t);
  }, [idx, log.length, phase, stepMs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (phase === "tactics") return;
      if (idx >= log.length - 1) return;
      e.preventDefault();
      setIdx(Math.max(0, log.length - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, idx, log.length]);

  useEffect(() => {
    const line = log[idx] ?? null;
    props.onStrike?.(idx, line);
    if (line?.kind === "hit") sfx.hit();
    if (line?.kind === "tech") sfx.tech();
  }, [idx, log]);

  const line = log[idx] ?? log[log.length - 1];
  const played = phase === "tactics" ? -1 : idx;
  const aUnits = useMemo(
    () => (phase === "tactics" ? cloneRoster(battle.startA) : rosterAt(battle.startA, log, Math.max(0, played), "a")),
    [battle.startA, log, played, phase],
  );
  const dUnits = useMemo(
    () => (phase === "tactics" ? cloneRoster(battle.startD) : rosterAt(battle.startD, log, Math.max(0, played), "d")),
    [battle.startD, log, played, phase],
  );
  const logDone = phase !== "tactics" && (log.length === 0 || idx >= log.length - 1);
  const flashA = line?.kind === "hit" && line.side === "d";
  const flashD = line?.kind === "hit" && line.side === "a";
  const showRetreat = phase === "retreat" && logDone && iAmAtk && !battle.done;
  const showResult = battle.done && logDone;

  const resultText =
    battle.result === "attacker"
      ? "Атака берёт поле"
      : battle.result === "defender"
        ? "Защита устояла"
        : battle.result === "retreat"
          ? "Атака отступила"
          : "Ничья — оба отступают";

  const enemyTactic = iAmAtk ? battle.defenderTactic : battle.attackerTactic;
  const enemyName = iAmAtk
    ? seeEnemy
      ? enemyTactic
        ? BALANCE.combat.tactics[enemyTactic].name
        : "…"
      : "скрыто"
    : iAmDef
      ? seeEnemy
        ? enemyTactic
          ? BALANCE.combat.tactics[enemyTactic].name
          : "…"
        : "скрыто"
      : null;

  const atkTac =
    battle.attackerTactic && (seeEnemy || iAmAtk || battle.done)
      ? BALANCE.combat.tactics[battle.attackerTactic].name
      : battle.attackerTactic
        ? "скрыто"
        : null;
  const defTac =
    battle.defenderTactic && (seeEnemy || iAmDef || battle.done)
      ? BALANCE.combat.tactics[battle.defenderTactic].name
      : battle.defenderTactic
        ? "скрыто"
        : null;

  const mode = phase === "tactics" ? "tactics" : showResult || showRetreat ? "result" : "play";

  return (
    <div className={`battle-dock ${mode}`} role="dialog" aria-label="Бой на карте">
      <header className="battle-dock-top">
        <span>
          {phase === "tactics"
            ? waitingMine
              ? "Тактика"
              : "Противник выбирает"
            : `Раунд ${line?.round || 1}`}
        </span>
        <div className="arena-mods">
          {(battle.mods ?? [TERRAIN_LABELS[battle.terrain ?? "plains"]]).map((m) => (
            <em key={m}>{m}</em>
          ))}
        </div>
        {phase !== "tactics" && !logDone ? (
          <button type="button" onClick={() => setIdx(Math.max(0, log.length - 1))}>
            Пропустить
          </button>
        ) : battle.done ? (
          <button type="button" onClick={props.onClose}>
            Дальше
          </button>
        ) : null}
      </header>

      <div className="battle-strip">
        <SideChip
          name={battle.attackerName ?? "Атака"}
          village={battle.attackerVillage ?? null}
          units={aUnits}
          start={battle.startA ?? aUnits}
          tactic={atkTac}
          flash={!!flashA}
        />
        <SideChip
          name={battle.defenderName ?? "Защита"}
          village={battle.defenderVillage ?? null}
          units={dUnits}
          start={battle.startD ?? dUnits}
          tactic={defTac}
          flash={!!flashD}
        />
      </div>

      {phase === "tactics" && waitingMine ? (
        <div className="tactics">
          {enemyName ? <p className="arena-hint">Противник: {enemyName}</p> : null}
          <div className="tactic-row">
            {TACTIC_IDS.map((id) => {
              const t = BALANCE.combat.tactics[id];
              return (
                <button
                  key={id}
                  type="button"
                  className="tactic"
                  onClick={() => {
                    sfx.click();
                    props.onChoose(id, battle.techReady ? techRound : null);
                  }}
                >
                  <strong>{t.name}</strong>
                  <small>{t.text}</small>
                </button>
              );
            })}
          </div>
          {battle.techReady ? (
            <div className="tech-pick">
              <p>
                {battle.techReady.name} · {battle.techReady.cost} чакры
              </p>
              <div className="tech-rounds">
                <button type="button" className={techRound === null ? "on" : ""} onClick={() => setTechRound(null)}>
                  Без техники
                </button>
                {Array.from({ length: 4 }, (_, i) => i + 1).map((r) => (
                  <button key={r} type="button" className={techRound === r ? "on" : ""} onClick={() => setTechRound(r)}>
                    Раунд {r}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : phase === "tactics" ? (
        <p className="strike note">Ждём выбор тактики…</p>
      ) : (
        <>
          {line?.kind === "hit" ? (
            <p className="strike float">
              <strong>−{line.dmg}</strong>
              <span>{line.text}</span>
            </p>
          ) : line?.kind === "tech" ? (
            <p className="strike note tech-flash">{line.text}</p>
          ) : (
            <p className="strike note">{line?.text ?? "Схватка на клетке"}</p>
          )}
          {showResult ? <p className="arena-result">{resultText}</p> : null}
          {showRetreat ? (
            <div className="retreat-row">
              <p>Первый раунд. Отойти на исходный гекс?</p>
              <button type="button" className="ghost" onClick={props.onRetreat}>
                Отступить
                {battle.attackerTactic === "defend"
                  ? " без потерь"
                  : ` (−${Math.round(BALANCE.combat.retreatLoss * 100)}%)`}
              </button>
              <button type="button" className="arena-go" onClick={props.onContinue}>
                Продолжить бой
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
