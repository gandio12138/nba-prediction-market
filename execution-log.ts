/**
 * Structured JSONL execution log for the trading pipeline.
 *
 * Every decision in the pipeline (signal, risk check, order, fill)
 * is appended as a single JSON line to a date-partitioned log file
 * at `.canon/execution/YYYY-MM-DD.jsonl`.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** Valid log entry types — one per pipeline stage. */
export type ExecutionLogEntryType =
  | "signal"
  | "risk_check"
  | "order_submit"
  | "order_fill"
  | "order_cancel"
  | "error";

const VALID_TYPES: ReadonlySet<string> = new Set<ExecutionLogEntryType>([
  "signal",
  "risk_check",
  "order_submit",
  "order_fill",
  "order_cancel",
  "error",
]);

/** A single structured log entry for the execution log. */
export interface ExecutionLogEntry {
  /** ISO 8601 timestamp of the event. */
  timestamp: string;
  /** Pipeline stage that produced this entry. */
  type: ExecutionLogEntryType;
  /** Which automation generated this event. */
  automation_id: string;
  /** Platform-specific market identifier. */
  market_id: string;
  /** Stage-specific payload (signal details, risk decision, order info, etc.). */
  data: Record<string, unknown>;
}

/**
 * Generate the log file path for a given date.
 *
 * @returns Absolute path: `<baseDir>/.canon/execution/YYYY-MM-DD.jsonl`
 */
export function getLogPath(baseDir: string, date: Date): string {
  const yyyy = date.getUTCFullYear().toString();
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  return join(baseDir, ".canon", "execution", `${yyyy}-${mm}-${dd}.jsonl`);
}

/**
 * Validate that a value conforms to the ExecutionLogEntry schema.
 *
 * Checks: object with string timestamp, valid type, string automation_id,
 * string market_id, and non-null object data.
 */
export function validateEntry(entry: unknown): entry is ExecutionLogEntry {
  if (entry === null || entry === undefined || typeof entry !== "object") {
    return false;
  }

  const obj = entry as Record<string, unknown>;

  if (typeof obj["timestamp"] !== "string") return false;
  if (typeof obj["type"] !== "string" || !VALID_TYPES.has(obj["type"])) {
    return false;
  }
  if (typeof obj["automation_id"] !== "string") return false;
  if (typeof obj["market_id"] !== "string") return false;
  if (
    obj["data"] === null ||
    obj["data"] === undefined ||
    typeof obj["data"] !== "object"
  ) {
    return false;
  }

  return true;
}

/**
 * Append a structured log entry to the date-partitioned JSONL file.
 *
 * Creates the directory structure if it does not exist.
 * Throws if the entry fails validation.
 */
export function appendEntry(baseDir: string, entry: ExecutionLogEntry): void {
  if (!validateEntry(entry)) {
    throw new Error(
      `Invalid execution log entry: ${JSON.stringify(entry)}`,
    );
  }

  const logPath = getLogPath(baseDir, new Date(entry.timestamp));
  const dir = dirname(logPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}
