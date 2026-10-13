import assert from "node:assert/strict";
import { test } from "node:test";
import { activeAddress, type WalletSnapshot } from "../src/wallet.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const state = (over: Partial<WalletSnapshot> = {}): WalletSnapshot => ({
  byokWallets: [{ id: "a", address: A, name: "alpha" }],
  remoteWallets: [{ id: "b", address: B, name: "beta" }],
  ...over,
});
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return "no error"; };

test("the selected wallet is resolved by id, address or name", () => {
  assert.equal(activeAddress(state({ selectedWallet: { ref: { id: "b" } } })), B);
  assert.equal(activeAddress(state({ selectedWallet: { ref: { address: A.toUpperCase().replace("0X", "0x") } } })), A);
  assert.equal(activeAddress(state({ selectedWallet: { ref: { name: "beta" } } })), B);
});

test("a selected wallet that does not resolve never falls back to another wallet", () => {
  assert.equal(code(() => activeAddress(state({ selectedWallet: { ref: { id: "zzz" } } }))), "WALLET_NOT_RESOLVED");
  assert.equal(code(() => activeAddress(state({ selectedWallet: { ref: {} } }))), "WALLET_NOT_RESOLVED");
  assert.equal(code(() => activeAddress(state({ selectedWallet: { ref: { id: "a" }  }, byokWallets: [{ id: "a", address: A, namespace: "solana" }] }))), "WALLET_NOT_RESOLVED");
});

test("a reference whose fields point at different wallets is refused", () => {
  assert.equal(code(() => activeAddress(state({ selectedWallet: { ref: { id: "a", address: B } } }))), "WALLET_NOT_RESOLVED");
});

test("with nothing selected only an unambiguous single wallet is used", () => {
  assert.equal(activeAddress({ byokWallets: [{ address: A }], remoteWallets: [] }), A);
  assert.equal(code(() => activeAddress(state())), "WALLET_NOT_RESOLVED");
  assert.equal(code(() => activeAddress({ byokWallets: [], remoteWallets: [] })), "NO_WALLET");
});
