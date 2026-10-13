import { Src } from "../../components/Src";
import type { SeriesSubject } from "../../config/types";
import { useSeriesMark } from "../../hooks/chain";
import { useMarkRounds } from "../../hooks/ledger";
import { shortHash, usd, utc } from "../../lib/format";
import { markLabel } from "../../lib/labels";
import type { MarketSnapshot } from "../../lib/reads";

export function Rounds({ subject, snapshot }: { subject: SeriesSubject; snapshot: MarketSnapshot }) {
  const mark = useSeriesMark(subject);
  const m = mark.data;
  const latest = m?.status === "ok" ? (m.isFinal ? m.roundId - 1n : m.roundId) : undefined;
  const rounds = useMarkRounds(subject, latest);
  if (!subject.contracts.markFeed) return null;
  const pd = snapshot.terms.priceDecimals;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label">Mark feed rounds</span>
        <Src contract="PiryMarkFeed" address={subject.contracts.markFeed} block={m?.status === "ok" ? m.block : null} />
      </div>
      <div className="panel-pad stack">
        <p className="sub">
          Each accepted mark is a round in the feed&rsquo;s state and a <span className="mono">MarkUpdated</span> event. The feed floors its answer at 1e-8 USD, shown as &ldquo;$0.00 (floor)&rdquo;.
        </p>
        {m?.status === "empty" ? <p className="sub">No round yet: the feed reverts with NoData until its first CRE update.</p> : null}
        {rounds.data && rounds.data.length > 0 ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead><tr><th>Round</th><th className="r">Index</th><th className="r">Long mark</th><th>Observed (UTC)</th><th>Evidence hash</th></tr></thead>
              <tbody>
                {rounds.data.map((r) => (
                  <tr key={r.roundId.toString()}>
                    <td className="num" data-label="Round">{r.roundId.toString()}</td>
                    <td className="r num" data-label="Index">{usd(r.indexPrice, pd, 4)}</td>
                    <td className="r num" data-label="Long mark">{markLabel(r.answer, 8)}</td>
                    <td className="num" data-label="Observed">{utc(r.observedAt, true)}</td>
                    <td className="mono" data-label="Evidence" title={r.evidenceHash}>{shortHash(r.evidenceHash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {m?.status === "ok" && m.isFinal ? <p className="sub">The market has settled, so the feed now returns the final value and accepts no more marks.</p> : null}
      </div>
    </div>
  );
}
