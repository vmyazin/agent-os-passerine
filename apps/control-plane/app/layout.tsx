// app/layout.tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { AppRailNav } from '../src/ui/app-rail-nav';
import { AppRailStatus } from '../src/ui/app-rail-status';

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
            <AppRailStatus />
            <AppRailNav />
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
