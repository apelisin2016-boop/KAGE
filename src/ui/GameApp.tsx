import { useCallback, useEffect, useRef, useState } from "react";
import { BALANCE, FACTION_BUDGET, VILLAGE_IDS } from "@/game/balance";
import { botUntilHuman } from "@/game/ai";
import { sfx, setMuted, unlockAudio, isMuted } from "@/game/audio";
import { hexKey, hexToPixel } from "@/game/hex";
import { applyCommand, approachHex, attackForecast, attackTargets, currentIsHuman, hydrateVision, playerOf, pathTo, reachable, stacksAt, viewingPlayer, visionSet } from "@/game/rules";
import { downloadSave, deserialize, loadLocal, saveLocal } from "@/game/save";
import { simBattles, simMatches, type BattleSimResult, type MatchSimResult } from "@/game/sim";
import type { BattleLogLine, Command, GameSetup, GameState, Stack } from "@/game/types";
import type { FightForecast } from "@/game/combat";
import { GameGuard } from "@/lib/error-component";
import { HexHint, ForecastPanel, SidePanel } from "./SidePanel";
import { SetupScreen } from "./SetupScreen";
import { BattleOverlay } from "./BattleOverlay";
import { bustGround, battleHitFx, combatHpFromLog, drawFrame, drawMinimap, eventsToFx, fitCamera, minimapToWorld, panToWorld, screenToHex, tooltipText, type Camera, type CombatPose, type Fx, type MoveAnim, type View } from "./render";
import { loadSprites } from "./sprites";

type Screen = "setup" | "play" | "sim";

function focusPlay(st: GameState, el: HTMLElement, scale = 1.55): Camera {
  const pid = viewingPlayer(st);
  const stack = st.stacks.find((s) => s.playerId === pid && s.commanderId && !s.garrison);
  const cap = st.settlements.find((s) => s.capitalOf === pid);
  const b = st.battle;
  let q = stack?.q ?? cap?.q;
  let r = stack?.r ?? cap?.r;
  if (st.setup?.training && b) {
    q = b.hexQ;
    r = b.hexR;
    scale = 1.7;
  }
  if (q === undefined || r === undefined) return fitCamera(st, el.clientWidth, el.clientHeight);
  const p = hexToPixel({ q, r }, BALANCE.map.hexSize);
  return panToWorld(st, p.x, p.y, el.clientWidth, el.clientHeight, scale);
}

export function GameApp() {
  const [epoch, setEpoch] = useState(0);
  return (
    <GameGuard key={epoch} onReset={() => setEpoch((n) => n + 1)}>
      <GamePlay />
    </GameGuard>
  );
}

function GamePlay() {
  const [screen, setScreen] = useState<Screen>("setup");
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [techMode, setTechMode] = useState(false);
  const [focusHex, setFocusHex] = useState<{ q: number; r: number } | null>(null);
  const [tip, setTip] = useState<{ lines: string[]; x: number; y: number } | null>(null);
  const [forecast, setForecast] = useState<FightForecast | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [muted, setMutedState] = useState(false);
  const [help, setHelp] = useState(false);
  const [banner, setBanner] = useState<{
    turn: number;
    name: string;
    ryo: number;
    supplies: number;
    chakra: number;
  } | null>(null);
  const [coach, setCoach] = useState<"select" | "act" | "hire" | "end" | "off">("off");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const fxRef = useRef<Fx[]>([]);
  const combatRef = useRef<CombatPose | null>(null);
  const strikeKey = useRef("");
  const movesRef = useRef<MoveAnim[]>([]);
  const shake = useRef(0);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const panned = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const techRef = useRef(techMode);
  techRef.current = techMode;
  const hoverRef = useRef<{ q: number; r: number } | null>(null);
  const hoverKey = useRef("");
  const reachRef = useRef<{ id: string; turn: number; set: Set<string>; atk: Set<string> } | null>(null);
  const pathCache = useRef<{ key: string; path: { q: number; r: number }[] }>({ key: "", path: [] });
  const forecastCache = useRef<{ key: string; f: FightForecast | null }>({ key: "", f: null });
  const keys = useRef<Record<string, boolean>>({});
  const botLock = useRef(false);
  const pendingBots = useRef(false);
  const reduced = useRef(false);
  const ctx2d = useRef<CanvasRenderingContext2D | null>(null);
  const saveTimer = useRef(0);
  const battleTimer = useRef(0);
  const endArmed = useRef(false);
  const bannerKey = useRef("");
  const [showBattle, setShowBattle] = useState(false);
  const queueSave = (s: GameState) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveLocal(s), 700);
  };

  const dismissCoach = () => {
    setCoach("off");
    try {
      localStorage.setItem("kage.coach.v1", "1");
    } catch {
      /* ignore */
    }
  };

  const focusIdle = (st: GameState) => {
    const mine = st.stacks.filter((s) => s.playerId === st.currentPlayer && !s.garrison && !s.moved);
    if (!mine.length) return;
    const i = mine.findIndex((s) => s.id === selectedRef.current);
    const nxt = mine[(i + 1) % mine.length]!;
    setSelected(nxt.id);
    const el = wrapRef.current;
    if (el) {
      const p = hexToPixel(nxt, BALANCE.map.hexSize);
      cam.current = panToWorld(st, p.x, p.y, el.clientWidth, el.clientHeight, Math.max(cam.current.scale, 0.85));
    }
  };

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      if (localStorage.getItem("kage.coach.v1") !== "1") setCoach("select");
    } catch {
      setCoach("select");
    }
    void loadSprites().then(() => bustGround());
    const onErr = (e: ErrorEvent) => {
      console.error(e.error ?? e.message);
      setError(e.message || "Сбой отрисовки");
    };
    const onRej = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "Сбой");
      console.error(e.reason);
      setError(msg);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  useEffect(() => {
    if (!showBattle) {
      combatRef.current = null;
      return;
    }
    const st = stateRef.current;
    const b = st?.battle;
    const el = wrapRef.current;
    if (!st || !b || !el) return;
    combatRef.current = {
      atkId: b.attackerStackId,
      defId: b.defenderStackId,
      t0: performance.now(),
      dur: 1,
      side: null,
      ...combatHpFromLog(b, -1),
    };
    const a = hexToPixel({ q: b.fromQ ?? b.hexQ, r: b.fromR ?? b.hexR }, BALANCE.map.hexSize);
    const d = hexToPixel({ q: b.hexQ, r: b.hexR }, BALANCE.map.hexSize);
    cam.current = panToWorld(
      st,
      (a.x + d.x) / 2,
      (a.y + d.y) / 2,
      el.clientWidth,
      el.clientHeight,
      Math.max(cam.current.scale, 1.62),
    );
  }, [showBattle, state?.battle?.attackerStackId, state?.battle?.hexQ]);

  useEffect(() => {
    if (screen !== "play" || !state) return;
    if (state.setup?.training) return;
    if (!currentIsHuman(state)) return;
    const key = `${state.turn}:${state.currentPlayer}`;
    if (bannerKey.current === key) return;
    bannerKey.current = key;
    const pl = playerOf(state, state.currentPlayer);
    if (!pl?.lastIncome) return;
    if (!pl.lastIncome.ryo && !pl.lastIncome.supplies && !pl.lastIncome.chakra) return;
    setBanner({ turn: state.turn, name: pl.name, ...pl.lastIncome });
  }, [state, screen]);

  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 3200);
    return () => window.clearTimeout(t);
  }, [banner]);

  useEffect(() => {
    if (coach === "off" || screen !== "play" || !state || state.setup?.training) return;
    if (coach === "select" && selected) setCoach("act");
    else if (coach === "act" && state.stacks.some((s) => s.playerId === state.currentPlayer && s.moved)) setCoach("hire");
    else if (coach === "hire" && (playerOf(state, state.currentPlayer)?.hiredThisTurn ?? 0) > 0) setCoach("end");
  }, [coach, selected, state, screen]);

  const dispatch = useCallback((cmd: Command, opts?: { silent?: boolean }) => {
    const cur = stateRef.current;
    let res: ReturnType<typeof applyCommand>;
    try {
      res = applyCommand(cur, cmd);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Сбой команды");
      if (!opts?.silent) sfx.error();
      return cur;
    }
    if (res.error) {
      setError(res.error);
      if (!opts?.silent) sfx.error();
      return res.state;
    }
    setError(null);
    const now = performance.now();
    const converted = eventsToFx(res.events, now, reduced.current);
    fxRef.current = [...fxRef.current, ...converted.fx].slice(-80);
    movesRef.current = [...movesRef.current, ...converted.moves];
    const hasBattle = res.events.some((e) => e.kind === "battle") && res.state.battle?.battlePhase !== "tactics";
    const walkMs = converted.moves.reduce((m, x) => Math.max(m, x.life), 0);
    window.clearTimeout(battleTimer.current);
    if (res.state.battle && !res.state.battle.skipped) {
      if (walkMs > 40 && !reduced.current) {
        setShowBattle(false);
        battleTimer.current = window.setTimeout(() => {
          setShowBattle(true);
          if (hasBattle) {
            shake.current = Math.min(1, shake.current + 0.5);
            sfx.hit();
          }
        }, walkMs);
      } else {
        setShowBattle(true);
        if (hasBattle) {
          shake.current = Math.min(1, shake.current + 0.45);
          sfx.hit();
        }
      }
    } else {
      setShowBattle(false);
    }
    if (res.events.some((e) => e.kind === "move")) sfx.move();
    if (res.events.some((e) => e.kind === "flash") && cmd.type === "TECHNIQUE") sfx.tech();
    if (res.events.some((e) => e.kind === "turn")) sfx.turn();
    if (res.events.some((e) => e.kind === "win")) sfx.win();
    if (cmd.type === "MOVE" || cmd.type === "ATTACK" || cmd.type === "HIRE") endArmed.current = false;
    setState(res.state);
    queueSave(res.state);
    return res.state;
  }, []);

  const startGame = (setup: GameSetup) => {
    unlockAudio();
    const res = applyCommand(null, { type: "NEW_GAME", payload: setup });
    if (res.error) {
      setError(res.error);
      sfx.error();
      return;
    }
    setState(res.state);
    setSelected(null);
    setScreen("play");
    setError(null);
    setShowBattle(false);
    saveLocal(res.state);
    bannerKey.current = "";
    endArmed.current = false;
    if (coach !== "off") setCoach("select");
    requestAnimationFrame(() => {
      const el = wrapRef.current;
      if (el && res.state) cam.current = focusPlay(res.state, el, 1.55);
    });
    if (res.state && !currentIsHuman(res.state)) {
      window.setTimeout(() => runBots(res.state), 240);
    }
  };

  const startTraining = () => {
    unlockAudio();
    const res = applyCommand(null, { type: "TRAINING" });
    if (res.error) {
      setError(res.error);
      sfx.error();
      return;
    }
    setState(res.state);
    setSelected(null);
    setScreen("play");
    setError(null);
    setShowBattle(true);
    requestAnimationFrame(() => {
      const el = wrapRef.current;
      if (el && res.state) cam.current = focusPlay(res.state, el, 1.7);
    });
  };

  const runBots = (from: GameState) => {
    if (botLock.current) return;
    botLock.current = true;
    let s = from;
    const step = () => {
      try {
        if (s.phase === "gameover" || currentIsHuman(s)) {
          botLock.current = false;
          pendingBots.current = false;
          setState(s);
          saveLocal(s);
          return;
        }
        const next = botUntilHuman(s, 1);
        s = next;
        setState(next);
        if (next.battle && !next.battle.skipped) {
          botLock.current = false;
          pendingBots.current = true;
          return;
        }
        window.setTimeout(step, 0);
      } catch (e) {
        botLock.current = false;
        pendingBots.current = false;
        setError(e instanceof Error ? e.message : "Сбой бота");
        setState(s);
      }
    };
    step();
  };

  const closeBattle = () => {
    window.clearTimeout(battleTimer.current);
    setShowBattle(false);
    const st = stateRef.current;
    if (!st?.battle) {
      if (pendingBots.current && st) runBots(st);
      return;
    }
    if (!st.battle.done) return;
    if (st.setup?.training) {
      const next = applyCommand(st, { type: "SKIP_BATTLE" });
      setState(next.state);
      setShowBattle(false);
      setScreen("setup");
      return;
    }
    if (st.battle.skipped) {
      if (pendingBots.current) runBots(st);
      return;
    }
    const next = applyCommand(st, { type: "SKIP_BATTLE" });
    setState(next.state);
    queueSave(next.state);
    if (pendingBots.current && next.state.phase !== "gameover" && !currentIsHuman(next.state)) {
      window.setTimeout(() => runBots(next.state), 40);
    }
  };

  const endTurn = () => {
    const cur = stateRef.current;
    if (movesRef.current.length) return;
    if (cur?.battle && !cur.battle.done) return;
    if (cur?.battle && !cur.battle.skipped) {
      closeBattle();
      return;
    }
    if (cur && currentIsHuman(cur)) {
      const idle = cur.stacks.filter((s) => s.playerId === cur.currentPlayer && !s.garrison && !s.moved);
      if (idle.length && !endArmed.current) {
        endArmed.current = true;
        setError(`Ещё ${idle.length} не ходили. Конец хода ещё раз — подтвердить.`);
        focusIdle(cur);
        sfx.error();
        return;
      }
    }
    endArmed.current = false;
    if (coach !== "off") dismissCoach();
    const s = dispatch({ type: "END_TURN" });
    setSelected(null);
    setTechMode(false);
    if (s && s.phase !== "gameover" && !currentIsHuman(s)) {
      window.setTimeout(() => runBots(s), 0);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || screen !== "play") return;
    if (!ctx2d.current || ctx2d.current.canvas !== canvas) {
      ctx2d.current = canvas.getContext("2d", { alpha: false });
    }
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, Math.min(wrap.clientHeight, window.innerHeight));
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }
      const panSpeed = 420 * dt;
      if (keys.current.KeyA || keys.current.ArrowLeft) cam.current.x += panSpeed;
      if (keys.current.KeyD || keys.current.ArrowRight) cam.current.x -= panSpeed;
      if (keys.current.KeyW || keys.current.ArrowUp) cam.current.y += panSpeed;
      if (keys.current.KeyS || keys.current.ArrowDown) cam.current.y -= panSpeed;

      shake.current = Math.max(0, shake.current - 0.018);
      fxRef.current = fxRef.current.filter((f) => now - f.born < f.life);
      movesRef.current = movesRef.current.filter((m) => now - m.born < m.life);
      const st = stateRef.current;
      if (st) {
        const selId = selectedRef.current;
        const stack = selId ? st.stacks.find((s) => s.id === selId) ?? null : null;
        let reach = reachRef.current;
        if (!stack || stack.moved || stack.playerId !== st.currentPlayer) {
          reach = { id: "", turn: st.turn, set: new Set(), atk: new Set() };
          reachRef.current = reach;
        } else if (!reach || reach.id !== stack.id || reach.turn !== st.turn) {
          const set = new Set<string>();
          for (const k of reachable(st, stack).keys()) {
            if (k !== hexKey(stack.q, stack.r)) set.add(k);
          }
          reach = { id: stack.id, turn: st.turn, set, atk: attackTargets(st, stack) };
          reachRef.current = reach;
        }
        const hover = hoverRef.current;
        let path: { q: number; r: number }[] = [];
        if (stack && hover && !stack.moved) {
          const hk = hexKey(hover.q, hover.r);
          if (reach.atk.has(hk)) {
            const ap = approachHex(st, stack, hover);
            if (ap && (ap.q !== stack.q || ap.r !== stack.r)) {
              const pk = `${stack.id}:atk:${ap.q},${ap.r}`;
              if (pathCache.current.key !== pk) {
                pathCache.current = { key: pk, path: pathTo(st, stack, ap) };
              }
              path = pathCache.current.path;
            }
          } else if (reach.set.has(hk)) {
            const pk = `${stack.id}:${hover.q},${hover.r}`;
            if (pathCache.current.key !== pk) {
              pathCache.current = { key: pk, path: pathTo(st, stack, hover) };
            }
            path = pathCache.current.path;
          }
        }
        const view: View = {
          camera: cam.current,
          hover,
          selected: selId,
          reachable: reach.set,
          attackable: reach.atk,
          path,
          fx: fxRef.current,
          moves: movesRef.current,
          now,
          reduced: reduced.current,
          shake: shake.current,
          techAim: techRef.current,
          combat: combatRef.current,
        };
        const ctx = ctx2d.current;
        if (ctx) {
          try {
            drawFrame(ctx, st, view, w, h, dpr);
          } catch (err) {
            console.error(err);
          }
        }
        const mini = miniRef.current;
        if (mini) {
          const mw = Math.max(1, mini.clientWidth || 168);
          const mh = Math.max(1, mini.clientHeight || 118);
          if (mini.width !== Math.floor(mw * dpr) || mini.height !== Math.floor(mh * dpr)) {
            mini.width = Math.floor(mw * dpr);
            mini.height = Math.floor(mh * dpr);
          }
          const mctx = mini.getContext("2d");
          if (mctx) {
            try {
              drawMinimap(mctx, st, cam.current, w, h, mw, mh, dpr);
            } catch {
              /* keep looping */
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [screen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || screen !== "play") return;
    const onClick = (e: MouseEvent) => {
      if (panned.current) {
        panned.current = false;
        return;
      }
      handleHexAction(e.clientX, e.clientY);
    };
    canvas.addEventListener("click", onClick);
    return () => canvas.removeEventListener("click", onClick);
  }, [screen, dispatch]);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden && stateRef.current) saveLocal(stateRef.current);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (screen !== "play") return;
    const zoomAt = (factor: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const sx = el.clientWidth / 2;
      const sy = el.clientHeight / 2;
      const next = Math.min(2.9, Math.max(0.42, cam.current.scale * factor));
      const k = next / cam.current.scale;
      cam.current = { scale: next, x: sx - (sx - cam.current.x) * k, y: sy - (sy - cam.current.y) * k };
    };
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      keys.current[e.code] = true;
      const st = stateRef.current;
      if (!st) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (st.battle && !st.battle.skipped) {
          if (st.battle.done) closeBattle();
          return;
        }
        if (currentIsHuman(st) && st.phase !== "gameover") endTurn();
      } else if (e.code === "Escape") {
        setSelected(null);
        setTechMode(false);
      } else if (e.code === "KeyF") {
        const el = wrapRef.current;
        if (el) cam.current = fitCamera(st, el.clientWidth, el.clientHeight);
      } else if (e.code === "KeyC" || e.code === "Home") {
        const cap = st.settlements.find((s) => s.capitalOf === st.currentPlayer && s.owner === st.currentPlayer);
        const el = wrapRef.current;
        if (cap && el) {
          const p = hexToPixel(cap, BALANCE.map.hexSize);
          cam.current = panToWorld(st, p.x, p.y, el.clientWidth, el.clientHeight, cam.current.scale);
        }
      } else if (e.code === "Tab") {
        e.preventDefault();
        focusIdle(st);
      } else if (e.code === "Equal" || e.code === "NumpadAdd") {
        zoomAt(1.12);
      } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
        zoomAt(0.9);
      }
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [screen]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false };
    panned.current = false;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      onPointerMoveInner(e);
    } catch (err) {
      console.error(err);
    }
  };

  const onPointerMoveInner = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const st = stateRef.current;
    if (!canvas || !st) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (drag.current) {
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      if (Math.hypot(dx, dy) > 12) {
        drag.current.moved = true;
        panned.current = true;
      }
      if (drag.current.moved) {
        cam.current = { ...cam.current, x: drag.current.cx + dx, y: drag.current.cy + dy };
      }
    }
    const hex = screenToHex(cam.current, sx, sy);
    const k = hexKey(hex.q, hex.r);
    if (st.hexes[k]) {
      if (hoverKey.current !== k) {
        hoverKey.current = k;
        hoverRef.current = hex;
        setTip({ lines: tooltipText(st, hex), x: sx, y: sy });
        let f: FightForecast | null = null;
        const sel = selectedRef.current;
        const stack = sel ? st.stacks.find((s) => s.id === sel) : undefined;
        if (
          stack &&
          currentIsHuman(st) &&
          stack.playerId === st.currentPlayer &&
          !stack.moved &&
          !stack.garrison
        ) {
          const reach = reachRef.current;
          if (reach && reach.id === stack.id && reach.atk.has(k)) {
            const ck = `${stack.id}:${k}:${st.turn}:${stack.units.map((u) => `${u.type}${u.count}${u.hpTotal}`).join(",")}`;
            if (forecastCache.current.key !== ck) {
              forecastCache.current = { key: ck, f: attackForecast(st, stack, hex.q, hex.r) };
            }
            f = forecastCache.current.f;
            setTip({
              lines: ["Клик — атака с соседней клетки", ...tooltipText(st, hex)],
              x: sx,
              y: sy,
            });
          }
        }
        setForecast(f);
      }
    } else if (hoverKey.current) {
      hoverKey.current = "";
      hoverRef.current = null;
      setTip(null);
      setForecast(null);
    }
  };

  const handleHexAction = (clientX: number, clientY: number) => {
    try {
      handleHexActionInner(clientX, clientY);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Сбой клика");
    }
  };

  const handleHexActionInner = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const st = stateRef.current;
    if (!canvas || !st) return;
    if (!currentIsHuman(st) || st.phase === "gameover") return;
    if (st.battle && !st.battle.done) return;
    if (st.battle && !st.battle.skipped) return;
    if (movesRef.current.length) return;
    const rect = canvas.getBoundingClientRect();
    const hex = screenToHex(cam.current, clientX - rect.left, clientY - rect.top);
    if (!st.hexes[hexKey(hex.q, hex.r)]) return;
    unlockAudio();
    setFocusHex(hex);

    if (techRef.current && selectedRef.current) {
      const stack = st.stacks.find((s) => s.id === selectedRef.current);
      if (stack?.commanderId) {
        dispatch({ type: "TECHNIQUE", payload: { commanderId: stack.commanderId, q: hex.q, r: hex.r } });
      }
      setTechMode(false);
      return;
    }

    const vis = visionSet(st, st.currentPlayer);
    const here = stacksAt(st, hex.q, hex.r).filter((s) => {
      if (s.playerId === st.currentPlayer) return true;
      return vis.has(hexKey(s.q, s.r));
    });
    const mine = here.find((s) => s.playerId === st.currentPlayer && !s.garrison);
    if (selectedRef.current) {
      const stack = st.stacks.find((s) => s.id === selectedRef.current);
      if (stack && (stack.q !== hex.q || stack.r !== hex.r) && !stack.moved) {
        const atk = attackTargets(st, stack);
        if (atk.has(hexKey(hex.q, hex.r))) {
          dispatch({ type: "ATTACK", payload: { stackId: stack.id, q: hex.q, r: hex.r } });
          setSelected(stack.id);
          return;
        }
        const reach = reachable(st, stack);
        if (reach.has(hexKey(hex.q, hex.r))) {
          dispatch({ type: "MOVE", payload: { stackId: stack.id, q: hex.q, r: hex.r } });
          setSelected(stack.id);
          return;
        }
      }
    }
    if (mine) {
      setSelected(mine.id);
      sfx.select();
    } else if (here[0]) {
      setSelected(here[0].id);
      sfx.select();
    } else {
      setSelected(null);
    }
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    const next = Math.min(2.9, Math.max(0.42, cam.current.scale * factor));
    const k = next / cam.current.scale;
    cam.current = {
      scale: next,
      x: sx - (sx - cam.current.x) * k,
      y: sy - (sy - cam.current.y) * k,
    };
  };

  const selectedStack: Stack | null = (() => {
    if (!state) return null;
    const st = state.stacks.find((s) => s.id === selected) ?? null;
    if (!st) return null;
    if (st.playerId === state.currentPlayer) return st;
    if (!visionSet(state, viewingPlayer(state)).has(hexKey(st.q, st.r))) return null;
    return st;
  })();

  if (screen === "setup") {
    return (
      <SetupScreen
        error={error}
        onStart={startGame}
        onContinue={() => {
          const s = loadLocal();
          if (!s) {
            setError("Нет сохранения");
            return;
          }
          hydrateVision(s);
          setState(s);
          setScreen("play");
          requestAnimationFrame(() => {
            const el = wrapRef.current;
            if (el) cam.current = focusPlay(s, el, 1.5);
          });
        }}
        onSim={() => setScreen("sim")}
        onTrain={startTraining}
      />
    );
  }

  if (screen === "sim") {
    return <SimScreen onBack={() => setScreen("setup")} />;
  }

  if (!state) return <SetupScreen error={error} onStart={startGame} onContinue={() => undefined} onSim={() => setScreen("sim")} onTrain={startTraining} />;

  const p = playerOf(state, state.currentPlayer);

  return (
    <div className="play grid h-dvh max-h-dvh overflow-hidden grid-cols-1 grid-rows-[1fr_auto] lg:grid-cols-[1fr_minmax(280px,340px)] lg:grid-rows-none">
      <div className="map-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={forecast ? "map-canvas attack-cursor" : "map-canvas"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onClick={(e) => {
            if (state.battle && !state.battle.skipped) return;
            if (panned.current) {
              panned.current = false;
              return;
            }
            handleHexAction(e.clientX, e.clientY);
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onWheel={onWheel}
        />
        {forecast && tip && !showBattle ? (
          <ForecastPanel
            winChance={forecast.winChance}
            ownLost={forecast.ownLost}
            enemyLost={forecast.enemyLost}
            mods={forecast.mods}
            warn={forecast.warn}
            x={tip.x}
            y={tip.y}
          />
        ) : tip ? (
          <HexHint lines={tip.lines} x={tip.x} y={tip.y} />
        ) : null}
        <canvas
          ref={miniRef}
          className="minimap"
          width={168}
          height={118}
          aria-label="Миникарта"
          onPointerDown={(e) => {
            const st = stateRef.current;
            const el = wrapRef.current;
            const mini = miniRef.current;
            if (!st || !el || !mini) return;
            const rect = mini.getBoundingClientRect();
            const world = minimapToWorld(st, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
            cam.current = panToWorld(st, world.x, world.y, el.clientWidth, el.clientHeight, cam.current.scale);
          }}
        />
        {state.battle && !state.battle.skipped && showBattle ? (
          <BattleOverlay
            state={state}
            battle={state.battle}
            reduced={reduced.current}
            onClose={closeBattle}
            onStrike={(idx, line) => {
              const b = stateRef.current?.battle;
              if (!b) return;
              const key = `${b.attackerStackId}:${idx}:${line?.kind ?? ""}:${line?.dmg ?? ""}`;
              combatRef.current = {
                atkId: b.attackerStackId,
                defId: b.defenderStackId,
                t0: performance.now(),
                dur: reduced.current ? 90 : BALANCE.fx.hitStepMs,
                side: line?.side ?? "a",
                ...combatHpFromLog(b, idx),
              };
              if (strikeKey.current === key) return;
              strikeKey.current = key;
              if (line && (line.kind === "hit" || line.kind === "tech")) {
                const extra = battleHitFx(line, b, performance.now());
                fxRef.current = [...fxRef.current, ...extra].slice(-80);
                shake.current = Math.min(1, shake.current + (line.kind === "hit" ? 0.55 : 0.3));
              }
            }}
            onChoose={(tactic, techRound) => {
              dispatch({ type: "BATTLE_CHOOSE", payload: { tactic, techRound } });
              sfx.click();
            }}
            onContinue={() => dispatch({ type: "BATTLE_CONTINUE" })}
            onRetreat={() => dispatch({ type: "BATTLE_RETREAT" })}
          />
        ) : null}
        <div className="hud-tl">
          <span>
            {p ? `${BALANCE.colors.villages[p.village].kanji} ${p.name}` : ""} · ход {state.turn}
          </span>
          <div className="village-legend" aria-label="Деревни">
            {state.players.filter((pl) => pl.alive).map((pl) => (
              <span key={pl.id} className="legend-chip" title={pl.name}>
                <img src={`/sprites/${pl.commanders[0] ? "commanders" : "units"}/${pl.village}.png`} alt="" />
                <i style={{ background: BALANCE.colors.villages[pl.village].accent }} />
                {BALANCE.villages[pl.village].name}
              </span>
            ))}
          </div>
          <button type="button" className="mobile-only" onClick={() => setPanelOpen((v) => !v)}>
            Панель
          </button>
        </div>
        {p && currentIsHuman(state) && !state.setup?.training ? (
          <div className="hud-tr">
            <span className="hud-chip">
              Рё <b>{Math.round(p.ryo)}</b>
            </span>
            <span className="hud-chip">
              Припасы <b>{Math.round(p.supplies)}</b>
            </span>
            <span className="hud-chip">
              Чакра <b>{Math.round(p.chakra)}</b>
            </span>
            {state.stacks.some((s) => s.playerId === p.id && !s.garrison && !s.moved) ? (
              <button type="button" className="hud-chip warn" onClick={() => focusIdle(state)}>
                {state.stacks.filter((s) => s.playerId === p.id && !s.garrison && !s.moved).length} не ходили
              </button>
            ) : (
              <span className="hud-chip ok">все ходили</span>
            )}
          </div>
        ) : null}
        {banner && !showBattle ? (
          <button type="button" className="turn-banner" onClick={() => setBanner(null)}>
            <p className="kicker">Ход {banner.turn}</p>
            <strong>{banner.name}</strong>
            <ul>
              <li>
                {banner.ryo >= 0 ? "+" : ""}
                {banner.ryo} рё
              </li>
              <li>
                {banner.supplies >= 0 ? "+" : ""}
                {banner.supplies} припасов
              </li>
              <li>
                {banner.chakra >= 0 ? "+" : ""}
                {banner.chakra} чакры
              </li>
            </ul>
          </button>
        ) : null}
        {coach !== "off" && !showBattle && !state.setup?.training && currentIsHuman(state) ? (
          <div className="coach">
            <p>
              {coach === "select"
                ? "Кликните свой отряд — загорятся клетки хода."
                : coach === "act"
                  ? "Светлая клетка — ход. Красная — атака с соседней."
                  : coach === "hire"
                    ? "Справа найм в столице. Генин дёшев и держит линию."
                    : "Конец хода справа или пробел. Tab — следующий отряд."}
            </p>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  if (coach === "end") dismissCoach();
                  else setCoach(coach === "select" ? "act" : coach === "act" ? "hire" : "end");
                }}
              >
                Дальше
              </button>
              <button type="button" onClick={dismissCoach}>
                Скрыть
              </button>
            </div>
          </div>
        ) : null}
        <div className="hud-bl">
          <button type="button" onClick={() => setHelp(true)}>
            Правила
          </button>
          <button
            type="button"
            onClick={() => {
              const el = wrapRef.current;
              if (el && state) cam.current = fitCamera(state, el.clientWidth, el.clientHeight);
            }}
          >
            Вся карта
          </button>
          <span className="fog-hint">Туман войны</span>
        </div>
      </div>
      <div className={panelOpen ? "panel-wrap open" : "panel-wrap"}>
        <SidePanel
          state={state}
          selected={selectedStack}
          selectedHex={focusHex}
          techMode={techMode}
          error={error}
          muted={muted}
          onHire={(unit, q, r) => {
            dispatch({ type: "HIRE", payload: { unit, q, r, count: 1 } });
            sfx.click();
          }}
          onBuild={(building, settlementId) => {
            dispatch({ type: "BUILD", payload: { building, settlementId } });
            sfx.click();
          }}
          onSkill={(commanderId, branch) => dispatch({ type: "SKILL", payload: { commanderId, branch } })}
          onTech={() => {
            setTechMode((v) => !v);
            sfx.click();
          }}
          onHireCommander={(defId) => dispatch({ type: "HIRE_COMMANDER", payload: { defId } })}
          onDiplo={(otherId, action) => dispatch({ type: "DIPLOMACY", payload: { otherId, action } })}
          onEnd={endTurn}
          onSave={() => {
            saveLocal(state);
            setError("Сохранено");
          }}
          onExport={() => downloadSave(state)}
          onMenu={() => setScreen("setup")}
          onSkipBattle={closeBattle}
          onMute={() => {
            const n = !muted;
            setMutedState(n);
            setMuted(n);
          }}
        />
      </div>
      {state.phase === "gameover" ? (
        <div className="modal">
          <div className="modal-card">
            <p className="kicker">Конец войны</p>
            <h2>{state.winner?.map((id) => playerOf(state, id)?.name).join(" и ") ?? "Никто"} побеждает</h2>
            <p>{state.winReason}</p>
            <div className="row">
              <button type="button" className="cta" onClick={() => setScreen("setup")}>
                Новая партия
              </button>
              <button type="button" onClick={() => downloadSave(state)}>
                Экспорт
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
      <label className="import">
        Импорт
        <input
          type="file"
          accept="application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const s = deserialize(await f.text());
              hydrateVision(s);
              setState(s);
              setScreen("play");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Ошибка файла");
            }
          }}
        />
      </label>
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <p className="kicker">Правила</p>
        <h2>Путь каге</h2>
        <ul className="help">
          <li>Доход всплывает в начале хода. Справа и на карте видно рё, припасы и чакру. Отряды, которые ещё не ходили, пульсируют; сходившие тускнеют.</li>
          <li>Выберите отряд и кликните клетку: светлая — ход, красная — атака с соседней. На клетку врага зайдёте только после победы.</li>
          <li>Тайдзюцу бьёт ниндзюцу, ниндзюцу — гэндзюцу, гэндзюцу — тайдзюцу (+30%). Осада и АНБУ вне треугольника.</li>
          <li>Бой идёт на карте: отряды сходятся, бьют, цифры урона всплывают над клеткой. Тактику выбираете в панели снизу. Пробел — к итогу.</li>
          <li>Конец хода с неходившими отрядами спросит подтверждение. Tab — следующий свободный отряд, C — столица, F — вся карта.</li>
          <li>Туман войны скрывает неразведанные гексы. Отряды, столицы и поселения дают обзор. Союзники делят видимость. Деревня Тумана снижает обзор врагам.</li>
          <li>Метки на карте: свиток, святилище, тайник, охота. Дойдите отрядом, пока метка не истекла.</li>
          <li>Вход в скрытый туманом отряд — засада: первый удар слабее, защитник бьёт сильнее.</li>
          <li>Клавиши: пробел — конец хода, Tab — следующий отряд, C — к столице, F — вся карта, WASD / стрелки — панорама, +/- — масштаб. Клик по миникарте — прыжок.</li>
          <li>Победа: все столицы, либо 60% земли 3 хода, либо очки на лимите ходов.</li>
          <li>Нулевые припасы — дезертирство. Юниты сверх 10 дорожают. Отстающим помогает доход.</li>
        </ul>
        <button type="button" className="cta" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

function SimScreen({ onBack }: { onBack: () => void }) {
  const [battles, setBattles] = useState<BattleSimResult | null>(null);
  const [matches, setMatches] = useState<MatchSimResult | null>(null);
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);

  const runBattles = async () => {
    setBusy(true);
    setProgress("Бои…");
    await new Promise((r) => setTimeout(r, 20));
    setBattles(simBattles(200, "kage-b200"));
    setProgress("");
    setBusy(false);
  };

  const runMatches = async () => {
    setBusy(true);
    setMatches(null);
    const result = await simMatches(50, "kage-g50", (i) => setProgress(`Партия ${i}/50`));
    setMatches(result);
    setProgress("");
    setBusy(false);
  };

  return (
    <div className="setup">
      <header className="setup-hero">
        <p className="kicker">Баланс</p>
        <h1>Симуляция</h1>
        <p className="lede">200 боёв и 50 партий бот-против-бота. Цель: винрейт 45–55%, длина 40–70 ходов.</p>
      </header>
      <div className="setup-actions">
        <button type="button" className="cta" disabled={busy} onClick={runBattles}>
          Прогнать 200 боёв
        </button>
        <button type="button" className="cta" disabled={busy} onClick={runMatches}>
          Прогнать 50 партий
        </button>
        <button type="button" className="ghost" onClick={onBack}>
          Назад
        </button>
      </div>
      {progress ? <p className="meta">{progress}</p> : null}

      {battles ? (
        <section className="panel">
          <h2>200 боёв</h2>
          <p>
            Атакующий {battles.aWins} · защитник {battles.bWins} · ничьи {battles.draws} · отходы {battles.retreats} ·
            разгромы {battles.wipes} · среднее раундов {battles.avgRounds.toFixed(1)}
          </p>
        </section>
      ) : null}

      {matches ? (
        <section className="panel">
          <h2>50 партий</h2>
          <p>Средняя длина: {matches.avgTurns.toFixed(1)} хода</p>
          <table className="sim-table">
            <thead>
              <tr>
                <th>Деревня</th>
                <th>Игр</th>
                <th>Побед</th>
                <th>Винрейт</th>
              </tr>
            </thead>
            <tbody>
              {VILLAGE_IDS.map((v) => {
                const r = matches.winRate[v];
                return (
                  <tr key={v}>
                    <td>{BALANCE.villages[v].name}</td>
                    <td>{r.games}</td>
                    <td>{r.wins}</td>
                    <td>{(r.rate * 100).toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h3>Найм</h3>
          <p>
            {Object.entries(matches.unitPick)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => `${k}: ${n}`)
              .join(" · ")}
          </p>
          <h3>Навыки</h3>
          <p>
            {Object.entries(matches.skillPick)
              .map(([k, n]) => `${k}: ${n}`)
              .join(" · ")}
          </p>
          <BalanceNotes result={matches} />
        </section>
      ) : null}

      <section className="panel">
        <h2>Бюджет фракций</h2>
        <p>Каждая деревня: +100 бонусов, −100 штрафов. См. вкладку на экране старта и комментарии BALANCE.</p>
        <ul>
          {FACTION_BUDGET.map((f) => (
            <li key={f.id}>
              {f.name}: бонусы {f.bonuses.reduce((n, b) => n + b.pts, 0)}, штрафы{" "}
              {f.penalties.reduce((n, b) => n + b.pts, 0)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function BalanceNotes({ result }: { result: MatchSimResult }) {
  const notes: string[] = [];
  for (const v of VILLAGE_IDS) {
    const r = result.winRate[v].rate * 100;
    if (r < 40) notes.push(`${BALANCE.villages[v].name}: винрейт ${r.toFixed(0)}% — усилить доход или атаку на 5–8%.`);
    if (r > 60) notes.push(`${BALANCE.villages[v].name}: винрейт ${r.toFixed(0)}% — ослабить бонус хода или атаки.`);
  }
  if (result.avgTurns < 40) notes.push("Партии короткие: +HP гарнизонов столиц или −стартовая армия.");
  if (result.avgTurns > 70) notes.push("Партии длинные: −HP гарнизонов нейтралов, +доход захваченных точек.");
  if (!notes.length) notes.push("Винрейты в коридоре. Оставить BALANCE как есть, следить за Cloud/Stone на большой карте.");
  return (
    <div>
      <h3>П правки BALANCE</h3>
      <ul>
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
