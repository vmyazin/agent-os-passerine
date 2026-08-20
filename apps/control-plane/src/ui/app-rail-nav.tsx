// src/ui/app-rail-nav.tsx
'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

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
              ? projectCount > 0
                ? projectCount
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
