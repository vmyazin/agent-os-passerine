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
          <span aria-label="Agent OS home" className="wordmark">
            Agent OS
          </span>
          <nav aria-label="Primary navigation">
            <a aria-current="page" href="/">
              Overview
            </a>
          </nav>
        </header>
        <main id="main-content">{children}</main>
        <footer>Agent OS control plane foundation</footer>
      </body>
    </html>
  );
}
