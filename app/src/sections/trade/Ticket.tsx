import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActionButton, TxStatus } from "../../components/Action";
import { Field } from "../../components/Field";
import { config } from "../../config";
import { useAction } from "../../hooks/action";
import { useClient } from "../../hooks/chain";
import { kuruMarketFor, useKuruAccount, type KuruSide } from "../../hooks/kuru";
import { useViewer } from "../../hooks/viewer";
import { useWallet } from "../../hooks/wallet";
import { fixed, parseAmount } from "../../lib/format";
import { describeOutcome, estimateSwap, openSession, placeLimit, placeSwap, type KuruBook, type OrderOutcome } from "../../lib/kuru";
import { baseAtoms, checkLimitOrder, precisionDecimals, quoteNotional, slippageFloor, toPriceRaw, toSizeRaw } from "../../lib/kuruMath";
import type { MarketSnapshot } from "../../lib/reads";

interface Props {
  snapshot: MarketSnapshot;
  book: KuruBook;
  side: KuruSide;
  defaultBuy: boolean;
  blocked?: boolean;
}

const FEE_DENOMINATOR = 10_000_000n;

export function Ticket({ snapshot, book, side, defaultBuy, blocked = false }: Props) {
  const market = kuruMarketFor(side);
  const viewer = useViewer();
  const wallet = useWallet();
  const pc = useClient();
  const action = useAction();
  const claim = side === "long" ? snapshot.claims.long : snapshot.claims.short;
  const symbol = side === "long" ? snapshot.claims.longSymbol : snapshot.claims.shortSymbol;
  const { scale } = book;
  const claimDecimals = scale.baseDecimals;
  const quoteDecimals = scale.quoteDecimals;

  const account = useKuruAccount(viewer.address, [config.kuru.quoteToken, claim]);
  const rootId = account.data?.rootId ?? 0n;
  const free = (token: string) => account.data?.balances.find((b) => b.token.toLowerCase() === token.toLowerCase())?.free ?? 0n;
  const quoteFree = free(config.kuru.quoteToken);
  const claimFree = free(claim);

  const [isBuy, setIsBuy] = useState(defaultBuy);
  const [type, setType] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [postOnly, setPostOnly] = useState(false);
  const [bps, setBps] = useState(50);
  const [outcome, setOutcome] = useState<OrderOutcome | null>(null);

  const amountIn = parseAmount(amount, isBuy ? quoteDecimals : claimDecimals);
  const estimate = useQuery({
    queryKey: ["swap-estimate", market, isBuy, amountIn?.toString(), rootId.toString()],
    queryFn: () => estimateSwap(pc, market as NonNullable<typeof market>, isBuy, amountIn as bigint, rootId),
    enabled: type === "market" && market !== null && amountIn !== null && amountIn > 0n,
    retry: false,
  });
  const minOut = estimate.data ? slippageFloor(estimate.data.amountOut, bps) : null;

  const priceRaw = toPriceRaw(price, scale);
  const sizeRaw = toSizeRaw(qty, scale);
  const limitProblem = checkLimitOrder(priceRaw, sizeRaw, scale);
  const notional = priceRaw !== null && sizeRaw !== null ? quoteNotional(priceRaw, sizeRaw, scale) : 0n;
  const reserve = notional + (notional * book.fees.makerPps) / FEE_DENOMINATOR;

  let blocker: string | null = null;
  if (!viewer.address) blocker = null;
  else if (rootId === 0n) blocker = "No Kuru balance yet. Deposit below first.";
  else if (type === "market") {
    if (amountIn === null || amountIn === 0n) blocker = "Enter an amount.";
    else if (isBuy && amountIn > quoteFree) blocker = `Only ${fixed(quoteFree, quoteDecimals)} ${config.kuru.quoteSymbol} in your Kuru balance.`;
    else if (!isBuy && amountIn > claimFree) blocker = `Only ${fixed(claimFree, claimDecimals)} ${symbol} in your Kuru balance.`;
    else if (estimate.isError || (estimate.data && estimate.data.amountOut === 0n)) blocker = "The book returns nothing for this size.";
    else if (!estimate.data) blocker = "Estimating";
  } else if (limitProblem) blocker = limitProblem;
  else if (isBuy && reserve > quoteFree) blocker = `Needs ${fixed(reserve, quoteDecimals, 4)} ${config.kuru.quoteSymbol} including the maker-fee reserve.`;
  else if (!isBuy && sizeRaw !== null && baseAtoms(sizeRaw, scale) > claimFree) blocker = `Only ${fixed(claimFree, claimDecimals)} ${symbol} in your Kuru balance.`;

  const submit = async () => {
    setOutcome(null);
    if (!market) return;
    const label = `${type === "market" ? "Market" : "Limit"} ${isBuy ? "buy" : "sell"}`;
    const hash = await action.run(label, async () => {
      if (!wallet) throw new Error("Connect a wallet first");
      const session = await openSession(pc, wallet, config.kuru.accountCore);
      if (type === "market") {
        if (amountIn === null || minOut === null) throw new Error("Missing estimate");
        return placeSwap(session, { market, rootId, isBuy, amountIn, minAmountOut: minOut });
      }
      if (priceRaw === null || sizeRaw === null) throw new Error("Missing order fields");
      return placeLimit(session, { market, rootId, isBuy, priceRaw, sizeRaw, postOnly });
    });
    if (hash) setOutcome(await describeOutcome(await pc.getTransactionReceipt({ hash }), market));
  };

  const outLabel = isBuy ? symbol : config.kuru.quoteSymbol;
  const outDecimals = isBuy ? claimDecimals : quoteDecimals;
  const avgPrice =
    estimate.data && estimate.data.amountOut > 0n
      ? isBuy
        ? Number(estimate.data.amountInUsed) / 10 ** quoteDecimals / (Number(estimate.data.amountOut) / 10 ** claimDecimals)
        : Number(estimate.data.amountOut) / 10 ** quoteDecimals / (Number(estimate.data.amountInUsed) / 10 ** claimDecimals)
      : null;

  return (
    <div className="ticket">
      <div className="row between">
        <div className="segmented" role="group" aria-label="Side">
          <button type="button" aria-pressed={isBuy} onClick={() => setIsBuy(true)}>Buy {symbol}</button>
          <button type="button" aria-pressed={!isBuy} onClick={() => setIsBuy(false)}>Sell {symbol}</button>
        </div>
        <div className="segmented" role="group" aria-label="Order type">
          <button type="button" aria-pressed={type === "market"} onClick={() => setType("market")}>Market</button>
          <button type="button" aria-pressed={type === "limit"} onClick={() => setType("limit")}>Limit</button>
        </div>
      </div>

      {type === "market" ? (
        <>
          <Field
            label={isBuy ? `Spend` : `Sell`}
            value={amount}
            onChange={setAmount}
            unit={isBuy ? config.kuru.quoteSymbol : symbol}
            hint={`Kuru balance ${isBuy ? fixed(quoteFree, quoteDecimals) : fixed(claimFree, claimDecimals)}`}
            error={amount && amountIn === null ? "Enter a valid amount." : null}
          />
          <div className="field">
            <div className="label-row"><span>Slippage protection</span></div>
            <div className="segmented fill" role="group" aria-label="Slippage">
              {[25, 50, 100, 200].map((b) => (
                <button key={b} type="button" aria-pressed={bps === b} onClick={() => setBps(b)}>{(b / 100).toFixed(2)}%</button>
              ))}
            </div>
          </div>
          <dl className="estimate" aria-live="polite">
            <div><dt>Estimated {isBuy ? "receive" : "proceeds"}</dt><dd>{estimate.data ? `${fixed(estimate.data.amountOut, outDecimals, 4)} ${outLabel}` : estimate.isFetching ? "estimating" : "-"}</dd></div>
            {estimate.data && amountIn !== null && estimate.data.amountInUsed < amountIn ? (
              <div><dt>Only part of this is used</dt><dd>{fixed(estimate.data.amountInUsed, isBuy ? quoteDecimals : claimDecimals, 4)} of {fixed(amountIn, isBuy ? quoteDecimals : claimDecimals, 4)} {isBuy ? config.kuru.quoteSymbol : symbol}</dd></div>
            ) : null}
            <div><dt>Average price</dt><dd>{avgPrice !== null ? `${avgPrice.toFixed(4)} ${config.kuru.quoteSymbol}` : "-"}</dd></div>
            <div><dt>Minimum accepted ({(bps / 100).toFixed(2)}% slippage)</dt><dd>{minOut !== null ? `${fixed(minOut, outDecimals, 4)} ${outLabel}` : "-"}</dd></div>
            <div><dt>Taker fee</dt><dd>{(Number(book.fees.takerPps) / 1e5).toFixed(3)}%</dd></div>
          </dl>
        </>
      ) : (
        <>
          <div className="ticket-row">
            <Field
              label="Limit price"
              value={price}
              onChange={setPrice}
              unit={`${config.kuru.quoteSymbol}/${symbol}`}
              error={price && priceRaw === null ? "Too many decimals for this market." : null}
              hint={`tick ${Number(scale.tickSize) / Number(scale.pricePrecision)}`}
            />
            <Field label="Quantity" value={qty} onChange={setQty} unit={symbol} error={qty && sizeRaw === null ? "Too many decimals for this market." : null} />
          </div>
          <label className="check-line">
            <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} />
            Post-only: rest on the book, never take liquidity. A crossing order is skipped, not converted.
          </label>
          <dl className="estimate">
            <div><dt>Order value</dt><dd>{notional > 0n ? `${fixed(notional, quoteDecimals, 4)} ${config.kuru.quoteSymbol}` : "-"}</dd></div>
            <div><dt>Reserved on a buy (with maker fee)</dt><dd>{notional > 0n ? `${fixed(reserve, quoteDecimals, 4)} ${config.kuru.quoteSymbol}` : "-"}</dd></div>
            <div><dt>Market minimum</dt><dd>{fixed(scale.minQuote, quoteDecimals)} {config.kuru.quoteSymbol}</dd></div>
          </dl>
        </>
      )}

      {blocker && viewer.address ? <p className="field-error" role="status">{blocker}</p> : null}
      <ActionButton
        label={`${type === "market" ? "Market" : "Limit"} ${isBuy ? "buy" : "sell"} ${symbol}`}
        variant={isBuy ? "long" : "short"}
        busy={action.busy}
        disabled={blocker !== null || blocked}
        onRun={submit}
        block
      />
      <TxStatus state={action.state} />
      {outcome ? (
        <div className="callout ok" role="status">
          <strong>Market outcome: {outcome.label}.</strong>{" "}
          {outcome.fills > 0 ? `${outcome.fills} fill${outcome.fills > 1 ? "s" : ""}, ${fixed(outcome.filledSize, precisionDecimals(scale.sizePrecision), 4)} ${symbol} matched. ` : "No fills. "}
          A confirmed transaction does not by itself mean an order is resting; check open orders below.
        </div>
      ) : null}
    </div>
  );
}
