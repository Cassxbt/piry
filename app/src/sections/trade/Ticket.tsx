import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActionButton, TxStatus } from "../../components/Action";
import { Field } from "../../components/Field";
import { computeMarketAbi } from "../../abi";
import { chain, config } from "../../config";
import { describeError, useAction } from "../../hooks/action";
import { useClient } from "../../hooks/chain";
import { kuruMarketFor, useKuruAccount, type KuruSide } from "../../hooks/kuru";
import { claimExitOpen, useMarkFreshness } from "../../hooks/markFreshness";
import { useViewer } from "../../hooks/viewer";
import { duration, fixed, parseAmount } from "../../lib/format";
import { describeOutcome, estimateSwap, openSession, placeLimit, placeSwap, type KuruBook, type OrderOutcome } from "../../lib/kuru";
import { baseAtoms, checkLimitOrder, planSwap, precisionDecimals, quoteNotional, toPriceRaw, toSizeRaw } from "../../lib/kuruMath";
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
  const pc = useClient();
  const exit = useMarkFreshness();
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
  const [ackExit, setAckExit] = useState(false);
  const [outcome, setOutcome] = useState<{ identity: string; value: OrderOutcome | null; note?: string } | null>(null);
  const identity = [viewer.address, chain.id, snapshot.address, market, rootId].join("|");
  const action = useAction(identity, [type, isBuy, amount, price, qty, postOnly, bps].join("|"));

  const amountIn = parseAmount(amount, isBuy ? quoteDecimals : claimDecimals);
  const estimate = useQuery({
    queryKey: ["swap-estimate", market, isBuy, amountIn?.toString(), rootId.toString()],
    queryFn: () => estimateSwap(pc, market as NonNullable<typeof market>, isBuy, amountIn as bigint, rootId),
    enabled: type === "market" && market !== null && amountIn !== null && amountIn > 0n,
    refetchInterval: 6_000,
    retry: false,
  });
  const plan = estimate.data && amountIn !== null ? planSwap(estimate.data, amountIn, bps) : null;
  const minOut = plan?.minAmountOut ?? null;
  const exitBlocked = isBuy && !claimExitOpen(exit);

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
    else if (plan === null) blocker = "The book returns nothing for this size.";
  } else if (limitProblem) blocker = limitProblem;
  else if (isBuy && reserve > quoteFree) blocker = `Needs ${fixed(reserve, quoteDecimals, 4)} ${config.kuru.quoteSymbol} including the maker-fee reserve.`;
  else if (!isBuy && sizeRaw !== null && baseAtoms(sizeRaw, scale) > claimFree) blocker = `Only ${fixed(claimFree, claimDecimals)} ${symbol} in your Kuru balance.`;

  const submit = async () => {
    setOutcome(null);
    if (!market) return;
    const label = `${type === "market" ? "Market" : "Limit"} ${isBuy ? "buy" : "sell"}`;
    const hash = await action.run(label, async (op) => {
      const wallet = await op.wallet();
      const session = await openSession(pc, wallet, config.kuru.accountCore);
      op.guard();
      if (type === "market") {
        if (plan === null) throw new Error("Missing estimate");
        const fresh = await estimateSwap(pc, market, isBuy, plan.amountIn, rootId);
        op.guard();
        if (fresh.amountOut < plan.minAmountOut) {
          throw new Error(
            `The book moved since your estimate: it would now ${isBuy ? "give" : "pay"} ${fixed(fresh.amountOut, outDecimals, 4)} ${outLabel} for ${fixed(plan.amountIn, inDecimals, 4)} ${inLabel}, below your minimum of ${fixed(plan.minAmountOut, outDecimals, 4)}. Nothing was sent.`,
          );
        }
        await assertOpen();
        op.guard();
        return placeSwap(session, { market, rootId, isBuy, amountIn: plan.amountIn, minAmountOut: plan.minAmountOut });
      }
      if (priceRaw === null || sizeRaw === null) throw new Error("Missing order fields");
      await assertOpen();
      op.guard();
      return placeLimit(session, { market, rootId, isBuy, priceRaw, sizeRaw, postOnly });
    });
    if (!hash) return;
    try {
      setOutcome({ identity, value: await describeOutcome(await pc.getTransactionReceipt({ hash }), market) });
    } catch (error) {
      setOutcome({ identity, value: null, note: describeError(error) });
    }
  };

  // Kuru's book does not inherit ComputeMarket's settlement gate, so read it again at the last moment before a write.
  const assertOpen = async () => {
    if (await pc.readContract({ address: snapshot.address, abi: computeMarketAbi, functionName: "settled" })) {
      throw new Error("This series has settled and trading is closed. Nothing was sent.");
    }
  };

  const outLabel = isBuy ? symbol : config.kuru.quoteSymbol;
  const outDecimals = isBuy ? claimDecimals : quoteDecimals;
  const inLabel = isBuy ? config.kuru.quoteSymbol : symbol;
  const inDecimals = isBuy ? quoteDecimals : claimDecimals;
  const shown = outcome?.identity === identity ? outcome : null;
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
            <div><dt>Average price</dt><dd>{avgPrice !== null ? `${avgPrice.toFixed(4)} ${config.kuru.quoteSymbol}` : "-"}</dd></div>
            <div><dt>Minimum accepted ({(bps / 100).toFixed(2)}% slippage)</dt><dd>{minOut !== null ? `${fixed(minOut, outDecimals, 4)} ${outLabel}` : "-"}</dd></div>
            <div><dt>Taker fee</dt><dd>{(Number(book.fees.takerPps) / 1e5).toFixed(3)}%</dd></div>
          </dl>
          {plan?.partial && amountIn !== null ? (
            <p className="callout warn" role="status">
              <strong>Partial fill.</strong> The book can take only {fixed(plan.amountIn, inDecimals, 4)} of the {fixed(amountIn, inDecimals, 4)} {inLabel} you entered. Only {fixed(plan.amountIn, inDecimals, 4)} {inLabel} will be sent, with the minimum above applied to that amount; the rest stays in your Kuru balance.
            </p>
          ) : null}
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
      {exitBlocked ? (
        <div className="callout warn stack" role="status">
          <p>
            {exit.state === "stale"
              ? `This claim's price feed was last updated ${exit.ageSeconds !== null ? `${duration(exit.ageSeconds)} ago` : "a while ago"}.`
              : "The claim's price feed could not be read, so whether its claims can leave Kuru right now is unknown."}{" "}
            Kuru only lets claims leave your trading balance while that price is under 30 minutes old, so you may not be able to withdraw (and then redeem) what you buy until the next mark is published. Selling back on the book still works.
          </p>
          <label className="check-line">
            <input type="checkbox" checked={ackExit} onChange={(e) => setAckExit(e.target.checked)} />
            I understand, buy anyway.
          </label>
        </div>
      ) : null}
      <ActionButton
        label={`${type === "market" ? "Market" : "Limit"} ${isBuy ? "buy" : "sell"} ${symbol}`}
        variant={isBuy ? "long" : "short"}
        busy={action.busy}
        disabled={blocker !== null || blocked || (exitBlocked && !ackExit)}
        onRun={submit}
        block
      />
      <TxStatus state={action.state} />
      {shown?.value ? (
        <div className="callout ok" role="status">
          <strong>Market outcome: {shown.value.label}.</strong>{" "}
          {shown.value.fills > 0 ? `${shown.value.fills} fill${shown.value.fills > 1 ? "s" : ""}, ${fixed(shown.value.filledSize, precisionDecimals(scale.sizePrecision), 4)} ${symbol} matched. ` : "No fills. "}
          A confirmed transaction does not by itself mean an order is resting; check open orders below.
        </div>
      ) : shown ? (
        <div className="callout warn" role="status">
          The transaction confirmed, but its outcome could not be decoded ({shown.note}). Use the hash above and check your open orders and balances.
        </div>
      ) : null}
    </div>
  );
}
