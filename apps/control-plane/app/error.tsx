'use client';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="empty-state" role="alert">
      <h1>Something went wrong</h1>
      <p>The control plane could not load this view.</p>
      <button onClick={reset} type="button">
        Try again
      </button>
    </section>
  );
}
