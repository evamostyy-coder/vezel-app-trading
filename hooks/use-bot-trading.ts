'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DerivWS, ActiveSymbol, Tick, ProposalResponse, BuyResponse } from '@deriv/core';
import { getLastDigit } from '../lib/digit-stats';
import { evaluateOver2 } from '../lib/bot-signals';
import {
  DEFAULT_BOT_CONFIG,
  type BotConfig,
  type BotTrade,
  type BotLogEntry,
  type BotLogKind,
  type BotStats,
  type SignalDecision,
} from '../lib/bot-types';

// OVER 2 contract: barrier 2, settles on the next tick.
const CONTRACT_TYPE = 'DIGITOVER';
const BARRIER = 2;
const DURATION_TICKS = 1;
const SETTLEMENT_TIMEOUT_MS = 60_000;
const MAX_LOG_ENTRIES = 200;

export interface UseBotTradingParams {
  /** Shared WebSocket — same instance the manual engine uses. */
  ws: DerivWS | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  /** Shared market feed (read-only) — supplied by the manual trading hook. */
  activeSymbol: ActiveSymbol | null;
  currentTick: Tick | null;
  /**
   * The single shared digit buffer (last digit of every buffered price),
   * computed once in the manual hook. The bot analyses the last `windowSize`
   * of these — so the UI stats bar and the bot can never disagree on digits.
   */
  digits: number[];
  pipSize: number;
}

export interface UseBotTradingReturn {
  isRunning: boolean;
  canRun: boolean;
  inFlight: boolean;
  cooldown: number;
  config: BotConfig;
  setConfig: (patch: Partial<BotConfig>) => void;
  start: () => void;
  stop: () => void;
  reset: () => void;
  stats: BotStats;
  trades: BotTrade[];
  log: BotLogEntry[];
  lastDecision: SignalDecision | null;
  stoppedReason: string | null;
}

interface EngineState {
  running: boolean;
  inFlight: boolean;
  cooldown: number;
  wins: number;
  losses: number;
  pnl: number;
  peakPnl: number;
  maxDrawdown: number;
  winStreak: number;
  lossStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
  trades: BotTrade[];
  log: BotLogEntry[];
  lastDecision: SignalDecision | null;
  stoppedReason: string | null;
  logSeq: number;
  tickCount: number;
}

function initialEngine(): EngineState {
  return {
    running: false,
    inFlight: false,
    cooldown: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    peakPnl: 0,
    maxDrawdown: 0,
    winStreak: 0,
    lossStreak: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    trades: [],
    log: [],
    lastDecision: null,
    stoppedReason: null,
    logSeq: 0,
    tickCount: 0,
  };
}

/**
 * The bot decision engine — a second, independent consumer of the shared
 * market feed. It never owns the tick subscription; it reads `prices` /
 * `currentTick` (already streamed for the UI) and, when the OVER 2 Anti-Streak
 * signal fires, places its own proposal → buy and tracks settlement.
 */
export function useBotTrading({
  ws,
  isConnected,
  isAuthenticated,
  activeSymbol,
  currentTick,
  digits,
  pipSize,
}: UseBotTradingParams): UseBotTradingReturn {
  const [config, setConfigState] = useState<BotConfig>(DEFAULT_BOT_CONFIG);
  const cfgRef = useRef<BotConfig>(config);
  cfgRef.current = config;

  const engine = useRef<EngineState>(initialEngine());
  const [, forceRender] = useState(0);

  // Mirror engine fields the UI renders.
  const [snapshot, setSnapshot] = useState<EngineState>(engine.current);

  // Per-tick edge detection + in-flight settlement cleanup.
  const lastEpochRef = useRef<number | null>(null);
  const settlementCleanupRef = useRef<(() => void) | null>(null);
  const wsRef = useRef<DerivWS | null>(ws);
  wsRef.current = ws;
  const symbolRef = useRef<ActiveSymbol | null>(activeSymbol);
  symbolRef.current = activeSymbol;
  const pipSizeRef = useRef<number>(pipSize);
  pipSizeRef.current = pipSize;

  const canRun = !!ws && isConnected && isAuthenticated && !!activeSymbol;

  const commit = useCallback(() => {
    setSnapshot({ ...engine.current });
    forceRender((n) => n + 1);
  }, []);

  const addLog = useCallback((kind: BotLogKind, message: string) => {
    const e = engine.current;
    e.log = [
      ...e.log,
      { id: e.logSeq++, ts: currentEpoch(), tick: e.tickCount, kind, message },
    ].slice(-MAX_LOG_ENTRIES);
  }, []);

  const stopEngine = useCallback(
    (reason: string, kind: BotLogKind = 'stop') => {
      const e = engine.current;
      e.running = false;
      e.stoppedReason = reason;
      addLog(kind, reason);
      commit();
    },
    [addLog, commit]
  );

  // --- Settlement: subscribe to the bought contract, resolve on close. ---
  const waitForSettlement = useCallback(
    (
      contractId: number
    ): Promise<{ profit: number; resultDigit: number | null; status: string }> => {
      return new Promise((resolve, reject) => {
        const sock = wsRef.current;
        if (!sock) {
          reject(new Error('WebSocket unavailable'));
          return;
        }

        let settled = false;
        let unsub: (() => void) | null = null;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (unsub) unsub();
          settlementCleanupRef.current = null;
        };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('Settlement timed out'));
        }, SETTLEMENT_TIMEOUT_MS);

        sock
          .subscribe({ proposal_open_contract: 1, contract_id: contractId }, (data) => {
            const c = (data as { proposal_open_contract?: Record<string, unknown> })
              .proposal_open_contract;
            if (!c || settled) return;

            const isClosed =
              !!c.is_sold || !!c.is_expired || (c.status && c.status !== 'open');
            if (!isClosed) return;

            settled = true;
            const profit = parseFloat(String(c.profit ?? '0'));
            const exitDisplay = c.exit_tick_display_value as string | undefined;
            let resultDigit: number | null = null;
            if (exitDisplay) {
              const cleaned = exitDisplay.replace(/[^0-9]/g, '');
              if (cleaned.length) resultDigit = parseInt(cleaned[cleaned.length - 1], 10);
            } else if (typeof c.exit_tick === 'number') {
              resultDigit = getLastDigit(c.exit_tick, pipSizeRef.current);
            }
            cleanup();
            resolve({ profit, resultDigit, status: String(c.status ?? 'closed') });
          })
          .then((sub) => {
            unsub = sub.unsubscribe;
            settlementCleanupRef.current = cleanup;
            if (settled) cleanup(); // resolved before subscription handle returned
          })
          .catch((err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err instanceof Error ? err : new Error('Subscription failed'));
          });
      });
    },
    []
  );

  // --- Apply settlement to engine state (streaks, cooldown, P&L). ---
  const onSettled = useCallback(
    (
      triggerDigit: number,
      stake: number,
      contractId: number,
      result: { profit: number; resultDigit: number | null }
    ) => {
      const e = engine.current;
      const cfg = cfgRef.current;
      const won = result.profit > 0;
      e.pnl += result.profit;

      if (won) {
        e.wins++;
        e.winStreak++;
        e.lossStreak = 0;
        e.maxWinStreak = Math.max(e.maxWinStreak, e.winStreak);
        addLog(
          'win',
          `WIN digit=${result.resultDigit ?? '?'} profit=${result.profit.toFixed(2)} | pnl=${e.pnl.toFixed(2)} | streak=${e.winStreak}`
        );
      } else {
        e.losses++;
        e.lossStreak++;
        e.winStreak = 0;
        e.maxLossStreak = Math.max(e.maxLossStreak, e.lossStreak);
        e.cooldown = cfg.cooldownAfterLoss;
        addLog(
          'loss',
          `LOSS digit=${result.resultDigit ?? '?'} profit=${result.profit.toFixed(2)} | pnl=${e.pnl.toFixed(2)} | streak=${e.lossStreak}`
        );
        if (e.lossStreak >= cfg.maxLossStreak) {
          e.cooldown = cfg.extendedCooldown;
          addLog('cooldown', `Max loss streak (${e.lossStreak}) — extended cooldown ${cfg.extendedCooldown}`);
        } else {
          addLog('cooldown', `Cooldown started (${cfg.cooldownAfterLoss} ticks)`);
        }
      }

      e.peakPnl = Math.max(e.peakPnl, e.pnl);
      e.maxDrawdown = Math.max(e.maxDrawdown, e.peakPnl - e.pnl);

      const trade: BotTrade = {
        contractId,
        ts: currentEpoch(),
        triggerDigit,
        resultDigit: result.resultDigit,
        stake,
        profit: result.profit,
        won,
        status: won ? 'won' : 'lost',
      };
      e.trades = [trade, ...e.trades].slice(0, 100);

      e.inFlight = false;

      // Global risk stops checked after each settlement.
      if (cfg.maxTrades != null && e.wins + e.losses >= cfg.maxTrades) {
        stopEngine(`Max trades reached (${cfg.maxTrades})`);
        return;
      }
      if (cfg.takeProfit != null && e.pnl >= cfg.takeProfit) {
        stopEngine(`Take profit hit (+${cfg.takeProfit})`);
        return;
      }
      if (cfg.stopLoss != null && e.pnl <= -Math.abs(cfg.stopLoss)) {
        stopEngine(`Stop loss hit (-${Math.abs(cfg.stopLoss)})`);
        return;
      }
      commit();
    },
    [addLog, commit, stopEngine]
  );

  // --- Place the trade: one-shot proposal → buy → await settlement. ---
  const runTrade = useCallback(
    async (triggerDigit: number) => {
      const sock = wsRef.current;
      const symbol = symbolRef.current;
      const cfg = cfgRef.current;
      const e = engine.current;
      if (!sock || !symbol) {
        e.inFlight = false;
        commit();
        return;
      }
      const stake = cfg.stake;
      try {
        const prop = await sock.send<ProposalResponse>({
          proposal: 1,
          amount: stake,
          basis: 'stake',
          contract_type: CONTRACT_TYPE,
          currency: 'USD',
          underlying_symbol: symbol.underlying_symbol,
          duration: DURATION_TICKS,
          duration_unit: 't',
          barrier: BARRIER,
        });

        const buyResp = await sock.send<BuyResponse>({
          buy: prop.proposal.id,
          price: String(prop.proposal.ask_price),
        });
        const contractId = buyResp.buy.contract_id;
        addLog('arm', `BUY OVER 2 @ ${buyResp.buy.buy_price.toFixed(2)} | trigger=${triggerDigit} | contract=${contractId}`);
        commit();

        const result = await waitForSettlement(contractId);
        onSettled(triggerDigit, stake, contractId, result);
      } catch (err) {
        e.inFlight = false;
        const msg = err instanceof Error ? err.message : 'Trade failed';
        addLog('error', `Trade error: ${msg}`);
        commit();
      }
    },
    [addLog, commit, onSettled, waitForSettlement]
  );

  // --- Per-tick state machine. ---
  const processTick = useCallback(
    (digit: number, window: number[]) => {
      const e = engine.current;
      const cfg = cfgRef.current;
      if (!e.running || e.stoppedReason) return;
      if (e.inFlight) return; // a contract is open — wait for settlement

      e.tickCount++;

      if (e.cooldown > 0) {
        e.cooldown--;
        addLog('cooldown', `Cooldown active (${e.cooldown} ticks remaining)`);
        commit();
        return;
      }

      // Pre-trade global risk checks.
      if (cfg.maxTrades != null && e.wins + e.losses >= cfg.maxTrades) {
        stopEngine(`Max trades reached (${cfg.maxTrades})`);
        return;
      }
      if (cfg.takeProfit != null && e.pnl >= cfg.takeProfit) {
        stopEngine(`Take profit hit (+${cfg.takeProfit})`);
        return;
      }
      if (cfg.stopLoss != null && e.pnl <= -Math.abs(cfg.stopLoss)) {
        stopEngine(`Stop loss hit (-${Math.abs(cfg.stopLoss)})`);
        return;
      }

      const decision = evaluateOver2(window, digit, cfg);
      e.lastDecision = decision;

      if (!decision.fire) {
        commit();
        return;
      }

      // Signal fired — place the OVER 2 trade.
      e.inFlight = true;
      addLog('arm', `SIGNAL ARMED — trigger=${decision.triggerDigit}, digit=${digit}`);
      commit();
      void runTrade(decision.triggerDigit as number);
    },
    [addLog, commit, runTrade, stopEngine]
  );

  // Rebuild the buffer cleanly on symbol change so the bot never mixes two
  // symbols' digits. `digits` already resets when the tick stream re-seeds, so
  // we only need to drop the epoch guard and wait for a full fresh window.
  const lastSymbolRef = useRef<string | null>(null);
  useEffect(() => {
    const sym = activeSymbol?.underlying_symbol ?? null;
    if (lastSymbolRef.current === sym) return;
    lastSymbolRef.current = sym;
    lastEpochRef.current = null;
    if (engine.current.running && sym) {
      addLog('info', `Symbol changed to ${sym} — rebuilding ${cfgRef.current.windowSize}-tick buffer`);
      commit();
    }
  }, [activeSymbol, addLog, commit]);

  // Drive the engine off the shared feed — one step per new tick.
  // Uses the same `digits` array the UI renders; the bot just looks at the
  // last `windowSize` of it. The window guard guarantees a full 60-tick buffer
  // is available (re-seeded from tick history) before the bot ever trades.
  useEffect(() => {
    if (!currentTick) return;
    if (lastEpochRef.current === currentTick.epoch) return;
    lastEpochRef.current = currentTick.epoch;

    const e = engine.current;
    if (!e.running) return;

    const cfg = cfgRef.current;
    const window = digits.slice(-cfg.windowSize);
    if (window.length < cfg.windowSize) return; // buffer not full yet

    const digit = window[window.length - 1];
    processTick(digit, window);
  }, [currentTick, digits, processTick]);

  // Stop cleanly if the connection or auth drops mid-run.
  useEffect(() => {
    if (engine.current.running && !canRun) {
      stopEngine('Connection or authentication lost', 'error');
    }
  }, [canRun, stopEngine]);

  // Clean up an in-flight settlement subscription on unmount.
  useEffect(() => {
    return () => {
      settlementCleanupRef.current?.();
    };
  }, []);

  const setConfig = useCallback((patch: Partial<BotConfig>) => {
    setConfigState((prev) => ({ ...prev, ...patch }));
  }, []);

  const start = useCallback(() => {
    if (!canRun) return;
    const e = engine.current;
    if (e.running) return;
    e.running = true;
    e.stoppedReason = null;
    lastEpochRef.current = null; // act on the next fresh tick
    addLog('info', `Bot started — OVER 2 Anti-Streak | stake ${cfgRef.current.stake} USD`);
    commit();
  }, [canRun, addLog, commit]);

  const stop = useCallback(() => {
    const e = engine.current;
    if (!e.running) return;
    e.running = false;
    addLog('stop', 'Bot stopped by user');
    commit();
  }, [addLog, commit]);

  const reset = useCallback(() => {
    settlementCleanupRef.current?.();
    engine.current = initialEngine();
    lastEpochRef.current = null;
    commit();
  }, [commit]);

  const stats: BotStats = useMemo(() => {
    const s = snapshot;
    const trades = s.wins + s.losses;
    return {
      trades,
      wins: s.wins,
      losses: s.losses,
      winRate: trades > 0 ? (s.wins / trades) * 100 : 0,
      pnl: s.pnl,
      peakPnl: s.peakPnl,
      maxDrawdown: s.maxDrawdown,
      winStreak: s.winStreak,
      lossStreak: s.lossStreak,
      maxWinStreak: s.maxWinStreak,
      maxLossStreak: s.maxLossStreak,
    };
  }, [snapshot]);

  return {
    isRunning: snapshot.running,
    canRun,
    inFlight: snapshot.inFlight,
    cooldown: snapshot.cooldown,
    config,
    setConfig,
    start,
    stop,
    reset,
    stats,
    trades: snapshot.trades,
    log: snapshot.log,
    lastDecision: snapshot.lastDecision,
    stoppedReason: snapshot.stoppedReason,
  };
}

// Date.now() wrapper kept in one place; epoch is only used for display ordering.
function currentEpoch(): number {
  return Date.now();
}
