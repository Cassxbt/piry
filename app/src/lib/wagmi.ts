import { createConfig, http, injected } from "wagmi";
import { chain, config } from "../config";
import { rateLimitedFetch } from "./rateLimit";

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: {
    [chain.id]: http(config.chain.rpcUrl, { batch: true, fetchFn: rateLimitedFetch(config.chain.requestsPerSecond) }),
  },
});
