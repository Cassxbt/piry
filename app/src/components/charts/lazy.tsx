import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

const Scenario = lazy(() => import("./ScenarioChart"));
const MarkHistory = lazy(() => import("./MarkHistoryChart"));
const Depth = lazy(() => import("./DepthChart"));

function Fallback({ height }: { height: number }) {
  return <div className="chart-empty" style={{ height }} aria-busy="true">Loading chart</div>;
}

// The chart library is the heaviest dependency, so it is fetched when a chart is about to scroll into view, not on page load.
function WhenNear({ height, children }: { height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = ref.current;
    if (near || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return <div ref={ref}>{near ? <Suspense fallback={<Fallback height={height} />}>{children}</Suspense> : <Fallback height={height} />}</div>;
}

export function ScenarioChart(props: ComponentProps<typeof Scenario>) {
  return (
    <WhenNear height={(props.height ?? 300) + 140}>
      <Scenario {...props} />
    </WhenNear>
  );
}

export function MarkHistoryChart(props: ComponentProps<typeof MarkHistory>) {
  return (
    <WhenNear height={(props.height ?? 280) + 150}>
      <MarkHistory {...props} />
    </WhenNear>
  );
}

export function DepthChart(props: ComponentProps<typeof Depth>) {
  return (
    <WhenNear height={props.height ?? 170}>
      <Depth {...props} />
    </WhenNear>
  );
}
