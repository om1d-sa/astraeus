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
  // The CMC x402 gateway (and twak's RPC layer) is slow (~10–15s/call) and
  // intermittently exceeds twak's internal HTTP timeout, surfacing as
  // `{"error":"fetch failed"}`. Retry such TRANSIENT failures — but ONLY when this
  // attempt signed no payment, so a retry can never double-spend (a post-payment
  // fetch failure is returned as-is). Tunable via X402_RETRIES (default 2; set 1 to
  // disable). The transient "fetch failed" happens on the pre-payment challenge
  // fetch, so retrying it costs nothing.
  const TRANSIENT =
    /fetch failed|timeout|timed out|network|socket|terminated|ECONN|ENOTFOUND|EAI_AGAIN/i;
  const parsedRetries = Number(process.env.X402_RETRIES ?? "2");
  const maxAttempts = Math.max(1, Number.isFinite(parsedRetries) ? parsedRetries : 2);
  let lastErr = "";
  let lastRaw = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { json, raw, stderr } = await runTwak(args, {
      timeoutMs: opts.timeoutMs ?? 180_000,
    });
    lastRaw = raw;
    const obj = asRecord(json);
    const paidSigned = /payment authorization signed/i.test(stderr);
    if (obj.error || obj.errorCode) {
      lastErr = String(obj.error ?? obj.errorCode);
      // Retry a transient network failure ONLY if no payment was signed this attempt.
      if (attempt < maxAttempts && !paidSigned && TRANSIENT.test(lastErr)) continue;
      return { ok: false, error: lastErr, raw };
    }
    const txHash = pickString(obj, [
      "txHash",
      "hash",
      "transactionHash",
      "paymentTx",
      "settlementTx",
    ]);
    // Resource body: prefer a string field, else stringify the first object/array
    // payload key. CMC's x402 quotes endpoint returns the paid data under `data` as
    // an ARRAY (not a string), so the old string-only pick missed it and the caller
    // fell back to the raw envelope (losing the data past truncation). Cover
    // objects/arrays across every payload key.
    const DATA_KEYS = ["body", "data", "response", "result", "content"];
    let body = pickString(obj, DATA_KEYS);
    if (!body) {
      for (const k of DATA_KEYS) {
        const v = obj[k];
        if (v && typeof v === "object") {
          body = JSON.stringify(v);
          break;
        }
      }
    }
    // Gasless (eip3009) payments settle via the facilitator and surface no txHash in
    // the JSON — and twak prints the payment confirmation ("payment authorization
    // signed") to STDERR, while stdout (`raw`) holds only the JSON data. So detect
    // payment from stderr (fall back to raw in case a future twak writes it there),
    // otherwise `paid` is a false negative even though the payment happened.
    const paid =
      !!txHash ||
      /payment authorization signed|x402: paying\b/i.test(`${stderr}\n${raw}`);
    return { ok: true, paid, txHash, body, raw };
  }
  return { ok: false, error: lastErr || "x402 request failed", raw: lastRaw };
}
