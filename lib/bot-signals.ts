// Pure signal logic for the OVER 2 Anti-Streak Engine.
// Read-only over the shared market feed — no side effects, no WS.

import type { BotConfig, SignalDecision } from './bot-types';

/** Digits that win an OVER 2 contract (last digit > 2). */
export const WIN_DIGITS = [3, 4, 5, 6, 7, 8, 9];
/** Digits that lose an OVER 2 contract (last digit <= 2). */
export const LOSS_DIGITS = [0, 1, 2];

/** Percentage of each digit 0-9 across the window. Index = digit. */
export function digitPercentages(window: number[]): number[] {
  const counts = new Array(10).fill(0);
  for (const d of window) {
    if (d >= 0 && d <= 9) counts[d]++;
  }
  const n = window.length;
  return counts.map((c) => (n > 0 ? (c / n) * 100 : 0));
}

/**
 * Instability filter — only trade when the loss cluster (0+1+2) is heavy
 * enough but no single loss digit dominates.
 */
export function instabilityFilter(p: number[], cfg: BotConfig): boolean {
  const lossCluster = p[0] + p[1] + p[2];
  if (lossCluster < cfg.lossClusterMin) return false;
  if (Math.max(p[0], p[1], p[2]) > cfg.maxSingleLossDigit) return false;
  return true;
}

/** D-condition — digit 2 present AND (digit 0 OR digit 1) present. */
export function dCondition(p: number[], cfg: BotConfig): boolean {
  return p[2] >= cfg.d2Min && (p[0] >= cfg.d01Min || p[1] >= cfg.d01Min);
}

/** Entry confirmation — N of the last 5 digits are winners (3-9). */
export function entryConfirmation(window: number[], cfg: BotConfig): boolean {
  const recent = window.slice(-5);
  const strength = recent.filter((d) => WIN_DIGITS.includes(d)).length;
  return strength >= cfg.entryConfirmCount;
}

/** Trigger digit — the winning digit (3-9) least present in the window. */
export function triggerDigit(p: number[]): number {
  let best = WIN_DIGITS[0];
  for (const d of WIN_DIGITS) {
    if (p[d] < p[best]) best = d;
  }
  return best;
}

/**
 * Evaluate the full engine for the current tick.
 * Mirrors the Python state machine's signal phase: instability → D-condition →
 * entry confirmation → trigger-digit match. Returns a diagnostic decision.
 */
export function evaluateOver2(
  window: number[],
  currentDigit: number,
  cfg: BotConfig
): SignalDecision {
  const p = digitPercentages(window);
  const lossCluster = p[0] + p[1] + p[2];

  const passInstability = instabilityFilter(p, cfg);
  const passDCondition = passInstability && dCondition(p, cfg);
  const passEntry = passDCondition && entryConfirmation(window, cfg);

  let trigger: number | null = null;
  let triggerMatch = false;
  if (passEntry) {
    trigger = triggerDigit(p);
    triggerMatch = currentDigit === trigger;
  }

  const fire = passEntry && triggerMatch;

  let reason: string;
  if (!passInstability) reason = 'Instability filter failed';
  else if (!passDCondition) reason = 'D-condition failed';
  else if (!passEntry) reason = 'Entry confirmation failed';
  else if (!triggerMatch) reason = `Waiting for trigger ${trigger} (current ${currentDigit})`;
  else reason = `Armed on trigger ${trigger}`;

  return {
    fire,
    triggerDigit: trigger,
    currentDigit,
    percentages: p,
    lossCluster,
    passInstability,
    passDCondition,
    passEntry,
    triggerMatch,
    reason,
  };
}
