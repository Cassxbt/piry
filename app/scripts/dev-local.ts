// Local development harness: starts a loopback Anvil, deploys the Piry contracts in the same order as
// scripts/deploy.ts (so addresses match deployments/local.json), and plays a lifecycle with SYNTHETIC data so
// every section of the app has real chain state to read.
//
//   npm run dev:local -- [--phase open|settled]
//
// Reports go through a fixture forwarder that behaves like Chainlink's mock: it succeeds even when the
// receiver reverts and records the outcome only in ReportProcessed(result). Writes only to
// app/public/evidence/local/. Nothing here touches a public network.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  concatHex, parseEventLogs, createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, getAddress, http, keccak256,
  pad, toHex, zeroHash, type Abi, type Address, type Hex,
} from "viem";
import { foundry } from "viem/chains";

import { validateDataset, indexIdentity, type IndexTerms } from "../../workflow/validation.ts";
import { encodeMarketReport } from "../../workflow/report.ts";

const phaseArg = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : "settled";
if (phaseArg !== "open" && phaseArg !== "settled") throw new Error("--phase must be open or settled");
const phase: "open" | "settled" = phaseArg;

const repo = new URL("../../", import.meta.url).pathname;
const appDir = new URL("../", import.meta.url).pathname;
const evidenceDir = join(appDir, "public", "evidence", "local");
const fixtureOut = join(appDir, ".fixture-out");
const RPC = "http://127.0.0.1:8545";

const build = spawnSync(
  "forge",
  ["build", "--offline", "--skip", "test", "--contracts", "app/scripts/fixtures", "--out", "app/.fixture-out", "--cache-path", "app/.fixture-cache"],
  { cwd: repo, encoding: "utf8" },
);
if (build.status !== 0) throw new Error(`fixture build failed:\n${build.stderr}`);

type Artifact = { abi: Abi; bytecode: { object: Hex } };
const artifact = async (path: string, from = join(repo, "out")) => JSON.parse(await readFile(join(from, path), "utf8")) as Artifact;

const node = spawn("anvil", ["--host", "127.0.0.1", "--port", "8545", "--chain-id", "31337"], { stdio: ["ignore", "ignore", "inherit"] });
const stop = () => { if (node.exitCode === null) node.kill("SIGTERM"); };
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });

const transport = http(RPC, { retryCount: 0 });
const pc = createPublicClient({ chain: foundry, transport });
const wallet = createWalletClient({ chain: foundry, transport });
const testClient = createTestClient({ chain: foundry, transport, mode: "anvil" });

for (let i = 0; i < 80; i++) {
  try { if ((await pc.getChainId()) === 31337) break; } catch { /* still starting */ }
  await new Promise((r) => setTimeout(r, 100));
}

try {
  const [deployer, hedgerRaw, writerRaw] = await wallet.getAddresses();
  const hedger = getAddress(hedgerRaw!);
  const writer = getAddress(writerRaw!);
  const operator = getAddress(deployer!);

  const send = async (hash: Hex) => {
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`reverted: ${hash}`);
    return receipt;
  };
  const deploy = async (a: Artifact, args: unknown[] = []) => {
    const receipt = await send(await wallet.deployContract({ account: operator, abi: a.abi, bytecode: a.bytecode.object, args }));
    return { address: getAddress(receipt.contractAddress!), abi: a.abi };
  };
  const write = async (c: { address: Address; abi: Abi }, functionName: string, args: unknown[], account: Address = operator) =>
    send(await wallet.writeContract({ account, address: c.address, abi: c.abi, functionName, args }));
  const warpTo = async (timestamp: bigint) => {
    await testClient.setNextBlockTimestamp({ timestamp });
    await testClient.mine({ blocks: 1 });
  };

  const series = JSON.parse(await readFile(join(repo, "deployments", "series.example.json"), "utf8")) as {
    priceDecimals: number; bounds: { lower: string; upper: string }; maxReportAge: number; fallbackDelay: number;
    index: { terms: Record<string, unknown> };
  };
  const now = (await pc.getBlock()).timestamp;
  const periodStart = now + 600n;
  const periodEnd = now + 3000n;
  const terms = {
    ...series.index.terms,
    priceDecimals: series.priceDecimals,
    periodStart: Number(periodStart),
    periodEnd: Number(periodEnd),
    maxPublicationAgeSeconds: series.maxReportAge,
  } as unknown as IndexTerms;
  const identity = indexIdentity(terms);

  const forwarder = await deploy(await artifact("MockForwarder.sol/MockForwarder.json", fixtureOut));
  const usd = await deploy(await artifact("PiryTestUSD.sol/PiryTestUSD.json"));
  const receiver = await deploy(await artifact("SimulationSettlementReceiver.sol/SimulationSettlementReceiver.json"), [forwarder.address, operator]);
  const market = await deploy(await artifact("ComputeMarket.sol/ComputeMarket.json"), [{
    collateral: usd.address, settlementAuthority: receiver.address, indexId: identity.indexId, specHash: identity.specHash,
    priceDecimals: series.priceDecimals, lower: BigInt(series.bounds.lower), upper: BigInt(series.bounds.upper),
    periodStart, periodEnd, maxReportAge: BigInt(series.maxReportAge), fallbackDelay: BigInt(series.fallbackDelay),
  }]);
  const feed = await deploy(await artifact("PiryMarkFeed.sol/PiryMarkFeed.json"), [forwarder.address, zeroHash, operator, market.address]);
  const longClaim = {
    address: (await pc.readContract({ address: market.address, abi: market.abi, functionName: "longClaim" })) as Address,
    abi: (await artifact("ClaimToken.sol/ClaimToken.json")).abi,
  };

  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });

  // 109-byte header the CLI's mock consensus builds: version, execution id, timestamp, DON id, config version,
  // workflow id (placeholder 0x11..), name, owner (placeholder 0xaa..), report id.
  let executionCounter = 0;
  const rawReport = (payload: Hex): Hex =>
    concatHex([
      "0x01", pad(toHex(++executionCounter), { size: 32 }), "0x00000064", "0x00000001", "0x00000001",
      `0x${"11".repeat(32)}`, toHex("piry-demo\0", { size: 10 }), `0x${"aa".repeat(20)}`, "0x0001", payload,
    ]);
  // The outer transaction succeeds either way, so each delivery is checked against the forwarder's own
  // ReportProcessed(result) and the scenario fails loudly if the outcome is not the one intended.
  const deliver = async (target: Address, payload: Hex, expectApplied: boolean, account: Address = operator) => {
    const receipt = await send(await wallet.writeContract({
      account, address: forwarder.address, abi: forwarder.abi, functionName: "report", args: [target, rawReport(payload), "0x", []],
      // Explicit, like a CRE workflow's gasLimit. Gas estimation would settle on a limit where the outer call
      // succeeds even though the receiver ran out of gas, because the forwarder swallows the failure.
      gas: 1_000_000n,
    }));
    const [processed] = parseEventLogs({ abi: forwarder.abi, logs: receipt.logs, eventName: "ReportProcessed" });
    const result = (processed?.args as { result?: boolean } | undefined)?.result;
    if (result !== expectApplied) throw new Error(`delivery ${receipt.transactionHash}: expected result=${expectApplied}, forwarder logged ${String(result)}`);
    return receipt;
  };

  const markPayload = (indexPrice: bigint, observedAt: bigint, tag: string) =>
    encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "feed", type: "address" }, { name: "chainId", type: "uint256" }, { name: "indexId", type: "bytes32" },
        { name: "indexPrice", type: "uint256" }, { name: "observedAt", type: "uint64" }, { name: "evidenceHash", type: "bytes32" },
      ] }],
      [{ feed: feed.address, chainId: 31337n, indexId: identity.indexId, indexPrice, observedAt, evidenceHash: keccak256(toHex(tag)) }],
    );

  await write(usd, "mint", [writer, 5_000_000_000n]);
  await write(usd, "mint", [hedger, 1_000_000_000n]);
  await write(usd, "approve", [market.address, 3_000_000_000n], writer);
  await write(market, "mintPairs", [3_000_000_000n], writer);
  await write(longClaim, "transfer", [hedger, 1_000_000_000n], writer);

  const inPeriod = periodStart + 300n;
  await warpTo(inPeriod);
  await deliver(feed.address, markPayload(2_310_000n, inPeriod - 5n, "mark-1"), true);
  await warpTo(inPeriod + 120n);
  await deliver(feed.address, markPayload(2_460_000n, inPeriod + 100n, "mark-2"), true);
  await warpTo(inPeriod + 180n);
  await deliver(feed.address, markPayload(2_460_000n, inPeriod + 100n, "mark-2-again"), false);

  const summary: Record<string, unknown> = {
    phase, rpc: RPC, chainId: 31337,
    market: market.address, feed: feed.address, receiver: receiver.address, collateral: usd.address, forwarder: forwarder.address,
    hedger, writer, operator,
  };
  const pins: { txHash: Hex; note: string }[] = [];

  if (phase === "settled") {
    const prices = ["2150000", "2400000", "2950000", "3300000", "3100000", "2700000", "2550000", "2350000"];
    const slotSeconds = Number((terms as unknown as { slotSeconds: number }).slotSeconds);
    const dataset = (publishedAt: number) => ({
      schemaVersion: 1,
      ...(({ maxPublicationAgeSeconds: _drop, ...rest }) => rest)(terms as unknown as Record<string, unknown>),
      ...identity,
      publishedAt,
      observations: prices.map((price, i) => ({
        slotStart: Number(periodStart) + i * slotSeconds,
        observedAt: Number(periodStart) + i * slotSeconds + 30,
        price,
      })),
    });
    const reportFor = (publishedAt: number, chainId: bigint) => {
      const validated = validateDataset(dataset(publishedAt), terms, publishedAt);
      return { validated, payload: encodeMarketReport(validated, terms, { market: market.address, chainId }) };
    };

    const early = reportFor(Number(periodEnd) + 60, 31337n);
    await warpTo(periodEnd - 120n);
    const premature = await deliver(receiver.address, early.payload, false);
    pins.push({ txHash: premature.transactionHash, note: "Sent before the period end to show the BeforeExpiry guard." });

    await warpTo(periodEnd + 700n);
    await deliver(receiver.address, early.payload, false);

    const fresh = reportFor(Number(periodEnd) + 705, 31337n);
    const wrongChain = reportFor(Number(periodEnd) + 705, 10143n);
    await warpTo(periodEnd + 710n);
    await deliver(receiver.address, wrongChain.payload, false);
    await deliver(receiver.address, fresh.payload, false, hedger);

    const settleReceipt = await deliver(receiver.address, fresh.payload, true);
    await deliver(receiver.address, fresh.payload, false);

    await writeFile(join(evidenceDir, "evidence.json"), fresh.validated.canonicalEvidence);
    summary.settled = { price: fresh.validated.price.toString(), evidenceHash: fresh.validated.evidenceHash, tx: settleReceipt.transactionHash };
  }

  if (pins.length > 0) await writeFile(join(evidenceDir, "deliveries.json"), `${JSON.stringify({ schema: 1, entries: pins }, null, 2)}\n`);

  const manifest = JSON.parse(await readFile(join(repo, "deployments", "local.json"), "utf8")) as { contracts: Record<string, { address: string }> };
  const expected = { market: market.address, markFeed: feed.address, settlementReceiver: receiver.address, collateral: usd.address, forwarder: forwarder.address };
  const mismatched = Object.entries(expected).filter(([key, address]) => manifest.contracts[key]?.address?.toLowerCase() !== address.toLowerCase());
  summary.matchesDeploymentsLocalJson = mismatched.length === 0 ? true : `NO (differs: ${mismatched.map(([k]) => k).join(", ")})`;

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nAnvil is running on ${RPC} (Ctrl+C to stop). In another shell: npm run dev, then open /?network=local`);
  await once(node, "exit");
} catch (error) {
  stop();
  throw error;
}
