// Deploys one Piry series: [test collateral], settlement receiver, market, mark feed.
//
//   bun scripts/deploy.ts [--network local|monad-testnet] [--series <file>] [--confirm] [--overwrite]
//
// local (default): spawns a loopback Anvil, or attaches to LOCAL_RPC_URL when it points at loopback.
// monad-testnet: needs --confirm and --series, MONAD_TESTNET_RPC (optional) and DEPLOYER_PRIVATE_KEY, both
// read from the environment only. Nothing is sent before the RPC chain ID matches the network.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BaseError, ContractFunctionRevertedError, bytesToHex, createPublicClient, createWalletClient, defineChain,
  getAddress, hexToBytes, http, isAddress, parseAbi, zeroAddress, zeroHash, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

import { indexIdentity, type AnyTerms } from '../workflow/validation.ts';

const root = new URL('../', import.meta.url);
const NETWORKS = { local: 31337, 'monad-testnet': 10143 } as const;
type Network = keyof typeof NETWORKS;
const DEFAULT_TESTNET_RPC = 'https://testnet-rpc.monad.xyz';
const MIN_START_LEAD_SECONDS = 60;
const CRE_RECEIVER_ID = '0x805f2132';
const ERC165_ID = '0x01ffc9a7';

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).refine((v) => !/^0x0{64}$/.test(v), 'must be nonzero');
const address = z.string().refine(isAddress, 'invalid address');
const when = z.union([z.number().int().nonnegative(), z.string().regex(/^\+[0-9]+$/)]);
const seconds = z.number().int().positive().max(2 ** 40);
const seriesSchema = z.object({
  _doc: z.unknown().optional(),
  collateral: z.union([z.literal('deploy-test-usd'), address]),
  priceDecimals: z.number().int().min(0).max(18),
  bounds: z.object({ lower: z.string().regex(/^[0-9]+$/), upper: z.string().regex(/^[0-9]+$/) }).strict(),
  periodStart: when,
  periodEnd: when,
  maxReportAge: seconds,
  fallbackDelay: seconds,
  index: z.union([
    z.object({ indexId: hex32, specHash: hex32 }).strict(),
    z.object({ terms: z.record(z.unknown()) }).strict(),
  ]),
  receiver: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('simulation') }).strict(),
    z.object({ mode: z.literal('strict'), workflowId: hex32, markWorkflowId: hex32 }).strict(),
  ]),
  forwarder: address,
}).strict();
type Series = z.infer<typeof seriesSchema>;

type Artifact = {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> };
};
type Entry = {
  address: Address; txHash?: Hex; blockNumber?: string; nonce?: number; constructorArgs?: unknown;
  preexisting?: true; mock?: true; configured?: Address;
};
const erc20Decimals = parseAbi(['function decimals() view returns (uint8)']);

class UsageError extends Error {}
const fail = (message: string): never => { throw new UsageError(message); };
const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

const { values } = parseArgs({
  options: {
    network: { type: 'string', default: 'local' },
    series: { type: 'string' },
    confirm: { type: 'boolean', default: false },
    overwrite: { type: 'boolean', default: false },
  },
  strict: true,
});
const secrets: string[] = [];
const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join('<redacted>'), text);
const describe = (error: unknown) =>
  redact(error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error));

const startLocalNode = async () => {
  const attach = process.env.LOCAL_RPC_URL;
  if (attach) {
    const host = new URL(attach).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) fail('LOCAL_RPC_URL must point at loopback');
    return { url: attach, stop: async () => {} };
  }
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const node = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupError: Error | undefined;
  let stderr = '';
  node.on('error', (error) => { startupError = error; });
  node.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  const probe = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 1000 }) });
  const stop = async () => {
    if (node.exitCode === null && node.pid) {
      const exited = once(node, 'exit');
      node.kill('SIGTERM');
      await exited;
    }
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    if (startupError) throw startupError;
    if (node.exitCode !== null) throw new Error(`Anvil exited: ${stderr}`);
    try { if (await probe.getChainId() === 31337) return { url, stop }; } catch { /* Startup only. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  await stop();
  return fail('Local Anvil did not start');
};

const main = async () => {
  const network = values.network as string;
  if (!(network in NETWORKS)) fail(`unknown network "${network}"; use local or monad-testnet`);
  const name = network as Network;
  const chainId = NETWORKS[name];
  const isLocal = name === 'local';
  let privateKey: Hex | undefined;
  if (!isLocal) {
    if (!values.confirm) fail('refusing to send transactions to monad-testnet without --confirm');
    if (!values.series) fail('--series <file> is required for monad-testnet');
    const raw = process.env.DEPLOYER_PRIVATE_KEY ?? '';
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) fail('DEPLOYER_PRIVATE_KEY must be set in the environment as 32 bytes of hex');
    privateKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
    secrets.push(raw, privateKey);
  }
  const seriesPath = values.series
    ? (isAbsolute(values.series) ? values.series : resolve(process.cwd(), values.series))
    : new URL('deployments/series.example.json', root).pathname;
  const raw = JSON.parse(await readFile(seriesPath, 'utf8'));
  if (typeof raw?.collateral === 'string' && raw.collateral.startsWith('REPLACE_WITH')) {
    fail(`collateral is still the placeholder "${raw.collateral}"; set it to the collateral ERC-20 address (the Kuru testnet USDC for the Kuru-listed series)`);
  }
  const parsed = seriesSchema.safeParse(raw);
  if (!parsed.success) fail(`invalid series file: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const series = parsed.data as Series;
  const lower = BigInt(series.bounds.lower);
  const upper = BigInt(series.bounds.upper);
  if (lower >= upper) fail('bounds.lower must be below bounds.upper');

  const outPath = new URL(`deployments/${name}.json`, root);
  if (!isLocal && !values.overwrite) {
    const exists = await stat(outPath).then(() => true, () => false);
    if (exists) fail(`deployments/${name}.json already exists; move it or pass --overwrite`);
  }

  const local = isLocal ? await startLocalNode() : undefined;
  try {
    const rpcUrl = local?.url ?? (process.env.MONAD_TESTNET_RPC || DEFAULT_TESTNET_RPC);
    secrets.push(rpcUrl);
    const rpc = new URL(rpcUrl);
    if (rpc.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname)) {
      fail('the RPC URL must use https unless it is loopback');
    }
    const chain = defineChain({
      id: chainId, name,
      nativeCurrency: { name: isLocal ? 'Ether' : 'Monad', symbol: isLocal ? 'ETH' : 'MON', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const transport = http(rpcUrl, { retryCount: 2, timeout: 30_000 });
    const client = createPublicClient({ chain, transport, pollingInterval: 500 });
    const reported = await client.getChainId();
    if (reported !== chainId) fail(`the RPC reports chain ${reported} but ${name} is chain ${chainId}; nothing was sent`);

    const wallet = createWalletClient({ chain, transport });
    const account = privateKey ? privateKeyToAccount(privateKey) : (await wallet.getAddresses())[0];
    if (!account) fail('no deployer account available');
    const deployer = typeof account === 'string' ? getAddress(account) : account.address;
    if (await client.getBalance({ address: deployer }) === 0n) fail(`deployer ${deployer} has no balance on ${name}`);

    const now = (await client.getBlock()).timestamp;
    const at = (value: number | string) => (typeof value === 'number' ? BigInt(value) : now + BigInt(value.slice(1)));
    const periodStart = at(series.periodStart);
    const periodEnd = at(series.periodEnd);
    if (periodStart < now + BigInt(MIN_START_LEAD_SECONDS)) fail(`periodStart must be at least ${MIN_START_LEAD_SECONDS}s after the chain clock (${now})`);
    if (periodEnd <= periodStart) fail('periodEnd must be after periodStart');

    let identity: { indexId: Hex; specHash: Hex };
    if ('terms' in series.index) {
      const filled = {
        priceDecimals: series.priceDecimals, periodStart: Number(periodStart), periodEnd: Number(periodEnd),
        maxPublicationAgeSeconds: series.maxReportAge,
      };
      for (const [key, value] of Object.entries(filled)) {
        if (key in series.index.terms && series.index.terms[key] !== value) fail(`index.terms.${key} conflicts with the series value ${value}`);
      }
      identity = indexIdentity({ ...series.index.terms, ...filled } as unknown as AnyTerms);
    } else {
      identity = { indexId: series.index.indexId as Hex, specHash: series.index.specHash as Hex };
    }

    const artifact = async (path: string) => readFile(new URL(`out/${path}`, root), 'utf8').then(
      (text) => JSON.parse(text) as Artifact,
      () => fail(`missing build artifact out/${path}; run forge build --offline`),
    );
    const [receiverArtifact, marketArtifact, feedArtifact, claimArtifact] = await Promise.all([
      artifact(series.receiver.mode === 'simulation'
        ? 'SimulationSettlementReceiver.sol/SimulationSettlementReceiver.json'
        : 'SettlementReceiver.sol/SettlementReceiver.json'),
      artifact('ComputeMarket.sol/ComputeMarket.json'),
      artifact('PiryMarkFeed.sol/PiryMarkFeed.json'),
      artifact('ClaimToken.sol/ClaimToken.json'),
    ]);
    const testUsdArtifact = series.collateral === 'deploy-test-usd' ? await artifact('PiryTestUSD.sol/PiryTestUSD.json') : undefined;
    const mockForwarderArtifact = isLocal ? await artifact('SettlementReceiver.t.sol/TestForwarder.json') : undefined;

    const read = <T>(target: Address, a: { abi: Abi }, functionName: string, args: unknown[] = []) =>
      client.readContract({ address: target, abi: a.abi, functionName, args }) as Promise<T>;
    const hasCode = async (target: string) => ((await client.getCode({ address: target as Address })) ?? '0x') !== '0x';
    if (series.collateral !== 'deploy-test-usd' && !(await hasCode(series.collateral))) fail('collateral has no code on this chain');
    if (!isLocal && !(await hasCode(series.forwarder))) fail('forwarder has no code on this chain');

    const record = {
      network: name, chainId, status: 'in-progress', startedAt: new Date().toISOString(), deployer,
      series: {
        mode: series.receiver.mode, collateral: series.collateral, priceDecimals: series.priceDecimals,
        lower, upper, periodStart, periodEnd, maxReportAge: series.maxReportAge,
        fallbackDelay: series.fallbackDelay,
        ...identity,
      },
      contracts: {} as Record<string, Entry>,
      pending: undefined as { contract: string; txHash: Hex } | undefined,
      checks: {} as Record<string, boolean>,
      error: undefined as string | undefined,
    };
    const save = async () => {
      await mkdir(new URL('deployments/', root), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(record, replacer, 2)}\n`);
    };
    await save();

    try {
      const deploy = async (label: string, a: Artifact, args: unknown[]) => {
        const txHash = await wallet.deployContract({ account, chain, abi: a.abi, bytecode: a.bytecode.object, args });
        record.pending = { contract: label, txHash };
        await save();
        const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
        if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${label} deployment failed in ${txHash}`);
        const deployed = getAddress(receipt.contractAddress);
        const tx = await client.getTransaction({ hash: txHash });
        record.pending = undefined;
        record.contracts[label] = {
          address: deployed, txHash, blockNumber: receipt.blockNumber.toString(), nonce: tx.nonce, constructorArgs: args,
        };
        await save();
        console.log(`${label}: ${deployed}`);
        return deployed;
      };

      let forwarder: Address;
      if (mockForwarderArtifact) {
        forwarder = await deploy('forwarder', mockForwarderArtifact, []);
        record.contracts.forwarder = { ...record.contracts.forwarder, address: forwarder, mock: true, configured: getAddress(series.forwarder) };
      } else {
        forwarder = getAddress(series.forwarder);
        record.contracts.forwarder = { address: forwarder, preexisting: true };
      }
      let collateral: Address;
      if (testUsdArtifact) {
        collateral = await deploy('collateral', testUsdArtifact, []);
      } else {
        collateral = getAddress(series.collateral);
        record.contracts.collateral = { address: collateral, preexisting: true };
      }
      const strict = series.receiver.mode === 'strict' ? series.receiver : undefined;
      const receiver = await deploy('settlementReceiver', receiverArtifact,
        [forwarder, strict ? strict.workflowId : deployer]);
      const marketArgs = {
        collateral, settlementAuthority: receiver, indexId: identity.indexId, specHash: identity.specHash,
        priceDecimals: series.priceDecimals, lower, upper, periodStart, periodEnd,
        maxReportAge: BigInt(series.maxReportAge),
        fallbackDelay: BigInt(series.fallbackDelay),
      };
      const market = await deploy('market', marketArtifact, [marketArgs]);
      const feed = await deploy('markFeed', feedArtifact,
        [forwarder, strict ? strict.markWorkflowId : zeroHash, strict ? zeroAddress : deployer, market]);
      const longClaim = await read<Address>(market, marketArtifact, 'longClaim');
      const shortClaim = await read<Address>(market, marketArtifact, 'shortClaim');
      record.contracts.longClaim = { address: longClaim };
      record.contracts.shortClaim = { address: shortClaim };
      await save();

      const check = (label: string, ok: boolean) => {
        record.checks[label] = ok;
        if (!ok) throw new Error(`verification failed: ${label}`);
      };
      const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
      const codeMatches = async (target: Address, a: Artifact) => {
        const onChain = await client.getCode({ address: target });
        if (!onChain) return false;
        const refs = Object.values(a.deployedBytecode.immutableReferences ?? {}).flat();
        const masked = (code: Hex) => {
          const bytes = hexToBytes(code);
          for (const { start, length } of refs) bytes.fill(0, start, start + length);
          return bytesToHex(bytes);
        };
        return masked(onChain) === masked(a.deployedBytecode.object);
      };
      const interfaces = async (target: Address, a: Artifact, label: string) => {
        const supports = (id: string) => read<boolean>(target, a, 'supportsInterface', [id]);
        check(`${label}.erc165`, await supports(ERC165_ID) && await supports(CRE_RECEIVER_ID) && !(await supports('0xffffffff')));
      };

      check('forwarder.hasCode', await hasCode(forwarder));
      if (testUsdArtifact) {
        check('collateral.bytecode', await codeMatches(collateral, testUsdArtifact));
        check('collateral.deployer', same(await read(collateral, testUsdArtifact, 'deployer'), deployer));
        check('collateral.decimals', Number(await read(collateral, testUsdArtifact, 'decimals')) === 6);
      } else {
        check('collateral.hasCode', await hasCode(collateral));
      }

      check('receiver.bytecode', await codeMatches(receiver, receiverArtifact));
      check('receiver.forwarder', same(await read(receiver, receiverArtifact, 'forwarder'), forwarder));
      if (strict) check('receiver.workflowId', same(await read(receiver, receiverArtifact, 'workflowId'), strict.workflowId));
      else check('receiver.operator', same(await read(receiver, receiverArtifact, 'operator'), deployer));
      await interfaces(receiver, receiverArtifact, 'receiver');

      check('market.bytecode', await codeMatches(market, marketArtifact));
      const expectedMarket: Record<string, unknown> = {
        collateral, settlementAuthority: receiver, indexId: identity.indexId, specHash: identity.specHash,
        priceDecimals: series.priceDecimals, lower, upper, periodStart, periodEnd,
        maxReportAge: series.maxReportAge,
        fallbackDelay: series.fallbackDelay,
      };
      for (const [field, expected] of Object.entries(expectedMarket)) {
        check(`market.${field}`, same(await read(market, marketArtifact, field), expected));
      }
      const collateralDecimals = Number(await read(collateral, { abi: erc20Decimals }, 'decimals'));
      for (const [label, claim] of [['longClaim', longClaim], ['shortClaim', shortClaim]] as const) {
        check(`${label}.bytecode`, await codeMatches(claim, claimArtifact));
        check(`${label}.market`, same(await read(claim, claimArtifact, 'market'), market));
        check(`${label}.decimals`, Number(await read(claim, claimArtifact, 'decimals')) === collateralDecimals);
      }

      check('feed.bytecode', await codeMatches(feed, feedArtifact));
      check('feed.forwarder', same(await read(feed, feedArtifact, 'forwarder'), forwarder));
      check('feed.market', same(await read(feed, feedArtifact, 'market'), market));
      check('feed.workflowId', same(await read(feed, feedArtifact, 'workflowId'), strict ? strict.markWorkflowId : zeroHash));
      check('feed.operator', same(await read(feed, feedArtifact, 'operator'), strict ? zeroAddress : deployer));
      check('feed.isSimulation', await read<boolean>(feed, feedArtifact, 'isSimulation') === !strict);
      check('feed.bounds', same(await read(feed, feedArtifact, 'lower'), lower) && same(await read(feed, feedArtifact, 'upper'), upper));
      check('feed.indexId', same(await read(feed, feedArtifact, 'indexId'), identity.indexId));
      check('feed.decimals', Number(await read(feed, feedArtifact, 'decimals')) === 8);
      await interfaces(feed, feedArtifact, 'feed');
      const revertedWithNoData = await read(feed, feedArtifact, 'latestRoundData').then(() => false, (error) => {
        const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
        return reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'NoData';
      });
      check('feed.emptyBeforeFirstUpdate', revertedWithNoData);

      record.status = 'complete';
      await save();
      console.log(`verified ${Object.keys(record.checks).length} checks; wrote deployments/${name}.json`);
    } catch (error) {
      record.status = 'failed';
      record.error = describe(error);
      await save();
      throw error;
    }
    return record;
  } finally {
    await local?.stop();
  }
};

try {
  await main();
} catch (error) {
  console.error(`deploy failed: ${describe(error)}`);
  process.exitCode = 1;
}
