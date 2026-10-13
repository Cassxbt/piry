import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

const KEEP = ["network", "series"];

// ?network= and ?series= choose what the whole app reads, so they follow the visitor across pages.
export function useKeptSearch(): string {
  const { search } = useLocation();
  const source = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of KEEP) {
    const value = source.get(key);
    if (value) kept.set(key, value);
  }
  const text = kept.toString();
  return text ? `?${text}` : "";
}

interface Props {
  to: string;
  hash?: string;
  className?: string;
  children: ReactNode;
  nav?: boolean;
  onClick?: () => void;
  title?: string;
  "aria-label"?: string;
}

export function SiteLink({ to, hash, className, children, nav, onClick, title, "aria-label": ariaLabel }: Props) {
  const search = useKeptSearch();
  const target = { pathname: to, search, hash: hash ? `#${hash}` : "" };
  if (nav) {
    return (
      <NavLink to={target} end={to === "/"} className={className} onClick={onClick} title={title} aria-label={ariaLabel}>
        {children}
      </NavLink>
    );
  }
  return (
    <Link to={target} className={className} onClick={onClick} title={title} aria-label={ariaLabel}>
      {children}
    </Link>
  );
}
