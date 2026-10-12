import { useId, type ReactNode } from "react";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  unit?: string;
  hint?: ReactNode;
  error?: string | null;
  inputMode?: "decimal" | "numeric" | "text";
  placeholder?: string;
  disabled?: boolean;
  trailing?: ReactNode;
}

export function Field({ label, value, onChange, unit, hint, error, inputMode = "decimal", placeholder, disabled, trailing }: Props) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </label>
      <div className={`input${error ? " invalid" : ""}`}>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={inputMode}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        {trailing}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {error ? <span className="field-error" id={`${id}-err`} role="alert">{error}</span> : null}
    </div>
  );
}
