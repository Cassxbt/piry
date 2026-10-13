import type { ReactNode } from "react";
import { Reveal } from "./site/motion";
import { Kicker } from "./site/Frame";

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
    <section className="app-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="wrap">
        <Reveal>
          <header className="block-head">
            <Kicker index={index}>{kicker}</Kicker>
            <h2 className="block-title" id={`${id}-title`}>{title}</h2>
            {lede ? <p className="lede">{lede}</p> : null}
          </header>
        </Reveal>
        {children}
      </div>
    </section>
  );
}
