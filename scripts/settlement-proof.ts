import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import {
  createPublicClient, createWalletClient, createTestClient, encodePacked, http, keccak256, toHex,
  parseEventLogs, type Abi, type Address, type Hex,
} from 'viem';

import { demoDataset, demoTerms } from '../workflow/demo.ts';
import { indexIdentity, validateDataset } from '../workflow/validation.ts';
import { encodeMarketReport } from '../workflow/report.ts';

const root = new URL('../', import.meta.url);
const artifact = async (path: string) => JSON.parse(await readFile(new URL(`out/${path}`, root), 'utf8')) as {
  abi: Abi; bytecode: { object: Hex };
};
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const node = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--timestamp', '1000'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let startupError: Error | undefined;
let stderr = '';
node.on('error', (error) => { startupError = error; });
node.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 1000 });
const client = createPublicClient({ transport });
const testClient = createTestClient({ transport, mode: 'anvil' });

try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (startupError) throw startupError;
    if (node.exitCode !== null) throw new Error(`Anvil exited: ${stderr}`);
    try { ready = await client.getChainId() === 31337; } catch { /* Startup only. */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, 'Local Anvil did not start');
  const wallet = createWalletClient({ transport });
  const [account] = await wallet.getAddresses();
  assert(account, 'Local test account missing');
  const confirmed = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt;
  };
  const deploy = async (path: string, args: readonly unknown[] = []) => {
    const data = await artifact(path);
    const receipt = await confirmed(await wallet.deployContract({ account, chain: null, abi: data.abi, bytecode: data.bytecode.object, args }));
    assert(receipt.contractAddress);
    return { address: receipt.contractAddress, abi: data.abi };
  };
  const write = async (contract: { address: Address; abi: Abi }, functionName: string, args: readonly unknown[]) =>
    confirmed(await wallet.writeContract({ ...contract, account, chain: null, functionName, args }));
  const read = async (contract: { address: Address; abi: Abi }, functionName: string) =>
    client.readContract({ ...contract, functionName });

  const forwarder = await deploy('SettlementReceiver.t.sol/TestForwarder.json');
  const workflowId = keccak256(toHex('piry-local-proof-v1'));
  const receiver = await deploy('SettlementReceiver.sol/SettlementReceiver.json', [forwarder.address, workflowId]);
  const usd = await deploy('ComputeMarket.t.sol/TestCollateral.json');
  const metadata = encodePacked(['bytes32', 'bytes10', 'address', 'bytes2'], [workflowId, '0x70697279000000000000', account, '0x0001']);
  assert.equal((metadata.length - 2) / 2, 64);
  const identity = indexIdentity(demoTerms);
  const market = await deploy('ComputeMarket.sol/ComputeMarket.json', [{
    collateral: usd.address, settlementAuthority: receiver.address,
    indexId: identity.indexId, specHash: identity.specHash, priceDecimals: demoTerms.priceDecimals,
    lower: 1_000_000n, upper: 4_000_000n,
    periodStart: BigInt(demoTerms.periodStart), periodEnd: BigInt(demoTerms.periodEnd),
    maxReportAge: BigInt(demoTerms.maxPublicationAgeSeconds),
  }]);
  await write(usd, 'mint', [account, 3_000_000n]);
  await write(usd, 'approve', [market.address, 3_000_000n]);
  await write(market, 'mintPairs', [3_000_000n]);
  await testClient.setNextBlockTimestamp({ timestamp: BigInt(demoDataset.publishedAt + 30) });
  await testClient.mine({ blocks: 1 });
  const now = Number((await client.getBlock()).timestamp);
  const validated = validateDataset(demoDataset, demoTerms, now);
  const destination = { market: market.address, chainId: 31337n };
  const payload = encodeMarketReport(validated, demoTerms, destination);
  const malformed = structuredClone(demoDataset);
  malformed.observations[1] = { ...malformed.observations[0] };
  assert.throws(() => validateDataset(malformed, demoTerms, now), /duplicate/);
  assert.equal(await read(market, 'settled'), false);

  // A caught receiver failure still produces a successful outer receipt.
  const wrongChain = encodeMarketReport(validated, demoTerms, { ...destination, chainId: 10143n });
  const refused = await write(forwarder, 'deliverCatching', [receiver.address, metadata, wrongChain]);
  assert.equal(await read(market, 'settled'), false);
  assert.equal(refused.logs.filter((log) => log.address.toLowerCase() === market.address.toLowerCase()).length, 0);
  const accepted = await write(forwarder, 'deliver', [receiver.address, metadata, payload]);
  assert.equal(await read(market, 'settled'), true);
  assert.equal(await read(market, 'settlementPrice'), validated.price);
  assert.equal(await read(market, 'settlementEvidenceHash'), validated.evidenceHash);
  const events = parseEventLogs({ abi: market.abi, logs: accepted.logs, eventName: 'Settled', strict: true });
  assert.equal(events.filter((log) => log.address.toLowerCase() === market.address.toLowerCase()).length, 1);
  const replay = await write(forwarder, 'deliverCatching', [receiver.address, metadata, payload]);
  assert.equal(replay.logs.length, 0);
  assert.equal(await read(market, 'settlementPrice'), validated.price);
  await write(market, 'redeem', [3_000_000n, 3_000_000n, account, 3_000_000n]);
  assert.equal(await read(market, 'collateralLocked'), 0n);
  assert.equal(await client.readContract({ ...usd, functionName: 'balanceOf', args: [account] }), 3_000_000n);
  console.log(JSON.stringify({
    mode: 'LOCAL_ANVIL_SYNTHETIC_DATA_MOCK_TRANSPORT', chainId: 31337,
    observations: demoDataset.observations.length, price: validated.price.toString(),
    evidenceHash: validated.evidenceHash, duplicateSourceRejected: true,
    wrongChainRejected: true, outerSuccessAloneInsufficient: true,
    settlementEventAndStateVerified: true, replayRejected: true, collateralRedeemed: true,
    donSignaturesVerified: false, publicNetworkDelivery: false,
  }, null, 2));
} finally {
  if (node.exitCode === null && node.pid) {
    const exited = once(node, 'exit');
    node.kill('SIGTERM');
    await exited;
  }
}
