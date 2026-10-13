import type { PartnerQuote } from "../config/links";

export function PartnerNote({ quote }: { quote: PartnerQuote | null }) {
  if (!quote) return null;
  return (
    <figure className="partner-note brackets">
      <p className="mono kicker-line"><i className="sq" aria-hidden />PARTNER NOTE</p>
      <blockquote>{quote.text}</blockquote>
      <figcaption className="sub">{quote.source}</figcaption>
    </figure>
  );
}
