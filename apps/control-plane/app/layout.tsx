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
        <header className="site-header">
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
        </header>
        <main id="main-content">{children}</main>
        <footer>Agent OS control plane</footer>
      </body>
    </html>
  );
}
