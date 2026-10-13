import { config } from "../../config";

// ?series= switches the whole app between deployments on this network (a full reload, since config is read once).
export function SeriesSwitch() {
  if (config.seriesChoices.length < 2) return null;
  return (
    <nav className="series-switch" aria-label="Series on this network">
      {config.seriesChoices.map((choice) => (
        <a
          key={choice.id ?? "live"}
          href={choice.id ? `?series=${choice.id}` : "?"}
          aria-current={config.variant === choice.id ? "true" : undefined}
          title={choice.blurb}
        >
          {choice.label}
        </a>
      ))}
      <span className="sub">{config.seriesChoices.find((c) => c.id === config.variant)?.blurb}</span>
    </nav>
  );
}
