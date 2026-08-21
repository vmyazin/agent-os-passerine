// src/ui/app-rail-nav.tsx
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { subscribeToProjectCount } from './project-count-signal';

const NAV_ITEMS = [
  { href: '/', label: 'Overview' },
  { href: '/projects', label: 'Projects', countKey: 'projects' as const },
  { href: '/runs', label: 'Runs' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/configuration', label: 'Configuration' },
  { href: '/setup', label: 'Setup' },
] as const;

function isNavItemActive(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppRailNav({
  children,
  inboxCount = 0,
  projectCount = 0,
}: {
  readonly children?: ReactNode;
  readonly inboxCount?: number;
  readonly projectCount?: number;
}) {
  const pathname = usePathname();
  // Seeded by the server layout, then kept live by anything that creates a
  // project without a navigation (the setup wizard). A later server render
  // re-seeds it through the effect below, so the server stays authoritative.
  const [liveProjectCount, setLiveProjectCount] = useState(projectCount);
  useEffect(() => setLiveProjectCount(projectCount), [projectCount]);
  useEffect(() => subscribeToProjectCount(setLiveProjectCount), []);

  return (
    <nav aria-label="Primary navigation">
      {NAV_ITEMS.map((item) => {
        const { href, label } = item;
        const isActive = isNavItemActive(pathname, href);
        const count =
          href === '/inbox'
            ? inboxCount > 0
              ? inboxCount
              : undefined
            : 'countKey' in item && item.countKey === 'projects'
              ? liveProjectCount > 0
                ? liveProjectCount
                : undefined
              : undefined;

        return (
          <a
            key={href}
            aria-current={isActive ? 'page' : undefined}
            aria-label={count === undefined ? undefined : `${label}, ${count}`}
            href={href}
          >
            <span className="rail-nav-label">{label}</span>
            {count === undefined ? null : (
              <span className="rail-nav-count">{count}</span>
            )}
          </a>
        );
      })}
      {children}
    </nav>
  );
}
