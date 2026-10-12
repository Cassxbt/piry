import type { ReactNode } from "react";

interface Props {
  id: string;
  index: string;
  kicker: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
}

export function Section({ id, index, kicker, title, lede, children }: Props) {
  return (
    <section className="section" id={id} aria-labelledby={`${id}-title`}>
      <div className="content">
        <header className="section-head">
          <div className="section-kicker">
            <span className="num">{index}</span>
            <span className="bar" aria-hidden />
            <span>{kicker}</span>
          </div>
          <h2 className="section-title" id={`${id}-title`}>{title}</h2>
          {lede ? <p className="section-lede">{lede}</p> : null}
        </header>
        {children}
      </div>
    </section>
  );
}
