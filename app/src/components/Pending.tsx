import type { ReactNode } from "react";

export function Pending({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pending" role="status">
      <strong>{title}</strong>
      {children ? <span className="sub">{children}</span> : null}
    </div>
  );
}

export function PendingInline({ children = "Pending" }: { children?: ReactNode }) {
  return <span className="pending-inline">{children}</span>;
}
