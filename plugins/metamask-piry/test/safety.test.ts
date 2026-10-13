import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import semver from "semver";

const root = new URL("..", import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const source = files(join(root, "src")).filter((f) => f.endsWith(".ts"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("no source file can sign or broadcast by itself", () => {
  const banned = /sendTransaction|sendRawTransaction|writeContract|signMessage|signTypedData|signTransaction|privateKey|mnemonic|createWalletClient|privateKeyToAccount|mnemonicToAccount|MM_MNEMONIC|session\b/i;
  for (const file of source) {
    const text = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(text, banned, file);
  }
});

test("the only write path is the host wallet executor", () => {
  const users = source.filter((f) => /walletExecutor/.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")));
  assert.deepEqual(users.map((f) => f.replace(root, "")), ["src/base.ts"]);
});

test("manifest matches the command classes and requests least privilege", () => {
  const manifest = pkg.mm;
  const classes = source.filter((f) => f.includes("/commands/piry/")).map((f) => ({ f, id: /pluginCommandId = "([^"]+)"/.exec(readFileSync(f, "utf8"))?.[1], text: readFileSync(f, "utf8") }));
  assert.deepEqual(classes.map((c) => c.id).sort(), manifest.commands.map((c: { id: string }) => c.id).sort());
  assert.deepEqual(manifest.capabilities, []);
  for (const c of manifest.commands as { id: string; capabilities: string[]; targetChains: number[] }[]) {
    const writes = ["piry:hedge", "piry:unwind", "piry:redeem"].includes(c.id);
    assert.equal(c.capabilities.includes("wallet-submit"), writes, c.id);
    assert.deepEqual(c.targetChains, [10143]);
    const text = classes.find((x) => x.id === c.id)!.text;
    assert.equal(/this\.deps\(/.test(text), writes, `${c.id} uses the wallet only if it submits`);
  }
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(pkg.oclif.hooks, undefined);
  assert.equal(pkg.oclif.plugins, undefined);
  assert.ok(pkg.keywords.includes("oclif-plugin"));
});

test("minCliVersion admits 6.2.0 and every 7.x, and refuses older CLIs", () => {
  for (const v of ["6.2.0", "6.2.1", "7.0.0", "7.1.0"]) assert.ok(semver.satisfies(v, pkg.mm.minCliVersion, { includePrerelease: true }), v);
  for (const v of ["6.1.5", "8.0.0"]) assert.ok(!semver.satisfies(v, pkg.mm.minCliVersion, { includePrerelease: true }), v);
  assert.ok(semver.intersects(pkg.peerDependencies["@metamask/agent-wallet"], "7.1.0"));
});

test("runtime dependencies are pinned to exact versions", () => {
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }) as [string, string][]) assert.match(range, /^\d+\.\d+\.\d+$/, name);
});

test("the shipped skill exists with frontmatter and its commands match the plugin", () => {
  const skill = readFileSync(join(root, "skills/piry/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: piry\ndescription: .{40,}\n---\n/);
  for (const c of ["quote", "hedge", "position", "unwind", "redeem"]) assert.match(skill, new RegExp(`mm piry ${c}`));
});

const readme = readFileSync(join(root, "README.md"), "utf8");
const skill = readFileSync(join(root, "skills/piry/SKILL.md"), "utf8");

test("README and skill state the observed Guard boundary and promise no per-transaction policy enforcement", () => {
  for (const [name, text] of [["README", readme], ["SKILL", skill]] as const) {
    assert.doesNotMatch(text, /MetaMask policy, threat scanning and 2FA (still )?apply/i, name);
    assert.doesNotMatch(text, /pauses for 2FA|fine demo moment/i, name);
    assert.match(text, /did not (block|enforce)/i, name);
    assert.match(text, /email MFA/i, name);
    assert.match(text, /13 Oct/, name);
    assert.match(text, /10143/, name);
    for (const local of ["preview", "--max-premium", "minimum notional", "stale", "verified", "settled"]) assert.match(text, new RegExp(local, "i"), `${name}: ${local}`);
  }
});

test("README and skill carry no stale claims: top-up hint, one-hour stale mark, unrun write flows, 500-hour HEDGED demo", () => {
  for (const [name, text] of [["README", readme], ["SKILL", skill]] as const) {
    assert.doesNotMatch(text, /re-run the same command/i, name);
    assert.doesNotMatch(text, /one hour/i, name);
    assert.match(text, /1,?500 ?s/, name);
  }
  assert.doesNotMatch(readme, /have not been submitted through a real Agent Wallet|was not run/i);
  assert.doesNotMatch(readme, /51 offline tests/);
  assert.doesNotMatch(readme, /mm piry hedge --gpu-hours 500 --max-premium 500/);
});

test("README records the real Agent Wallet run: four hashes, 39 of 40 claims, the cost, and customEvmChains in the install steps", () => {
  for (const hash of [
    "0x5ab3a66a43531da5a8db3975cd5e09910f6449caff8c92f41552b6d17d6f77ed",
    "0x1c62440f9e804e235b6c1a25469a2fcf18e7c3e855c7394acb5f717e1670d4d3",
    "0xbb5ab624180c2ba9d9f38634fde7974ce0cb029b10ac83fddf3095fdbda1aa71",
    "0x7c5c446428a6e59a9a285766463f3192ee755f44c7b54293fe823c98c2103728",
  ]) assert.ok(readme.includes(hash), hash);
  assert.match(readme, /39 PIRY-L of 40/);
  assert.match(readme, /18\.085 USDC/);
  assert.match(readme, /PARTIAL/);
  const install = readme.slice(readme.indexOf("## Install"), readme.indexOf("## Real-wallet prerequisites"));
  assert.match(install, /customEvmChains/);
});
