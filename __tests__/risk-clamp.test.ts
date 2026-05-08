import { describe, expect, it } from "vitest";

import { clampToHeadroom, type NamedCap } from "../risk-clamp.js";

describe("clampToHeadroom", () => {
  it("approves at the requested size when no cap binds", () => {
    const decision = clampToHeadroom(100, [
      { name: "per-position", value: 1_000 },
      { name: "live capital", value: 5_000 },
    ]);
    expect(decision.approved).toBe(true);
    expect(decision.modified_size).toBeUndefined();
  });

  it("approves at the requested size when caps list is empty", () => {
    expect(clampToHeadroom(100, [])).toStrictEqual({ approved: true });
  });

  it("clamps to the binding cap and reports modified_size", () => {
    const decision = clampToHeadroom(1_000, [
      { name: "per-position", value: 1_000 },
      { name: "live capital", value: 9.83 },
    ]);
    expect(decision.approved).toBe(true);
    expect(decision.modified_size).toBe(9.83);
  });

  it("rejects when the binding cap is below the fillable floor", () => {
    const decision = clampToHeadroom(1_000, [
      { name: "live capital", value: 0 },
    ]);
    expect(decision.approved).toBe(false);
    expect(decision.rejection_reason).toMatch(/no headroom/i);
    expect(decision.rejection_reason).toContain("live capital");
  });

  it("rejects when a cap is negative (already over-exposed)", () => {
    const decision = clampToHeadroom(500, [
      { name: "aggregate headroom", value: -100 },
      { name: "live capital", value: 200 },
    ]);
    expect(decision.approved).toBe(false);
    expect(decision.rejection_reason).toContain("aggregate headroom");
    expect(decision.rejection_reason).toContain("$-100.00");
  });

  it("uses a custom fillable floor", () => {
    const decision = clampToHeadroom(100, [
      { name: "live capital", value: 0.5 },
    ], { minFillable: 1 });
    expect(decision.approved).toBe(false);
  });

  it("names the tightest binding cap, not the first listed", () => {
    const decision = clampToHeadroom(10, [
      { name: "per-position", value: 8 },
      { name: "aggregate headroom", value: 5 },
      { name: "live capital", value: 7 },
    ]);
    expect(decision.approved).toBe(true);
    expect(decision.modified_size).toBe(5);
  });

  it("includes every cap value in the rejection summary", () => {
    const caps: NamedCap[] = [
      { name: "per-position", value: 0 },
      { name: "live capital", value: 200 },
    ];
    const decision = clampToHeadroom(100, caps);
    expect(decision.approved).toBe(false);
    expect(decision.rejection_reason).toContain("per-position $0.00");
    expect(decision.rejection_reason).toContain("live capital $200.00");
  });
});
