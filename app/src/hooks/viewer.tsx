import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";

interface Viewer {
  address: Address | undefined;
  connected: boolean;
  lookup: Address | undefined;
  setLookup: (a: Address | undefined) => void;
}

const ViewerContext = createContext<Viewer | null>(null);

// A connected wallet wins. Otherwise a pasted address lets judges inspect any holder without connecting.
export function ViewerProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const [lookup, setLookup] = useState<Address | undefined>(undefined);
  const value = useMemo<Viewer>(
    () => ({ address: isConnected ? address : lookup, connected: isConnected, lookup, setLookup }),
    [address, isConnected, lookup],
  );
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

export function useViewer(): Viewer {
  const value = useContext(ViewerContext);
  if (!value) throw new Error("ViewerProvider missing");
  return value;
}
