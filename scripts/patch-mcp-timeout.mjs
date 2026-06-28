// Persist a fix for @elizaos/plugin-mcp's hardcoded 60s connection timeout.
//
// The plugin races client.connect() against a literal `setTimeout(..., 60000)`
// (dist/index.js ~L1890) and ignores every config/env knob, so a slow or
// cold-start MCP handshake (e.g. cmc-skill-hub behind CloudFront/WARP) is killed
// at exactly 60s with no override. This rewrites that literal to read
// MCP_CONNECT_TIMEOUT_MS (falling back to 60000), and runs on postinstall so it
// survives `bun install` reinstalling node_modules. Idempotent and best-effort:
// never fails the install if the plugin is absent or already patched.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "node_modules/@elizaos/plugin-mcp/dist/index.js",
  "node_modules/@elizaos/plugin-mcp/dist/cjs/index.cjs",
];

const NEEDLE = "Timeout connecting to ${name}`)), 60000))";
const PATCHED =
  "Timeout connecting to ${name}`)), Number(process.env.MCP_CONNECT_TIMEOUT_MS) || 60000))";

for (const rel of targets) {
  const file = join(root, rel);
  try {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    if (src.includes("MCP_CONNECT_TIMEOUT_MS")) continue; // already patched
    if (!src.includes(NEEDLE)) {
      console.warn(`[patch-mcp-timeout] anchor not found in ${rel} (plugin updated?) — skipping`);
      continue;
    }
    writeFileSync(file, src.replace(NEEDLE, PATCHED));
    console.log(`[patch-mcp-timeout] patched connect timeout in ${rel}`);
  } catch (err) {
    console.warn(`[patch-mcp-timeout] skipped ${rel}: ${err?.message || err}`);
  }
}
