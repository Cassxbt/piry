export interface Citation {
  label: string;
  url: string;
}

export interface WhyNowItem {
  fig: string;
  headline: string;
  text: string;
  sources: Citation[];
}

// Every claim here was checked against its cited page on 12 Oct 2026. Keep each text to what its sources say.
export const whyNow: WhyNowItem[] = [
  {
    fig: "CFTC",
    headline: "Review extended.",
    text: "The CFTC extended its review of NYMEX's Silicon Data H100 Rental Index Futures by 45 days, to 9 November 2026, citing “novel or complex issues.”",
    sources: [{ label: "CFTC letter to CME Group, 21 Sep 2026", url: "https://www.cftc.gov/filings/documents/2026/orgdcmnymexcompcontr260921.pdf" }],
  },
  {
    fig: "ICE",
    headline: "Specs published.",
    text: "ICE and Ornn plan cash-settled H100 compute futures on the Ornn Compute Price Index, subject to regulatory approval. ICE has published an exchange notice with the contract details.",
    sources: [
      { label: "ICE exchange notice, 29 Sep 2026", url: "https://www.ice.com/publicdocs/futures_us/exchange_notices/ICE_Futures_US_Exchange_Notice_ORNN_Compute_4Q2026_20260929.pdf" },
      { label: "ICE and Ornn announcement, 19 May 2026", url: "https://ir.theice.com/press/news-details/2026/ICE-and-Ornn-to-Launch-GPU-Compute-Futures-Contracts/default.aspx" },
    ],
  },
  {
    fig: "H100",
    headline: "Prices swing.",
    text: "Ornn's index showed H100 rental prices spike in early May 2026 and then decline, with on-demand quotes ranging from $1.38 to $11.01 an hour across providers.",
    sources: [{ label: "Crypto Briefing on Ornn data, 27 May 2026", url: "https://cryptobriefing.com/h100-rental-prices-slide-ornn-ai/" }],
  },
  {
    fig: "$570k",
    headline: "Demand exists.",
    text: "One Polymarket market on H100 rental prices traded about $570k before it closed on 29 April 2026, and Kalshi lists contracts on A100, H100, H200, B200 and RTX 5090 rental prices. Both are binary: they pay all or nothing. Piry's payout scales with the price move inside the band.",
    sources: [
      { label: "Polymarket: GPU rental prices (H100)", url: "https://polymarket.com/event/what-will-gpu-rental-prices-h100-hit-by-april-30-967" },
      { label: "PokerNews on Kalshi's compute markets, 17 Aug 2026", url: "https://www.pokernews.com/prediction-markets/news/2026/08/kalshi-s-new-ai-compute-markets-explained-52156.htm" },
    ],
  },
];
