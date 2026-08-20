// src/ui/app-rail-nav.tsx
'use client';

import { usePathname } from 'next/navigation';

import { PLACEHOLDER_PROJECTS } from './projects-placeholder';

const NAV_ITEMS = [
  { href: '/', label: 'Overview' },
  {
    href: '/projects',
    label: 'Projects',
    count: PLACEHOLDER_PROJECTS.length,
  },
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

export function AppRailNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary navigation">
      {NAV_ITEMS.map((item) => {
        const { href, label } = item;
        const isActive = isNavItemActive(pathname, href);
        const count = 'count' in item ? item.count : undefined;

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
    </nav>
  );
}
