import type { Address, Hash } from "viem";
import { vi } from "vitest";

export const OWNER_A = "0x1111111111111111111111111111111111111111" as Address;
export const OWNER_B = "0x4444444444444444444444444444444444444444" as Address;
export const HASH = `0x${"11".repeat(32)}` as Hash;

// Stands in for wagmi's connection state. useWalletClient is deliberately always unresolved, which is what the
// app saw when the wallet sat on another chain or the client query had not settled yet.
export const harness = {
  address: OWNER_A as Address | undefined,
  chainId: 10143 as number | undefined,
  write: vi.fn(async (..._args: unknown[]): Promise<Hash> => HASH),
  switchChain: vi.fn(async (chainId: number) => {
    harness.chainId = chainId;
  }),
  walletClient: vi.fn(async (_chainId: number, account: Address) => ({ account: { address: account, type: "json-rpc" }, writeContract: harness.write })),
  client: {
    simulateContract: vi.fn(async (request: unknown) => ({ request })),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    getTransactionReceipt: vi.fn(async () => ({ logs: [] })),
    readContract: vi.fn(async (): Promise<unknown> => false),
  },
  reset() {
    harness.client.simulateContract.mockReset();
    harness.client.simulateContract.mockImplementation(async (request: unknown) => ({ request }));
    harness.client.waitForTransactionReceipt.mockReset();
    harness.client.waitForTransactionReceipt.mockImplementation(async () => ({ status: "success" }));
    harness.client.getTransactionReceipt.mockReset();
    harness.client.getTransactionReceipt.mockImplementation(async () => ({ logs: [] }));
    harness.client.readContract.mockReset();
    harness.client.readContract.mockImplementation(async () => false);
    harness.address = OWNER_A;
    harness.chainId = 10143;
    harness.write.mockReset();
    harness.write.mockImplementation(async () => HASH);
    harness.switchChain.mockReset();
    harness.switchChain.mockImplementation(async (chainId: number) => {
      harness.chainId = chainId;
    });
    harness.walletClient.mockReset();
    harness.walletClient.mockImplementation(async (_chainId: number, account: Address) => ({ account: { address: account, type: "json-rpc" }, writeContract: harness.write }));
  },
};

export const wagmiMock = {
  useConfig: () => ({}),
  useAccount: () => ({ isConnected: harness.address !== undefined, address: harness.address, chainId: harness.chainId }),
  useConnect: () => ({ connect: vi.fn(), connectors: [], isPending: false }),
  useSwitchChain: () => ({ switchChain: ({ chainId }: { chainId: number }) => void harness.switchChain(chainId) }),
  useWalletClient: () => ({ data: undefined }),
};

export const actionsMock = {
  getAccount: () => ({ address: harness.address, chainId: harness.chainId, isConnected: harness.address !== undefined }),
  switchChain: (_config: unknown, { chainId }: { chainId: number }) => harness.switchChain(chainId),
  getWalletClient: (_config: unknown, { chainId, account }: { chainId: number; account: Address }) => harness.walletClient(chainId, account),
};

export const viewerMock = {
  useViewer: () => ({ connected: harness.address !== undefined, address: harness.address, lookup: undefined, setLookup: () => {} }),
};

export const chainMock = {
  useClient: () => harness.client,
};
