import { explorer } from "../../config";
import { shortHash } from "../../lib/format";

export function TxLink({ hash }: { hash: string }) {
  const href = explorer.tx(hash);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="mono">{shortHash(hash)}</a>
  ) : (
    <span className="mono" title={hash}>{shortHash(hash)}</span>
  );
}
