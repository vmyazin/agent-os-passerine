// app/layout.tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { AppRailNav } from '../src/ui/app-rail-nav';
import { AppRailStatus } from '../src/ui/app-rail-status';
import { fetchRailCounts } from '../src/ui/rail-counts';

export const metadata: Metadata = {
  description: 'A control plane for Agent OS.',
  title: 'Agent OS',
};

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const counts = await fetchRailCounts();
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
            <AppRailNav inboxCount={counts?.inboxCount ?? 0} />
            <footer className="app-rail-footer">Agent OS control plane</footer>
          </aside>
          <div className="app-content">
            <AppRailStatus counts={counts} />
            <div className="app-content-scroll">
              <main id="main-content">{children}</main>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
