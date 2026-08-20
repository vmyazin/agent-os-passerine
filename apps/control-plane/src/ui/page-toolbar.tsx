// src/ui/page-toolbar.tsx
import type { ReactNode } from 'react';

export function PageToolbar({
  action,
  description,
  title,
  titleId,
}: {
  readonly action?: ReactNode;
  readonly description?: string;
  readonly title: string;
  readonly titleId?: string;
}) {
  return (
    <header className="page-toolbar">
      <div className="page-toolbar-copy">
        <h1 id={titleId}>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="page-toolbar-action">{action}</div> : null}
    </header>
  );
}
