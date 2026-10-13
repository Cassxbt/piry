import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs from the app package.
const src = join(process.cwd(), "src");
const repo = join(process.cwd(), "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "abi" ? [] : files(path);
    return /\.(tsx?|json)$/.test(name) ? [path] : [];
  });
}

// Phrases the independent review found to overstate what the system guarantees.
const BANNED: [RegExp, string][] = [
  [/freshness check always passes/i, "freshness is a target, not a guarantee"],
  [/never hours old/i, "marks can age if the keeper fails"],
  [/funds (were|are|can) (never|ever) (be )?locked/i, "a lone leg waits for settlement or the 7-day fallback"],
  [/no holder is ever locked/i, "a lone leg waits for settlement or the 7-day fallback"],
  [/earn the premium/i, "selling a leg is not profit just because the index stays under the cap"],
  [/equals today.s (bill|income)/i, "the held level differs from today's figure by the premium"],
  [/every (refused|report the contracts turned away)/i, "the ledger lists reports found in its scanned range plus pinned records"],
  [/always pays? exactly/i, "merge is exact; separate redemption can leave dust"],
  [/lock(s|ing)? (in )?the rate you will be re-quoted/i, "the product does not lock a monthly bill"],
];

describe("copy invariants", () => {
  const targets = [...files(src), join(repo, "README.md"), join(process.cwd(), "index.html")];

  it.each(BANNED)("%s does not appear in the app or README (%s)", (pattern) => {
    const hits = targets.filter((path) => pattern.test(readFileSync(path, "utf8")));
    expect(hits).toEqual([]);
  });

  it("states the keeper cadence consistently: 5-minute checks, 20-minute heartbeat, 30-minute Kuru limit", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    expect(readme).not.toMatch(/every 15 minutes|15 min\b|15-minute/i);
    expect(readme).toMatch(/every 5 minutes/);
    expect(readme).toMatch(/every 20 minutes/);
  });

  it("does not describe the 6-hour report age as the snapshot window", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    expect(readme).not.toMatch(/inside the 6-hour publication window/i);
    expect(readme).toMatch(/24 hours/);
  });

  it("does not tell a reader the Agent Wallet was never exercised", () => {
    expect(readFileSync(join(repo, "README.md"), "utf8")).not.toMatch(/not yet run through a real Agent Wallet/i);
  });
});
