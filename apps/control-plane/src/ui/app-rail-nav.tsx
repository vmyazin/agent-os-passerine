// src/ui/app-rail-nav.tsx
'use client';

import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', label: 'Overview' },
  { href: '/projects', label: 'Projects' },
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
      {NAV_ITEMS.map(({ href, label }) => {
        const isActive = isNavItemActive(pathname, href);

        return (
          <a
            key={href}
            aria-current={isActive ? 'page' : undefined}
            href={href}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
