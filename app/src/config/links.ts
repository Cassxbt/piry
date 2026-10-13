export interface PartnerQuote {
  text: string;
  source: string;
}

interface Links {
  repo: string;
  videos: string;
  x: string;
  github: string;
  partnerQuote: PartnerQuote | null;
}

// Project links. An empty string hides the link everywhere it is rendered.
// partnerQuote shows on /about; leave it null until a partner has agreed to be quoted.
export const links: Links = {
  repo: "https://github.com/Cassxbt/piry",
  videos: "",
  x: "https://x.com/cassxbt",
  github: "https://github.com/Cassxbt",
  partnerQuote: null,
};
