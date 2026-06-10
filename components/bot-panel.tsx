'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import type { UseBotTradingReturn } from '@/hooks/use-bot-trading';
import type { BotConfig, BotLogKind } from '@/lib/bot-types';

export interface BotPanelProps {
  bot: UseBotTradingReturn;
}

function StatusBadge({ bot }: { bot: UseBotTradingReturn }) {
  if (bot.isRunning && bot.inFlight) {
    return <Badge className="bg-amber-500 text-white hover:bg-amber-500">In trade</Badge>;
  }
  if (bot.isRunning && bot.cooldown > 0) {
    return <Badge variant="secondary">Cooldown {bot.cooldown}</Badge>;
  }
  if (bot.isRunning) {
    return <Badge className="bg-emerald-500 text-white hover:bg-emerald-500">Running</Badge>;
  }
  return <Badge variant="outline">Stopped</Badge>;
}

const LOG_COLORS: Record<BotLogKind, string> = {
  info: 'text-muted-foreground',
  skip: 'text-muted-foreground',
  arm: 'text-primary',
  win: 'text-emerald-500',
  loss: 'text-destructive',
  cooldown: 'text-amber-500',
  stop: 'text-muted-foreground',
  error: 'text-destructive',
};

function NumberField({
  label,
  value,
  onChange,
  disabled,
  step,
  min,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  step?: string;
  min?: number;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={value ?? ''}
        placeholder={placeholder ?? 'off'}
        disabled={disabled}
        step={step}
        min={min}
        onKeyDown={(e) => {
          if (['e', 'E', '+'].includes(e.key)) e.preventDefault();
        }}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(null);
          const n = parseFloat(raw);
          onChange(Number.isNaN(n) ? null : n);
        }}
      />
    </div>
  );
}

export function BotPanel({ bot }: BotPanelProps) {
  const { config, setConfig, stats } = bot;
  const cfg: BotConfig = config;
  const locked = bot.isRunning;

  const pnlClass = stats.pnl > 0 ? 'text-emerald-500' : stats.pnl < 0 ? 'text-destructive' : '';

  return (
    <Card className="border shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Auto Bot</CardTitle>
          <span className="text-xs text-muted-foreground">OVER 2 · Anti-Streak</span>
        </div>
        <StatusBadge bot={bot} />
      </CardHeader>

      <CardContent className="space-y-4">
        {!bot.canRun && (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Log in and wait for the market feed to connect before starting the bot.
          </p>
        )}
        {bot.stoppedReason && (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {bot.stoppedReason}
          </p>
        )}

        {/* Config */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberField
            label="Stake (USD)"
            value={cfg.stake}
            min={0}
            step="0.01"
            disabled={locked}
            onChange={(v) => setConfig({ stake: v ?? 0 })}
          />
          <NumberField
            label="Window"
            value={cfg.windowSize}
            min={10}
            step="1"
            disabled={locked}
            onChange={(v) => setConfig({ windowSize: Math.max(10, Math.round(v ?? 60)) })}
          />
          <NumberField
            label="Take profit"
            value={cfg.takeProfit}
            step="0.01"
            disabled={locked}
            onChange={(v) => setConfig({ takeProfit: v })}
          />
          <NumberField
            label="Stop loss"
            value={cfg.stopLoss}
            step="0.01"
            disabled={locked}
            onChange={(v) => setConfig({ stopLoss: v })}
          />
        </div>

        {/* Controls */}
        <div className="flex gap-2">
          {bot.isRunning ? (
            <Button variant="destructive" className="flex-1 rounded-full" onClick={bot.stop}>
              Stop Bot
            </Button>
          ) : (
            <Button
              className="flex-1 rounded-full"
              disabled={!bot.canRun || cfg.stake <= 0}
              onClick={bot.start}
            >
              Start Bot
            </Button>
          )}
          <Button
            variant="outline"
            className="rounded-full"
            disabled={bot.isRunning}
            onClick={bot.reset}
          >
            Reset
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Stat label="Trades" value={String(stats.trades)} />
          <Stat label="Win rate" value={`${stats.winRate.toFixed(0)}%`} />
          <Stat label="P&L" value={`${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2)}`} valueClass={pnlClass} />
          <Stat label="Max DD" value={stats.maxDrawdown.toFixed(2)} />
          <Stat label="W / L" value={`${stats.wins} / ${stats.losses}`} />
          <Stat label="Streak" value={stats.winStreak > 0 ? `+${stats.winStreak}` : stats.lossStreak > 0 ? `-${stats.lossStreak}` : '0'} />
        </div>

        {/* Live decision diagnostics */}
        {bot.lastDecision && (
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">Signal</span>
              <span className="text-xs font-medium">{bot.lastDecision.reason}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {bot.lastDecision.percentages.map((pct, d) => {
                const isLoss = d <= 2;
                const isTrigger = bot.lastDecision!.triggerDigit === d;
                return (
                  <div
                    key={d}
                    className={`flex min-w-[34px] flex-col items-center rounded px-1 py-0.5 text-[10px] ${
                      isTrigger
                        ? 'bg-primary text-primary-foreground'
                        : isLoss
                          ? 'bg-destructive/15 text-destructive'
                          : 'bg-background text-muted-foreground'
                    }`}
                  >
                    <span className="font-bold">{d}</span>
                    <span>{pct.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-3 text-[10px] text-muted-foreground">
              <Check ok={bot.lastDecision.passInstability} label="Instability" />
              <Check ok={bot.lastDecision.passDCondition} label="D-cond" />
              <Check ok={bot.lastDecision.passEntry} label="Entry" />
              <Check ok={bot.lastDecision.triggerMatch} label="Trigger" />
            </div>
          </div>
        )}

        {/* Log */}
        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">Activity log</p>
          <div className="h-40 overflow-y-auto rounded-lg border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
            {bot.log.length === 0 ? (
              <p className="text-muted-foreground">No activity yet.</p>
            ) : (
              [...bot.log].reverse().map((entry) => (
                <div key={entry.id} className={LOG_COLORS[entry.kind]}>
                  <span className="text-muted-foreground">#{entry.tick}</span> {entry.message}
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-2 py-1.5 text-center">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold ${valueClass ?? ''}`}>{value}</p>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={ok ? 'text-emerald-500' : 'text-muted-foreground'}>
      {ok ? '✓' : '○'} {label}
    </span>
  );
}
