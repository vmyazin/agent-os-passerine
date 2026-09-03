'use client';

import { Button } from '../src/ui/button';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="empty-state" role="alert">
      <h1>Something went wrong</h1>
      <p>The control plane could not load this view.</p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
