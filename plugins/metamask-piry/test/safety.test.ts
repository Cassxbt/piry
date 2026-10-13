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
