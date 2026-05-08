import { describe, it, expect } from "vitest";
import {
  normalize,
  textMentionsTeam,
  extractTeamOdds,
  type TeamOdds,
} from "../runner.js";
import { DEFAULT_CONFIG } from "../config/strategy.js";
import { DEFAULT_RISK_CONFIG } from "../config/risk.js";
import { shouldFlag } from "../service/signals.js";
import { checkRiskLimits } from "../service/risk.js";
import { FuturesScanner } from "../strategy.js";

describe("normalize", () => {
  // TODO: AI fills in assertions based on runner logic

  it("lowercases and strips non-alphanumeric characters", () => {
    expect(normalize("Los Angeles Lakers")).toBe("los angeles lakers");
  });

  it("strips special characters", () => {
    // TODO: assert normalize("76ers") handles the number correctly
    expect(normalize("76ers")).toBe("76ers");
  });
});

describe("textMentionsTeam", () => {
  // TODO: AI fills in assertions testing fuzzy match + alias support

  it("matches full team name in question", () => {
    const q = "Will the Oklahoma City Thunder win the 2026 NBA Finals?";
    expect(textMentionsTeam(q, "Oklahoma City Thunder")).toBe(true);
  });

  it("matches last word of team name", () => {
    const q = "Will the Thunder win?";
    // TODO: assert match via last-word fallback
    expect(textMentionsTeam(q, "Oklahoma City Thunder")).toBe(true);
  });

  it("does not match unrelated teams", () => {
    const q = "Will the Lakers win?";
    expect(textMentionsTeam(q, "Boston Celtics")).toBe(false);
  });

  it("matches via alias table", () => {
    // TODO: assert 76ers alias matches "philadelphia" or "sixers"
    const q = "Will the Philadelphia 76ers win?";
    expect(textMentionsTeam(q, "Philadelphia 76ers")).toBe(true);
  });
});

describe("extractTeamOdds", () => {
  it("computes average implied probability from multiple bookmakers", () => {
    // Two bookmakers: odds 4.0 (25%) and 5.0 (20%) → avg 22.5%
    const events = [
      {
        id: "ev1",
        homeTeam: "",
        awayTeam: "",
        commence: new Date(),
        bookmakers: [
          {
            key: "dk",
            title: "DraftKings",
            markets: [
              {
                key: "outrights",
                outcomes: [{ name: "Team A", price: 4.0 }],
              },
            ],
          },
          {
            key: "fd",
            title: "FanDuel",
            markets: [
              {
                key: "outrights",
                outcomes: [{ name: "Team A", price: 5.0 }],
              },
            ],
          },
        ],
      },
    ];

    const result = extractTeamOdds(events);
    // TODO: assert result has Team A with ~22.5% implied probability
    expect(result).toHaveLength(1);
    expect(result[0]?.team).toBe("Team A");
    expect(result[0]?.impliedProb).toBeCloseTo(0.225, 3);
    expect(result[0]?.sources).toBe(2);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has a mispricing threshold matching the strategy spec", () => {
    // TODO: assert threshold matches spec value
    expect(DEFAULT_CONFIG.mispricingThreshold).toBe(0.005);
  });
});

describe("DEFAULT_RISK_CONFIG", () => {
  it("requires at least 2 bookmaker sources", () => {
    // TODO: assert minBookmakerSources matches spec value
    expect(DEFAULT_RISK_CONFIG.minBookmakerSources).toBe(2);
  });
});

describe("shouldFlag", () => {
  // TODO: AI verifies these assertions match the shouldFlag implementation

  it("returns signal when delta exceeds threshold", () => {
    // sportsbookProb=0.15, polymarketPrice=0.10, delta=0.05 > 0.005
    const result = shouldFlag(0.15, 0.1, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe("sportsbook higher");
    expect(result?.absDelta).toBeCloseTo(0.05, 3);
  });

  it("returns null when delta below threshold", () => {
    // sportsbookProb=0.15, polymarketPrice=0.148, delta=0.002 < 0.005
    const result = shouldFlag(0.15, 0.148, DEFAULT_CONFIG);
    expect(result).toBeNull();
  });

  it("detects Polymarket higher direction", () => {
    // sportsbookProb=0.10, polymarketPrice=0.15, delta=-0.05
    const result = shouldFlag(0.1, 0.15, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe("Polymarket higher");
  });
});

describe("checkRiskLimits", () => {
  // TODO: AI verifies these assertions match the checkRiskLimits implementation

  it("approves when sources meet minimum", () => {
    expect(checkRiskLimits({ sources: 3 }, DEFAULT_RISK_CONFIG)).toBe(true);
  });

  it("rejects when sources below minimum", () => {
    expect(checkRiskLimits({ sources: 1 }, DEFAULT_RISK_CONFIG)).toBe(false);
  });

  it("approves at exact minimum", () => {
    expect(
      checkRiskLimits(
        { sources: DEFAULT_RISK_CONFIG.minBookmakerSources },
        DEFAULT_RISK_CONFIG,
      ),
    ).toBe(true);
  });
});

describe("FuturesScanner", () => {
  // TODO: AI fills in assertions verifying the wiring class

  it("returns signals for teams with sufficient delta and sources", () => {
    const scanner = new FuturesScanner(DEFAULT_CONFIG, DEFAULT_RISK_CONFIG);
    const comparisons = [
      {
        team: "Team A",
        sportsbookProb: 0.15,
        polymarketPrice: 0.1,
        delta: 0.05,
        sources: 3,
      },
    ];
    const signals = scanner.evaluate(comparisons);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.team).toBe("Team A");
  });

  it("filters out teams with insufficient sources", () => {
    const scanner = new FuturesScanner(DEFAULT_CONFIG, DEFAULT_RISK_CONFIG);
    const comparisons = [
      {
        team: "Team B",
        sportsbookProb: 0.15,
        polymarketPrice: 0.1,
        delta: 0.05,
        sources: 1,
      },
    ];
    const signals = scanner.evaluate(comparisons);
    expect(signals).toHaveLength(0);
  });

  it("filters out teams with delta below threshold", () => {
    const scanner = new FuturesScanner(DEFAULT_CONFIG, DEFAULT_RISK_CONFIG);
    const comparisons = [
      {
        team: "Team C",
        sportsbookProb: 0.15,
        polymarketPrice: 0.148,
        delta: 0.002,
        sources: 3,
      },
    ];
    const signals = scanner.evaluate(comparisons);
    expect(signals).toHaveLength(0);
  });
});
