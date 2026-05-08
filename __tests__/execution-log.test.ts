import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

const mockAppendFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  appendFileSync: mockAppendFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

import {
  getLogPath,
  validateEntry,
  appendEntry,
  type ExecutionLogEntry,
  type ExecutionLogEntryType,
} from "../execution-log.js";

function makeEntry(
  overrides: Partial<ExecutionLogEntry> = {},
): ExecutionLogEntry {
  return {
    timestamp: "2026-04-14T12:00:00.000Z",
    type: "signal",
    automation_id: "sports-arb-v1",
    market_id: "market-123",
    data: { confidence: 0.85 },
    ...overrides,
  };
}

describe("getLogPath", () => {
  it("generates correct path for a given date", () => {
    const date = new Date("2026-04-14T12:00:00Z");
    const result = getLogPath("/home/user/project", date);
    expect(result).toBe(
      join("/home/user/project", ".canon", "execution", "2026-04-14.jsonl"),
    );
  });

  it("pads single-digit month and day", () => {
    const date = new Date("2026-01-05T00:00:00Z");
    const result = getLogPath("/base", date);
    expect(result).toBe(
      join("/base", ".canon", "execution", "2026-01-05.jsonl"),
    );
  });

  it("handles year boundary (Dec 31 → Jan 1)", () => {
    const dec31 = new Date("2025-12-31T23:59:59Z");
    const jan1 = new Date("2026-01-01T00:00:00Z");
    expect(getLogPath("/base", dec31)).toContain("2025-12-31.jsonl");
    expect(getLogPath("/base", jan1)).toContain("2026-01-01.jsonl");
  });

  it("returns different paths for different dates", () => {
    const day1 = new Date("2026-04-14T00:00:00Z");
    const day2 = new Date("2026-04-15T00:00:00Z");
    expect(getLogPath("/base", day1)).not.toBe(getLogPath("/base", day2));
  });

  it("uses .jsonl extension", () => {
    const date = new Date("2026-06-15T00:00:00Z");
    expect(getLogPath("/base", date)).toMatch(/\.jsonl$/);
  });
});

describe("validateEntry", () => {
  it("accepts a valid entry", () => {
    expect(validateEntry(makeEntry())).toBe(true);
  });

  it("accepts all valid entry types", () => {
    const types: ExecutionLogEntryType[] = [
      "signal",
      "risk_check",
      "order_submit",
      "order_fill",
      "order_cancel",
      "error",
    ];
    for (const type of types) {
      expect(validateEntry(makeEntry({ type }))).toBe(true);
    }
  });

  it("rejects null", () => {
    expect(validateEntry(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(validateEntry("string")).toBe(false);
    expect(validateEntry(42)).toBe(false);
    expect(validateEntry(undefined)).toBe(false);
  });

  it("rejects missing timestamp", () => {
    const entry = makeEntry();
    const { timestamp: _, ...rest } = entry;
    expect(validateEntry(rest)).toBe(false);
  });

  it("rejects non-string timestamp", () => {
    expect(validateEntry({ ...makeEntry(), timestamp: 12345 })).toBe(false);
  });

  it("rejects missing type", () => {
    const entry = makeEntry();
    const { type: _, ...rest } = entry;
    expect(validateEntry(rest)).toBe(false);
  });

  it("rejects invalid type value", () => {
    expect(validateEntry({ ...makeEntry(), type: "invalid" })).toBe(false);
  });

  it("rejects missing automation_id", () => {
    const entry = makeEntry();
    const { automation_id: _, ...rest } = entry;
    expect(validateEntry(rest)).toBe(false);
  });

  it("rejects missing market_id", () => {
    const entry = makeEntry();
    const { market_id: _, ...rest } = entry;
    expect(validateEntry(rest)).toBe(false);
  });

  it("rejects missing data", () => {
    const entry = makeEntry();
    const { data: _, ...rest } = entry;
    expect(validateEntry(rest)).toBe(false);
  });

  it("rejects non-object data field", () => {
    expect(validateEntry({ ...makeEntry(), data: "not-object" })).toBe(false);
    expect(validateEntry({ ...makeEntry(), data: 42 })).toBe(false);
    expect(validateEntry({ ...makeEntry(), data: null })).toBe(false);
  });

  it("accepts empty data object", () => {
    expect(validateEntry(makeEntry({ data: {} }))).toBe(true);
  });
});

describe("appendEntry", () => {
  beforeEach(() => {
    mockAppendFileSync.mockClear();
    mockExistsSync.mockClear();
    mockMkdirSync.mockClear();
    mockExistsSync.mockReturnValue(true);
  });

  it("appends a JSON line to the correct file path", () => {
    const entry = makeEntry();
    appendEntry("/project", entry);

    const expectedPath = join(
      "/project",
      ".canon",
      "execution",
      "2026-04-14.jsonl",
    );
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      expectedPath,
      expect.stringContaining('"type":"signal"'),
    );
  });

  it("appends entry as valid JSON terminated by newline", () => {
    appendEntry("/project", makeEntry());

    const written = mockAppendFileSync.mock.calls[0]?.[1] as string;
    expect(written).toMatch(/\n$/);
    const parsed = JSON.parse(written.trim()) as unknown;
    expect(parsed).toMatchObject({
      type: "signal",
      automation_id: "sports-arb-v1",
      market_id: "market-123",
    });
  });

  it("creates directory if it does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    appendEntry("/project", makeEntry());

    expect(mockMkdirSync).toHaveBeenCalledWith(
      join("/project", ".canon", "execution"),
      { recursive: true },
    );
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
  });

  it("does not create directory if it already exists", () => {
    mockExistsSync.mockReturnValue(true);
    appendEntry("/project", makeEntry());

    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("throws on invalid entry", () => {
    const badEntry = { timestamp: "2026-04-14T00:00:00Z" } as ExecutionLogEntry;
    expect(() => appendEntry("/project", badEntry)).toThrow(
      /invalid execution log entry/i,
    );
  });

  it("produces one JSON object per line for multiple appends", () => {
    const lines: string[] = [];
    mockAppendFileSync.mockImplementation(
      (_path: string, content: string) => {
        lines.push(content);
      },
    );

    appendEntry("/project", makeEntry({ type: "signal" }));
    appendEntry("/project", makeEntry({ type: "risk_check" }));
    appendEntry("/project", makeEntry({ type: "order_submit" }));

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/\n$/);
      expect(() => JSON.parse(line.trim())).not.toThrow();
    }

    const types = lines.map(
      (l) => (JSON.parse(l.trim()) as { type: string }).type,
    );
    expect(types).toEqual(["signal", "risk_check", "order_submit"]);
  });

  it("uses the entry timestamp for file path date", () => {
    const entry = makeEntry({ timestamp: "2026-01-05T08:30:00.000Z" });
    appendEntry("/project", entry);

    const expectedPath = join(
      "/project",
      ".canon",
      "execution",
      "2026-01-05.jsonl",
    );
    expect(mockAppendFileSync).toHaveBeenCalledWith(
      expectedPath,
      expect.any(String),
    );
  });
});
