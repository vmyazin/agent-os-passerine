// app/layout.tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  description: 'A control plane for Agent OS.',
  title: 'Agent OS',
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <div className="app-shell">
          <aside className="app-rail">
            <a aria-label="Agent OS home" className="wordmark" href="/">
              Agent OS
            </a>
            <nav aria-label="Primary navigation">
              <a href="/">Overview</a>
              <a href="/runs">Runs</a>
              <a href="/inbox">Inbox</a>
              <a href="/configuration">Configuration</a>
              <a href="/setup">Setup</a>
            </nav>
            <footer className="app-rail-footer">Agent OS control plane</footer>
          </aside>
          <div className="app-content">
            <main id="main-content">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
