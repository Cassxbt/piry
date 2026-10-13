import { LazyMotion, animate, domAnimation, m, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export function MotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation} strict>{children}</LazyMotion>;
}

interface RevealProps {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  style?: CSSProperties;
}

// Scroll reveal: fade and a short rise, once. Plain element under reduced motion.
export function Reveal({ children, delay = 0, y = 14, className, style }: RevealProps) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className} style={style}>{children}</div>;
  return (
    <m.div
      className={className}
      style={style}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.5, delay, ease: EASE_OUT }}
    >
      {children}
    </m.div>
  );
}

// Children rise in sequence, 60ms apart.
export function Stagger({ children, className }: { children: ReactNode[]; className?: string }) {
  return (
    <div className={className}>
      {children.map((child, i) => (
        <Reveal key={i} delay={i * 0.06}>{child}</Reveal>
      ))}
    </div>
  );
}

interface CountUpProps {
  value: number | null;
  format: (n: number) => string;
  duration?: number;
  className?: string;
}

// Counts from zero to a live value when it first scrolls into view, then eases between later updates.
export function CountUp({ value, format, duration = 0.9, className }: CountUpProps) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -5% 0px" });
  const fmt = useRef(format);
  fmt.current = format;
  const shown = useRef<number>(0);
  const [text, setText] = useState(() => (value === null ? "n/a" : format(0)));

  useEffect(() => {
    if (value === null) {
      setText("n/a");
      return;
    }
    if (reduce) {
      shown.current = value;
      setText(fmt.current(value));
      return;
    }
    if (!inView) return;
    const controls = animate(shown.current, value, {
      duration,
      ease: EASE_OUT,
      onUpdate: (v) => {
        shown.current = v;
        setText(fmt.current(v));
      },
      onComplete: () => setText(fmt.current(value)),
    });
    return () => controls.stop();
  }, [value, inView, reduce, duration]);

  return <span ref={ref} className={className}>{text}</span>;
}
