// Copies the keeper's saved composite evidence (evidence/composite/<hash>.json, byte for byte) into public/evidence/composite
// so the site can serve it by the on-chain hash. A file is copied only if keccak256 of its bytes is the name it carries.
//
//   npx tsx scripts/publish-composite-evidence.ts [source-dir]
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256 } from "viem";

const repo = new URL("../../", import.meta.url).pathname;
const from = process.argv[2] ?? join(repo, "evidence", "composite");
const to = new URL("../public/evidence/composite/", import.meta.url).pathname;

await mkdir(to, { recursive: true });
let copied = 0;
for (const name of await readdir(from)) {
  const match = /^(0x[0-9a-f]{64})\.json$/.exec(name);
  if (!match) continue;
  const bytes = await readFile(join(from, name));
  if (keccak256(bytes) !== match[1]) throw new Error(`${name}: its bytes do not hash to its name; not published`);
  await copyFile(join(from, name), join(to, name));
  copied += 1;
}
console.log(`published ${copied} composite evidence file${copied === 1 ? "" : "s"} to public/evidence/composite`);
