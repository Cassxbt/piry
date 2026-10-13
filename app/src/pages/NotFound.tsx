import { BlockHead } from "../components/site/Frame";
import { SiteLink } from "../components/site/SiteLink";
import { usePage } from "../hooks/usePage";

export default function NotFound() {
  usePage("Not found", "This page does not exist.");
  return (
    <header className="page-head">
      <div className="wrap">
        <BlockHead as="h1" kicker="404" title={<>That page is <em>not here</em></>} lede="The link may be old. These are the pages that exist." />
        <p className="hero-actions">
          <SiteLink to="/" className="btn">Home</SiteLink>
          <SiteLink to="/app" className="btn secondary">Open the app</SiteLink>
        </p>
      </div>
    </header>
  );
}
