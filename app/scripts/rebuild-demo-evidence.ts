// Rebuilds the canonical evidence JSON of a DEMO settlement and refuses to write it unless its keccak256
// equals the evidence hash the market settled with. The demo source is deterministic (seed + terms), so the
// only unknown is publishedAt, which the settlement transaction's report carries.
//
//   npx tsx scripts/rebuild-demo-evidence.ts <settlement-tx> [--network monad-testnet] [--seed 20261012] [--price-min 2] [--price-max 3.5]
//
// Read-only on the public network: it fetches one transaction and one receipt.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, createPublicClient, decodeAbiParameters, decodeFunctionData, hexToBytes, http, parseAbi, type Hex } from "viem";

import { buildDataset } from "../../scripts/demo-source.ts";
import { validateDataset, type IndexTerms } from "../../workflow/validation.ts";

const args = process.argv.slice(2);
const txHash = args[0] as Hex | undefined;
if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("usage: rebuild-demo-evidence.ts <settlement-tx-hash> [--network n] [--seed n] [--price-min n] [--price-max n]");
const flag = (name: string, fallback: string) => (args.includes(`--${name}`) ? (args[args.indexOf(`--${name}`) + 1] as string) : fallback);
const network = flag("network", "monad-testnet");

const repo = new URL("../../", import.meta.url).pathname;
const appDir = new URL("../", import.meta.url).pathname;
const deployment = JSON.parse(await readFile(join(repo, "deployments", `${network}.json`), "utf8")) as { chainId: number };
const config = JSON.parse(await readFile(join(appDir, "src", "config", `${network}.json`), "utf8")) as { chain: { rpcUrl: string } };
const workflowConfig = JSON.parse(await readFile(join(repo, "workflow", "config.testnet.json"), "utf8")) as { terms: IndexTerms };
const terms = workflowConfig.terms;

const pc = createPublicClient({ transport: http(config.chain.rpcUrl) });
if ((await pc.getChainId()) !== deployment.chainId) throw new Error("RPC chain id does not match the deployment record");
const tx = await pc.getTransaction({ hash: txHash });

const forwarderAbi = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);
const raw = hexToBytes(decodeFunctionData({ abi: forwarderAbi, data: tx.input }).args[1]);
const payload = bytesToHex(raw.slice(109));
const [report] = decodeAbiParameters(
  [{ type: "tuple", components: [
    { name: "market", type: "address" }, { name: "chainId", type: "uint256" }, { name: "indexId", type: "bytes32" },
    { name: "specHash", type: "bytes32" }, { name: "priceDecimals", type: "uint8" }, { name: "periodStart", type: "uint64" },
    { name: "periodEnd", type: "uint64" }, { name: "price", type: "uint256" }, { name: "publishedAt", type: "uint64" },
    { name: "evidenceHash", type: "bytes32" },
  ] }],
  payload,
);

const options = { terms, seed: Number(flag("seed", "20261012")), priceMin: Number(flag("price-min", "2")), priceMax: Number(flag("price-max", "3.5")), publishLagSeconds: 0 };
let found: { text: string; hash: Hex } | null = null;
for (let lag = 0; lag <= 30 && !found; lag++) {
  const dataset = buildDataset({ ...options, publishLagSeconds: lag }, Number(report.publishedAt) + lag, "full", "none");
  if (!dataset) continue;
  try {
    const validated = validateDataset(dataset, terms, Number(report.publishedAt));
    if (validated.evidenceHash.toLowerCase() === report.evidenceHash.toLowerCase()) found = { text: validated.canonicalEvidence, hash: validated.evidenceHash };
  } catch { /* try the next lag */ }
}

if (!found) {
  console.error(`No match for evidence hash ${report.evidenceHash}. The demo source was run with other settings; pass --seed/--price-min/--price-max.`);
  process.exit(1);
}
const out = join(appDir, "public", "evidence", network);
await mkdir(out, { recursive: true });
await writeFile(join(out, "evidence.json"), found.text);
console.log(JSON.stringify({ wrote: join(out, "evidence.json"), evidenceHash: found.hash, price: report.price.toString(), publishedAt: report.publishedAt.toString() }, null, 2));
