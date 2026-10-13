import type { Address } from "viem";
import type { Reader } from "./chain.js";
import type { Config } from "./config.js";
import { PiryError } from "./errors.js";
import { marketIssues, readAccount, readMarket, type KuruAccount, type KuruMarket } from "./kuru.js";
import { Run, type Budget, type Wallet } from "./tx.js";

export interface Deps {
  client: Reader;
  config: Config;
  wallet: Wallet;
  note?: (line: string) => void;
}

// Every write goes through one Run, which checks the chain when the host's status is not a final success.
export const newRun = (deps: Deps, budget: Budget): Run => new Run(deps.wallet, budget, deps.note, deps.client);

// Seconds a swap stays valid after planning. Approvals by a human can take minutes; the minimum-out floor,
// not the deadline, is what bounds the price.
export const SWAP_DEADLINE_SECONDS = 1800n;

export interface KuruView {
  market: KuruMarket | null;
  shortMarket: KuruMarket | null;
  account: KuruAccount;
}

async function verified(client: Reader, accountCore: Address, address: Address, base: Address, quote: Address, label: string): Promise<KuruMarket> {
  const market = await readMarket(client, address, accountCore);
  const issues = marketIssues(market, { base, quote });
  if (issues.length > 0) {
    throw new PiryError(
      "KURU_MARKET_MISMATCH",
      `The configured Kuru market ${market.address} is not the ${label}/USDC market: ${issues.join("; ")}.`,
      "Nothing was sent. Fix the market address with the one Kuru gave for that pair.",
    );
  }
  return market;
}

export async function loadKuru(client: Reader, config: Config, owner: Address): Promise<KuruView> {
  const { collateral, longClaim, shortClaim } = config.series;
  const [account, market, shortMarket] = await Promise.all([
    readAccount(client, config.accountCore, owner, [collateral, longClaim, shortClaim]),
    config.kuruMarket ? verified(client, config.accountCore, config.kuruMarket, longClaim, collateral, "PIRY-L") : null,
    config.kuruShortMarket ? verified(client, config.accountCore, config.kuruShortMarket, shortClaim, collateral, "PIRY-S") : null,
  ]);
  return { market, shortMarket, account };
}
