import type { Address } from "viem";
import { explorer } from "../config";
import { blockLabel, shortAddress } from "../lib/format";

interface Props {
  contract: string;
  address?: Address | null;
  block?: bigint | number | null;
}

// Every on-chain figure carries the contract and block it was read from.
export function Src({ contract, address, block }: Props) {
  const href = address ? explorer.address(address) : null;
  const body = (
    <>
      <span>{contract}</span>
      {address ? (
        <>
          <span className="dot" aria-hidden />
          <span title={address}>{shortAddress(address)}</span>
        </>
      ) : null}
      {block !== null && block !== undefined ? (
        <>
          <span className="dot" aria-hidden />
          <span>block {blockLabel(block)}</span>
        </>
      ) : null}
    </>
  );
  return href ? (
    <a className="src" href={href} target="_blank" rel="noreferrer" aria-label={`Source: ${contract}${address ? ` at ${address}` : ""}`}>
      {body}
    </a>
  ) : (
    <span className="src">{body}</span>
  );
}
