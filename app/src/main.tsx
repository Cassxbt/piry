import "@fontsource/newsreader/latin-300.css";
import "@fontsource/newsreader/latin-300-italic.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource-variable/instrument-sans";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/site.css";
import "./styles/charts.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { App } from "./App";
import { wagmiConfig } from "./lib/wagmi";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 4_000, retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
