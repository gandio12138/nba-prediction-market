/**
 * NBA championship futures scanner.
 *
 * Compares NBA Championship Winner odds from sportsbooks (The Odds API)
 * against Polymarket futures prices. Flags mispricings where the implied
 * probability gap exceeds a threshold.
 *
 * In dry-run mode: scans and logs but never places orders.
 *
 * Stdout protocol — each line is tagged for dashboard parsing:
 *   START <message>       Runner started
 *   SCAN <message>        Iteration started, fetching data
 *   NO_EDGE <message>     Scan iteration complete, no opportunities
 *   SIGNAL <message>      Mispricing detected (dry-run skip)
 *   SCAN_ERROR <message>  Scan cycle failed
 *   STOP <message>        Runner shutting down
 *
 * Usage: pnpm exec tsx src/runner.ts --dry-run
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fetchOdds } from "./clients/sportsbook.js";
import { searchMarkets } from "./clients/polymarket.js";
import type { StrategyConfig } from "./config/strategy.js";
import { DEFAULT_CONFIG } from "./config/strategy.js";
import { shouldFlag } from "./service/signals.js";
import { checkRiskLimits } from "./service/risk.js";
import { DEFAULT_RISK_CONFIG } from "./config/risk.js";

// ── Log entry types ─────────────────────────────────────────────────────────

interface SignalLogEntry {
  ts: string;
  automation_id: string;
  cycle: number;
  action: "SIGNAL";
  team: string;
  sportsbookProb: number;
  polymarketPrice: number;
  delta: number;
  reasoning: string;
}

interface HeartbeatLogEntry {
  ts: string;
  automation_id: string;
  cycle: number;
  action: "NO_EDGE";
  teams: number;
  markets: number;
  matched: number;
  reasoning: string;
}

interface ScanErrorLogEntry {
  ts: string;
  automation_id: string;
  cycle: number;
  action: "SCAN_ERROR";
  reasoning: string;
}

type LogEntry = SignalLogEntry | HeartbeatLogEntry | ScanErrorLogEntry;

// ── Constants ───────────────────────────────────────────────────────────────

const AUTOMATION_ID = "nba-futures-v1";
const EXECUTION_DIR = join(process.cwd(), ".canon", "execution");
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// ── Counters ────────────────────────────────────────────────────────────────

let cycleCount = 0;
let signalCount = 0;
let errorCount = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureExecutionDir(): void {
  if (!existsSync(EXECUTION_DIR)) {
    mkdirSync(EXECUTION_DIR, { recursive: true });
  }
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(EXECUTION_DIR, `${date}.jsonl`);
}

function appendLog(entry: LogEntry): void {
  ensureExecutionDir();
  appendFileSync(logFilePath(), JSON.stringify(entry) + "\n");
}

function out(tag: string, msg: string): void {
  process.stdout.write(`${tag} ${msg}\n`);
}

function parsePollInterval(): number {
  const envVal = process.env["POLL_INTERVAL_MS"];
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

// ── Team matching ───────────────────────────────────────────────────────────

/** Normalize team name for fuzzy matching. */
export function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/**
 * NBA team name aliases — maps common short names to the full
 * team name fragments. Extend as needed.
 */
const NBA_ALIASES: Record<string, string[]> = {
  "76ers": ["philadelphia", "sixers", "76ers"],
  blazers: ["portland", "trail blazers", "blazers"],
  cavs: ["cleveland", "cavaliers", "cavs"],
  mavs: ["dallas", "mavericks", "mavs"],
  wolves: ["minnesota", "timberwolves", "wolves"],
};

/** Check if a text string mentions a team (fuzzy match with aliases). */
export function textMentionsTeam(
  text: string,
  teamName: string,
): boolean {
  const t = normalize(text);
  const n = normalize(teamName);

  if (t.includes(n)) return true;

  // Try last word of team name (e.g. "Lakers" from "Los Angeles Lakers")
  const parts = n.split(" ");
  const last = parts[parts.length - 1];
  if (last && last.length > 3 && t.includes(last)) return true;

  // Check aliases
  for (const [, aliases] of Object.entries(NBA_ALIASES)) {
    const teamMatches = aliases.some((a) => n.includes(a));
    const textMatches = aliases.some((a) => t.includes(a));
    if (teamMatches && textMatches) return true;
  }

  return false;
}

// ── Sportsbook implied probabilities ────────────────────────────────────────

export interface TeamOdds {
  team: string;
  impliedProb: number;
  sources: number;
}

/**
 * Extract average implied probability per team from championship
 * outright odds across all bookmakers.
 */
export function extractTeamOdds(
  events: Awaited<ReturnType<typeof fetchOdds>>,
): TeamOdds[] {
  const teamProbs = new Map<string, number[]>();

  for (const event of events) {
    for (const bm of event.bookmakers) {
      const outrights = bm.markets.find((m) => m.key === "outrights");
      if (!outrights) continue;

      for (const outcome of outrights.outcomes) {
        if (outcome.price <= 1) continue;
        const probs = teamProbs.get(outcome.name) ?? [];
        probs.push(1 / outcome.price);
        teamProbs.set(outcome.name, probs);
      }
    }
  }

  const result: TeamOdds[] = [];
  for (const [team, probs] of teamProbs) {
    const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
    result.push({ team, impliedProb: avg, sources: probs.length });
  }

  return result.sort((a, b) => b.impliedProb - a.impliedProb);
}

// ── Scan cycle ──────────────────────────────────────────────────────────────

async function runCycle(config: StrategyConfig): Promise<void> {
  cycleCount++;
  const ts = new Date().toISOString();

  out("SCAN", `#${cycleCount} — fetching NBA futures...`);

  // 1. Fetch championship outright odds from sportsbooks
  const events = await fetchOdds("basketball_nba_championship_winner");
  const teamOdds = extractTeamOdds(events);

  // 2. Fetch Polymarket NBA championship markets
  const markets = await searchMarkets("NBA Finals");

  // 3. Match teams to Polymarket markets and compare prices
  let matchedCount = 0;
  let cycleSignals = 0;

  for (const { team, impliedProb, sources } of teamOdds) {
    // Risk gate: require minimum bookmaker sources
    if (!checkRiskLimits({ sources }, DEFAULT_RISK_CONFIG)) continue;

    const market = markets.find((m) => textMentionsTeam(m.question, team));
    if (!market) continue;

    matchedCount++;

    // Signal check: delta exceeds mispricing threshold?
    const signal = shouldFlag(impliedProb, market.yesPrice, config);
    if (!signal) continue;

    cycleSignals++;
    signalCount++;

    const reasoning =
      `${team}: sportsbook ${(impliedProb * 100).toFixed(1)}% vs ` +
      `Polymarket ${(market.yesPrice * 100).toFixed(1)}% ` +
      `(${signal.direction}, delta ${(signal.absDelta * 100).toFixed(1)}%)`;

    const entry: SignalLogEntry = {
      ts,
      automation_id: AUTOMATION_ID,
      cycle: cycleCount,
      action: "SIGNAL",
      team,
      sportsbookProb: impliedProb,
      polymarketPrice: market.yesPrice,
      delta: signal.absDelta,
      reasoning,
    };
    appendLog(entry);
    out("SIGNAL", reasoning);
  }

  // 4. Heartbeat if no signals
  if (cycleSignals === 0) {
    const reasoning =
      `#${cycleCount} — ${teamOdds.length} teams, ` +
      `${markets.length} markets, ${matchedCount} matched, no edges`;

    const entry: HeartbeatLogEntry = {
      ts,
      automation_id: AUTOMATION_ID,
      cycle: cycleCount,
      action: "NO_EDGE",
      teams: teamOdds.length,
      markets: markets.length,
      matched: matchedCount,
      reasoning,
    };
    appendLog(entry);
    out("NO_EDGE", reasoning);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  if (!isDryRun()) {
    process.stderr.write(
      "error: --dry-run flag is required. " +
        "Live trading is not implemented.\n",
    );
    process.exitCode = 1;
    return;
  }

  const config = DEFAULT_CONFIG;
  const pollInterval = parsePollInterval();

  out("START", `NBA futures scanner (dry-run) poll=${pollInterval}ms`);

  let running = true;

  process.on("SIGINT", () => {
    out(
      "STOP",
      `Shutting down — ${cycleCount} iterations, ` +
        `${signalCount} signals, ${errorCount} errors`,
    );
    running = false;
  });

  while (running) {
    try {
      await runCycle(config);
    } catch (err: unknown) {
      errorCount++;
      const message = err instanceof Error ? err.message : String(err);

      const errorEntry: ScanErrorLogEntry = {
        ts: new Date().toISOString(),
        automation_id: AUTOMATION_ID,
        cycle: cycleCount,
        action: "SCAN_ERROR",
        reasoning: message,
      };
      appendLog(errorEntry);
      out("SCAN_ERROR", `#${cycleCount} — ${message}`);
    }

    if (running) {
      await sleep(pollInterval);
    }
  }

  out(
    "STOP",
    `Runner stopped — ${cycleCount} iterations, ` +
      `${signalCount} signals, ${errorCount} errors`,
  );
}

main();
