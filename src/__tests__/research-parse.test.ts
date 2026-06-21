import { describe, expect, it } from "bun:test";
import { parseSymbol } from "../actions/research";

/**
 * Regression tests for RESEARCH token parsing — in particular the bug where
 * "research on CAKE" resolved to the token "ON" (the preposition) instead of CAKE.
 */
describe("research parseSymbol", () => {
  it('parses "research on CAKE" as CAKE, not the preposition "ON"', () => {
    expect(parseSymbol("research on CAKE")).toBe("CAKE");
    expect(parseSymbol("research on cake")).toBe("CAKE");
  });

  it("handles the other natural phrasings", () => {
    expect(parseSymbol("research CAKE")).toBe("CAKE");
    expect(parseSymbol("dd on AAVE")).toBe("AAVE");
    expect(parseSymbol("due diligence on BNB")).toBe("BNB");
    expect(parseSymbol("fundamentals of LINK")).toBe("LINK");
    expect(parseSymbol("analyze the UNI token")).toBe("UNI");
    expect(parseSymbol("$DOGE")).toBe("DOGE");
  });

  it('still resolves a genuine "research ON" (ON is a real token) when nothing follows', () => {
    expect(parseSymbol("research ON")).toBe("ON");
  });

  it("does not return filler/stopwords as a symbol", () => {
    expect(parseSymbol("research the price")).toBeUndefined();
    expect(parseSymbol("do some research please")).toBeUndefined();
  });
});
