/**
 * x402 micropayments via the TWAK CLI.
 *
 * Lets Astraeus pay-per-request for x402-gated data / inference / tools as part
 * of its loop — self-custody (TWAK signs the payment authorization from the
 * keychain wallet). x402 is named explicitly in the "Best Use of TWAK" rubric.
 *
 *   quote   -> twak x402 quote <url> --json                 (read-only, no payment)
 *   request -> twak x402 request <url> --max-payment N --yes --json   (pays if gated)
 */
import { runTwak, asRecord, pickNumber, pickString } from "./twakCli";

export interface X402Result {
  ok: boolean;
  /** True if a payment was actually signed/broadcast. */
  paid?: boolean;
  txHash?: string;
  /** Atomic-unit price the endpoint requested, if reported. */
  priceAtomic?: number;
  /** The endpoint's response body (the data you paid for), if parseable. */
  body?: string;
  error?: string;
  raw: string;
}

/** Preview an x402 endpoint's price without paying (read-only, no wallet needed). */
export async function quoteX402(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<X402Result> {
  const { json, raw } = await runTwak(["x402", "quote", url, "--json"], {
    timeoutMs: opts.timeoutMs,
  });
  const obj = asRecord(json);
  if (obj.error || obj.errorCode)
    return { ok: false, error: String(obj.error ?? obj.errorCode), raw };
  const priceAtomic = pickNumber(obj, [
    "maxAmountRequired",
    "price",
    "amount",
    "atomic",
  ]);
  return { ok: true, paid: false, priceAtomic, raw };
}

/**
 * Make an x402-gated request, auto-approving payment up to `maxPaymentAtomic`
 * (atomic units, e.g. "10000" = 0.01 USDC at 6dp). Defaults to X402_MAX_PAYMENT
 * or a conservative cap.
 *
 * Network selection matters: CMC's x402 endpoints advertise their *preferred*
 * route as a stablecoin on BSC priced in 18 decimals (0.01 = 1e16 atomic), which
 * blows past the 6-dp `--max-payment 10000` cap with PAYMENT_AMOUNT_EXCEEDED.
 * We pin the route to Base by default (X402_PREFER_NETWORK, default "base"),
 * where the same call is 10000 atomic of USDC (6dp) — within the cap and the chain
 * the agent wallet actually holds USDC on. Pass preferNetwork: "" to let TWAK choose.
 */
export async function requestX402(
  url: string,
  opts: {
    maxPaymentAtomic?: string;
    method?: string;
    preferNetwork?: string;
    /** Hard timeout in ms (default 180000; pass a short value for in-loop use). */
    timeoutMs?: number;
  } = {},
): Promise<X402Result> {
  const maxPayment =
    opts.maxPaymentAtomic ?? process.env.X402_MAX_PAYMENT ?? "10000";
  const preferNetwork =
    opts.preferNetwork ?? process.env.X402_PREFER_NETWORK ?? "base";
  const args = [
    "x402",
    "request",
    url,
    "--max-payment",
    maxPayment,
    "--yes",
    "--json",
  ];
  if (opts.method) args.push("--method", opts.method);
  if (preferNetwork) args.push("--prefer-network", preferNetwork);
  const { json, raw } = await runTwak(args, {
    timeoutMs: opts.timeoutMs ?? 180_000,
  });
  const obj = asRecord(json);
  if (obj.error || obj.errorCode)
    return { ok: false, error: String(obj.error ?? obj.errorCode), raw };
  const txHash = pickString(obj, [
    "txHash",
    "hash",
    "transactionHash",
    "paymentTx",
    "settlementTx",
  ]);
  const body =
    pickString(obj, ["body", "data", "response", "result", "content"]) ??
    (typeof obj.body === "object" && obj.body
      ? JSON.stringify(obj.body)
      : undefined);
  return { ok: true, paid: !!txHash, txHash, body, raw };
}
