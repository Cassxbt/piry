import type { ReactNode } from "react";

interface Props {
  title: string;
  count?: string;
  status?: ReactNode;
  children: ReactNode;
  tone?: "dark" | "paper";
  className?: string;
  label?: string;
}

// A product panel set into the page with corner brackets and a mono counter. Dark in both themes.
export function Frame({ title, count, status, children, tone = "dark", className = "", label }: Props) {
  return (
    <section className={`frame frame--${tone} ${className}`} aria-label={label ?? title}>
      <header className="frame-bar">
        <span className="frame-title"><i className="sq" aria-hidden />{title}</span>
        <span className="frame-meta">
          {status}
          {count ? <span className="frame-count">{count}</span> : null}
        </span>
      </header>
      {children}
    </section>
  );
}

export function Kicker({ children, index }: { children: ReactNode; index?: string }) {
  return (
    <p className="kicker">
      <i className="sq" aria-hidden />
      {index ? <span className="kicker-index">{index}</span> : null}
      <span>{children}</span>
    </p>
  );
}

interface HeadProps {
  kicker: string;
  index?: string;
  title: ReactNode;
  lede?: ReactNode;
  as?: "h1" | "h2";
  id?: string;
}

export function BlockHead({ kicker, index, title, lede, as = "h2", id }: HeadProps) {
  const Title = as;
  return (
    <header className="block-head">
      <Kicker index={index}>{kicker}</Kicker>
      <Title className={as === "h1" ? "page-title" : "block-title"} id={id}>{title}</Title>
      {lede ? <p className="lede">{lede}</p> : null}
    </header>
  );
}
