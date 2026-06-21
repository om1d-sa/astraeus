import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { quoteX402, requestX402 } from "../exec/x402";

function parseUrl(text: string): string | undefined {
  const m = text.match(/\bhttps?:\/\/\S+/i);
  return m?.[0]?.replace(/[).,]+$/, "");
}

/** Pull a "--max-payment <atomic>" or "max 10000" hint from the message. */
function parseMaxPayment(text: string): string | undefined {
  const m = text.match(/\bmax(?:[\s-]?payment)?\s*[:=]?\s*(\d{2,})\b/i);
  return m?.[1];
}

/**
 * Pull a chain hint ("on base", "network bsc", "eip155:8453") from the message.
 * Undefined falls back to requestX402's default (X402_PREFER_NETWORK / "base"),
 * which keeps CMC's x402 calls on the 6-dp Base USDC route the wallet can afford.
 */
function parseNetwork(text: string): string | undefined {
  const m = text.match(/\b(?:on|network|chain|prefer-?network)\s*[:=]?\s*(base|bsc|eip155:\d+)\b/i);
  return m?.[1]?.toLowerCase();
}

/**
 * X402_PAY — pay-per-request to an x402-gated endpoint via TWAK (self-custody).
 *
 * "quote" previews the price (read-only); "request"/"pay" makes the call and
 * signs a payment authorization if the endpoint requires one. x402 is called out
 * in the TWAK special-prize rubric, and lets the agent pay for data/inference in
 * its loop.
 */
export const x402PayAction: Action = {
  name: "X402_PAY",
  similes: [
    "X402",
    "X402_REQUEST",
    "X402_QUOTE",
    "PAY_PER_REQUEST",
    "MICROPAYMENT",
  ],
  description:
    'Call an x402-gated HTTP endpoint via TWAK: "x402 quote <url>" previews the price (no payment); "x402 request/pay <url>" makes the call and pays if required. Use for x402 / pay-per-request data or inference.',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    return (
      /\bx402\b/.test(t) ||
      (/\bpay[\s-]?per[\s-]?request\b/.test(t) && /\bhttps?:\/\//.test(t))
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text ?? "";
    const url = parseUrl(text);
    if (!url) {
      await callback?.({
        text: 'Include the endpoint URL — e.g. "x402 quote https://api.example.com/data".',
        error: true,
      });
      return { text: "no url", success: false };
    }
    // Default to the safe, read-only quote unless the user clearly wants to pay.
    const wantsPay =
      /\b(request|pay|fetch|call|buy|get)\b/i.test(text) &&
      !/\b(quote|preview|price|how much)\b/i.test(text);

    try {
      if (!wantsPay) {
        const r = await quoteX402(url);
        if (!r.ok) {
          await callback?.({
            text: `x402 quote failed: ${r.error}`,
            error: true,
          });
          return { text: "quote failed", success: false };
        }
        const txt = `💱 x402 quote for ${url}${r.priceAtomic !== undefined ? `\n• Price: ${r.priceAtomic} atomic units` : "\n• (endpoint did not require payment, or price not reported)"}`;
        await callback?.({ text: txt, actions: ["X402_PAY"] });
        return {
          text: txt,
          success: true,
          values: { url, priceAtomic: r.priceAtomic },
          data: { actionName: "X402_PAY", quote: r },
        };
      }

      await callback?.({
        text: `Making x402 request to ${url} (will sign a payment if the endpoint requires one)…`,
      });
      const r = await requestX402(url, {
        maxPaymentAtomic: parseMaxPayment(text),
        preferNetwork: parseNetwork(text),
      });
      if (!r.ok) {
        await callback?.({
          text: `x402 request failed: ${r.error}`,
          error: true,
        });
        return {
          text: "request failed",
          success: false,
          values: { error: r.error },
        };
      }
      const txt =
        `✅ x402 request to ${url} succeeded` +
        (r.paid
          ? `\n• Paid on-chain${r.txHash ? ` · tx ${r.txHash}` : ""}`
          : "\n• No payment was required");
      await callback?.({ text: txt, actions: ["X402_PAY"] });
      logger.info(
        { url, paid: r.paid, txHash: r.txHash },
        "x402 request complete",
      );
      return {
        text: txt,
        success: true,
        values: { url, paid: r.paid, txHash: r.txHash },
        data: { actionName: "X402_PAY", result: r },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "X402_PAY failed");
      await callback?.({ text: `x402 error: ${msg}`, error: true });
      return {
        text: "error",
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "x402 quote https://api.example.com/signal" },
      },
      {
        name: "Astraeus",
        content: {
          text: "💱 x402 quote for https://api.example.com/signal\n• Price: 10000 atomic units",
          actions: ["X402_PAY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "x402 request https://api.example.com/signal" },
      },
      {
        name: "Astraeus",
        content: {
          text: "✅ x402 request … succeeded\n• Paid on-chain · tx 0x…",
          actions: ["X402_PAY"],
        },
      },
    ],
  ],
};

export default x402PayAction;
