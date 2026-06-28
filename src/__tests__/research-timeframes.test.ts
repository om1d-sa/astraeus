import { describe, expect, it } from "bun:test";
import type { CmcTechnicals } from "../data/cmc";
import {
  TF_WEIGHT,
  biasEmoji,
  formatMacd,
  formatTechnicalRow,
  formatVerdict,
  parseTimeframe,
  readingFromTechnicals,
  readingsFromMulti,
  synthesizeVerdict,
  technicalSignals,
  timeframeScore,
  type TimeframeReading,
} from "../skills/research/timeframes";

/**
 * Component tests for the multi-timeframe research verdict — the deterministic core of
 * the new RESEARCH card (1h/4h/daily/weekly → bias + confidence + price target). Pure
 * math, so these run with NO network and spend ZERO CMC credits.
 */

const tech = (over: Partial<CmcTechnicals> = {}): CmcTechnicals => ({
  rsi14: 55,
  ema12: 101,
  ema26: 100,
  macd: 1,
  volPct: 0.03,
  lastClose: 100,
  points: 60,
  ...over,
});

const reading = (over: Partial<TimeframeReading>): TimeframeReading => ({
  label: "1D",
  rsi14: 55,
  macd: 1,
  lastClose: 100,
  volPct: 0.03,
  points: 60,
  ...over,
});

describe("timeframeScore", () => {
  it("is positive when RSI > 50 and MACD > 0, negative in the mirror case", () => {
    const bull = timeframeScore(reading({ rsi14: 70, macd: 2 }));
    const bear = timeframeScore(reading({ rsi14: 30, macd: -2 }));
    expect(bull).toBeGreaterThan(0);
    expect(bear).toBeLessThan(0);
    expect(bull).toBeCloseTo(-(bear as number), 6); // symmetric inputs → symmetric score
  });

  it("returns undefined when the frame has too few data points", () => {
    expect(timeframeScore(reading({ points: 13 }))).toBeUndefined();
  });

  it("returns undefined when no indicator is present", () => {
    expect(
      timeframeScore(reading({ rsi14: undefined, macd: undefined })),
    ).toBeUndefined();
  });

  it("dampens overbought RSI toward an exhaustion cap (≤0.6 from RSI)", () => {
    // RSI 95 alone (no MACD) maps to the 0.6 cap, NOT (95-50)/50 = 0.9.
    const s = timeframeScore(reading({ rsi14: 95, macd: undefined }));
    expect(s).toBeCloseTo(0.6, 6);
  });

  it("normalizes MACD by price so magnitude is asset-agnostic", () => {
    // Same 2% EMA gap on a $100 and a $50,000 asset → same MACD contribution.
    const cheap = timeframeScore(reading({ rsi14: 50, macd: 2, lastClose: 100 }));
    const dear = timeframeScore(
      reading({ rsi14: 50, macd: 1000, lastClose: 50000 }),
    );
    expect(cheap).toBeCloseTo(dear as number, 6);
  });
});

describe("synthesizeVerdict", () => {
  const allBull: TimeframeReading[] = [
    reading({ label: "1h", rsi14: 68, macd: 1 }),
    reading({ label: "4h", rsi14: 70, macd: 1.2 }),
    reading({ label: "1D", rsi14: 72, macd: 1.6, volPct: 0.03 }),
    reading({ label: "1W", rsi14: 65, macd: 0.8 }),
  ];

  it("calls a uniformly bullish stack bullish with high confidence and an upside target", () => {
    const v = synthesizeVerdict(allBull, 100);
    expect(v.bias).toBe("bullish");
    expect(v.score).toBeGreaterThan(0.15);
    expect(v.confidence).toBeGreaterThan(0.6);
    expect(v.targetPrice).toBeGreaterThan(100);
    expect(v.targetPct).toBeGreaterThan(0);
  });

  it("mirrors to bearish with a downside target for the inverse stack", () => {
    const bear = allBull.map((r) => ({
      ...r,
      rsi14: 100 - (r.rsi14 as number),
      macd: -(r.macd as number),
    }));
    const v = synthesizeVerdict(bear, 100);
    expect(v.bias).toBe("bearish");
    expect(v.targetPrice).toBeLessThan(100);
    expect(v.targetPct).toBeLessThan(0);
  });

  it("returns a low-confidence neutral with no target when timeframes conflict", () => {
    const mixed: TimeframeReading[] = [
      reading({ label: "1h", rsi14: 75, macd: 2 }),
      reading({ label: "4h", rsi14: 25, macd: -2 }),
      reading({ label: "1D", rsi14: 52, macd: 0.1 }),
      reading({ label: "1W", rsi14: 48, macd: -0.1 }),
    ];
    const v = synthesizeVerdict(mixed, 100);
    expect(v.bias).toBe("neutral");
    expect(v.confidence).toBeLessThan(0.5);
    expect(v.targetPrice).toBeUndefined();
  });

  it("folds in CMC-skill sentiment as an extra weighted input", () => {
    const base = synthesizeVerdict(allBull, 100);
    const dragged = synthesizeVerdict(allBull, 100, { skillSentiment: -1 });
    // A strongly bearish skill read pulls the blended score down.
    expect(dragged.score).toBeLessThan(base.score);
    expect(dragged.contributions.some((c) => c.label === "skill")).toBe(true);
  });

  it("ignores a non-finite skill sentiment", () => {
    const v = synthesizeVerdict(allBull, 100, { skillSentiment: NaN });
    expect(v.contributions.some((c) => c.label === "skill")).toBe(false);
  });

  it("is a zero-confidence neutral when nothing is scorable", () => {
    const v = synthesizeVerdict(
      [reading({ points: 5 }), reading({ label: "1W", points: 3 })],
      100,
    );
    expect(v).toMatchObject({ bias: "neutral", confidence: 0, score: 0 });
    expect(v.targetPrice).toBeUndefined();
  });

  it("caps the projected target at ±30% even with extreme volatility", () => {
    const wild = allBull.map((r) =>
      r.label === "1D" ? { ...r, volPct: 5 } : r,
    );
    const v = synthesizeVerdict(wild, 100);
    expect(v.targetPct as number).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it("falls back to another frame's volatility for the target when daily lacks it", () => {
    const noDailyVol = allBull.map((r) =>
      r.label === "1D" ? { ...r, volPct: undefined } : r,
    );
    const v = synthesizeVerdict(noDailyVol, 100);
    expect(v.bias).toBe("bullish");
    expect(v.targetPrice).toBeGreaterThan(100); // anchored on 4h/1W/1h vol instead
  });

  it("omits the target only when NO frame has volatility data", () => {
    const noVol = allBull.map((r) => ({ ...r, volPct: undefined }));
    const v = synthesizeVerdict(noVol, 100);
    expect(v.bias).toBe("bullish");
    expect(v.targetPrice).toBeUndefined();
  });

  it("gives a single-timeframe request its own target (anchor fallback)", () => {
    // "research X on 4h" → one reading; the 4h frame must still anchor a target.
    const v = synthesizeVerdict(
      [reading({ label: "4h", rsi14: 72, macd: 1.5, volPct: 0.02 })],
      100,
    );
    expect(v.bias).toBe("bullish");
    expect(v.targetPrice).toBeGreaterThan(100);
  });
});

describe("readings adapters", () => {
  it("readingFromTechnicals copies the indicator fields under a label", () => {
    const r = readingFromTechnicals("4h", tech({ rsi14: 61, points: 42 }));
    expect(r).toMatchObject({ label: "4h", rsi14: 61, points: 42 });
  });

  it("readingsFromMulti yields one reading per present timeframe, fast→slow", () => {
    const readings = readingsFromMulti({
      "1h": tech(),
      "1D": tech(),
      "1W": tech(),
      // 4h intentionally absent
    });
    expect(readings.map((r) => r.label)).toEqual(["1h", "1D", "1W"]);
  });
});

describe("formatting", () => {
  it("biasEmoji maps each bias to its marker", () => {
    expect(biasEmoji("bullish")).toBe("🟢");
    expect(biasEmoji("bearish")).toBe("🔴");
    expect(biasEmoji("neutral")).toBe("⚪");
  });

  it("formatTechnicalRow renders RSI + normalized MACD + EMA trend arrow", () => {
    expect(
      formatTechnicalRow(tech({ rsi14: 83, macd: 1.6, lastClose: 100, ema12: 101, ema26: 100 })),
    ).toBe("RSI14 83, MACD bullish (+1.60%), EMA ▲");
    expect(
      formatTechnicalRow(tech({ rsi14: 40, macd: -0.4, lastClose: 100, ema12: 99, ema26: 100 })),
    ).toBe("RSI14 40, MACD bearish (-0.40%), EMA ▼");
  });

  it("formatMacd normalizes by price so low-priced tokens are not rounded to +0.0", () => {
    // The SIREN bug: macd 0.0002 on a $0.077 token shows "+0.0" raw, but +0.26% normalized.
    expect(formatMacd(tech({ macd: 0.0002, lastClose: 0.077 }))).toBe("bullish (+0.26%)");
    expect(formatMacd(tech({ macd: -0.0002, lastClose: 0.077 }))).toBe("bearish (-0.26%)");
  });

  it("formatVerdict shows bias, confidence and the target line", () => {
    const v = synthesizeVerdict(
      [
        reading({ label: "1h", rsi14: 68, macd: 1 }),
        reading({ label: "4h", rsi14: 70, macd: 1.2 }),
        reading({ label: "1D", rsi14: 72, macd: 1.6, volPct: 0.03 }),
        reading({ label: "1W", rsi14: 65, macd: 0.8 }),
      ],
      100,
    );
    const line = formatVerdict(v, 100) as string;
    expect(line).toContain("🟢 Bullish");
    expect(line).toMatch(/confidence \d+%/);
    expect(line).toContain("target $");
  });

  it("formatVerdict returns undefined for a zero-confidence neutral", () => {
    const v = synthesizeVerdict([reading({ points: 5 })], 100);
    expect(formatVerdict(v, 100)).toBeUndefined();
  });
});

describe("weights", () => {
  it("weights every timeframe and leans on the slower frames", () => {
    expect(Object.keys(TF_WEIGHT).sort()).toEqual(["1D", "1W", "1h", "4h"]);
    expect(TF_WEIGHT["1D"]).toBeGreaterThan(TF_WEIGHT["1h"]);
  });
});

describe("parseTimeframe", () => {
  it("pulls the requested timeframe from natural phrasings", () => {
    expect(parseTimeframe("research SIREN on daily")).toBe("1D");
    expect(parseTimeframe("research BTC weekly")).toBe("1W");
    expect(parseTimeframe("dd on ETH hourly")).toBe("1h");
    expect(parseTimeframe("analyze AAVE on the 4 hour")).toBe("4h");
    expect(parseTimeframe("research LINK 1d")).toBe("1D");
    expect(parseTimeframe("research DOGE 1w")).toBe("1W");
  });

  it("does not confuse '4 hour' with the 1-hour frame", () => {
    expect(parseTimeframe("research SIREN 4h")).toBe("4h");
    expect(parseTimeframe("research SIREN four-hour")).toBe("4h");
  });

  it("returns undefined when no timeframe is named (→ full multi-timeframe view)", () => {
    expect(parseTimeframe("research SIREN")).toBeUndefined();
    expect(parseTimeframe("due diligence on AAVE")).toBeUndefined();
  });
});

describe("technicalSignals (expanded breakdown)", () => {
  it("emits an interpreted line per indicator", () => {
    const lines = technicalSignals(
      tech({ rsi14: 13, macd: -0.0002, lastClose: 0.077, ema12: 0.075, ema26: 0.079, volPct: 0.083 }),
      0.077,
    );
    expect(lines.some((l) => l.startsWith("RSI14: 13 (oversold)"))).toBe(true);
    expect(lines.some((l) => l.includes("MACD: bearish (-0.26%)"))).toBe(true);
    expect(lines.some((l) => l.includes("downtrend"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Price vs EMA26:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Volatility: 8.3%"))).toBe(true);
  });

  it("tags an overbought RSI and an uptrend EMA cross", () => {
    const lines = technicalSignals(
      tech({ rsi14: 83, ema12: 110, ema26: 100 }),
    );
    expect(lines[0]).toBe("RSI14: 83 (overbought)");
    expect(lines.some((l) => l.includes("uptrend"))).toBe(true);
  });

  it("skips indicators that are absent", () => {
    const lines = technicalSignals(
      tech({ rsi14: undefined, ema12: undefined, ema26: undefined, volPct: undefined }),
    );
    expect(lines.some((l) => l.startsWith("RSI14:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("EMA12"))).toBe(false);
  });
});
