import { describe, expect, it } from "bun:test";
import {
  normCdf,
  estimateDailySigma,
  buildAssetLiquidationMap,
  formatLiquidationMap,
  LEVERAGE_TIERS,
} from "../skills/liquidation/levels";

describe("normCdf", () => {
  it("matches known standard-normal values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 5);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normCdf(1)).toBeCloseTo(0.8413, 3);
  });
});

describe("estimateDailySigma", () => {
  it("floors at the per-asset baseline when the move is quiet", () => {
    expect(estimateDailySigma("BTC", 0.1)).toBeCloseTo(0.025, 5); // baseline floor
    expect(estimateDailySigma("ETH", undefined)).toBeCloseTo(0.032, 5);
  });
  it("uses the recent move when it exceeds the baseline, capped at 25%", () => {
    expect(estimateDailySigma("BTC", 8)).toBeCloseTo(0.08, 5);
    expect(estimateDailySigma("BNB", 99)).toBeCloseTo(0.25, 5); // capped
  });
});

describe("buildAssetLiquidationMap", () => {
  const m = buildAssetLiquidationMap("BTC", 100_000, 2);

  it("places long liqs below and short liqs above spot at 1/L distance", () => {
    expect(m.longs.map((l) => l.leverage)).toEqual([...LEVERAGE_TIERS]);
    // 100x → 1% , 50x → 2% , 25x → 4%
    expect(m.longs[0].price).toBeCloseTo(99_000, 0);
    expect(m.longs[2].price).toBeCloseTo(96_000, 0);
    expect(m.shorts[0].price).toBeCloseTo(101_000, 0);
    expect(m.shorts[2].price).toBeCloseTo(104_000, 0);
    expect(m.longs.every((l) => l.price < m.price)).toBe(true);
    expect(m.shorts.every((l) => l.price > m.price)).toBe(true);
  });

  it("touch probability falls as the level gets farther (lower leverage)", () => {
    const p = m.longs.map((l) => l.touchProb);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(p[1]).toBeGreaterThan(p[2]);
    expect(p[0]).toBeLessThanOrEqual(0.99);
    expect(p[2]).toBeGreaterThan(0);
  });

  it("higher volatility raises every touch probability", () => {
    const calm = buildAssetLiquidationMap("BTC", 100_000, 0.5); // floored to baseline
    const wild = buildAssetLiquidationMap("BTC", 100_000, 12); // 12% day
    for (let i = 0; i < LEVERAGE_TIERS.length; i++)
      expect(wild.longs[i].touchProb).toBeGreaterThan(calm.longs[i].touchProb);
  });
});

describe("formatLiquidationMap", () => {
  it("renders numeric levels for each side, no prose", () => {
    const out = formatLiquidationMap([
      buildAssetLiquidationMap("ETH", 2500, 3),
    ]);
    expect(out).toContain("ETH — $2,500");
    expect(out).toContain("Long liqs (price ↓):");
    expect(out).toContain("Short liqs (price ↑):");
    expect(out).toMatch(/100× → \$2,475 \(-1%\) · ~\d+%/);
    expect(out).toMatch(/100× → \$2,525 \(\+1%\) · ~\d+%/);
  });
});
