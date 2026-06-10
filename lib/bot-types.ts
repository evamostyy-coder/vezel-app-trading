// Types for the autonomous trading bot — the second decision engine.
// Strategy: OVER 2 Anti-Streak Engine (no-lookback).

export interface BotConfig {
  /** Rolling digit window the engine analyses (engine default: 60). */
  windowSize: number;
  /** Stake per trade in USD. */
  stake: number;

  // --- Engine thresholds (mirror the Python SETTINGS) ---
  /** Min combined % of digits 0+1+2 to consider the market unstable enough. */
  lossClusterMin: number; // 25
  /** Reject if any single loss digit (0/1/2) dominates above this %. */
  maxSingleLossDigit: number; // 18
  /** D-condition: digit 2 must be at least this %. */
  d2Min: number; // 10
  /** D-condition: digit 0 OR digit 1 must be at least this %. */
  d01Min: number; // 10
  /** Entry confirmation: at least N of the last 5 digits must be winners (3-9). */
  entryConfirmCount: number; // 3
  /** Ticks to pause after a single loss. */
  cooldownAfterLoss: number; // 5
  /** Loss streak that triggers the extended cooldown. */
  maxLossStreak: number; // 3
  /** Extended cooldown (ticks) once max loss streak is hit. */
  extendedCooldown: number; // 10

  // --- Optional global risk limits (off by default — null) ---
  /** Stop the bot once cumulative P&L reaches +takeProfit USD. */
  takeProfit: number | null;
  /** Stop the bot once cumulative P&L reaches -stopLoss USD. */
  stopLoss: number | null;
  /** Stop the bot after this many settled trades. */
  maxTrades: number | null;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  windowSize: 60,
  stake: 10,
  lossClusterMin: 25,
  maxSingleLossDigit: 18,
  d2Min: 10,
  d01Min: 10,
  entryConfirmCount: 3,
  cooldownAfterLoss: 5,
  maxLossStreak: 3,
  extendedCooldown: 10,
  takeProfit: null,
  stopLoss: null,
  maxTrades: null,
};

export interface SignalDecision {
  /** True when all gates pass and the current digit equals the trigger digit. */
  fire: boolean;
  triggerDigit: number | null;
  currentDigit: number;
  /** Percentage of each digit 0-9 in the window. */
  percentages: number[];
  lossCluster: number;
  passInstability: boolean;
  passDCondition: boolean;
  passEntry: boolean;
  triggerMatch: boolean;
  reason: string;
}

export interface BotTrade {
  contractId: number;
  ts: number;
  triggerDigit: number;
  resultDigit: number | null;
  stake: number;
  profit: number | null;
  won: boolean | null;
  status: 'open' | 'won' | 'lost' | 'error';
}

export type BotLogKind =
  | 'info'
  | 'skip'
  | 'arm'
  | 'win'
  | 'loss'
  | 'cooldown'
  | 'stop'
  | 'error';

export interface BotLogEntry {
  id: number;
  ts: number;
  tick: number;
  kind: BotLogKind;
  message: string;
}

export interface BotStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  peakPnl: number;
  maxDrawdown: number;
  winStreak: number;
  lossStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
}
