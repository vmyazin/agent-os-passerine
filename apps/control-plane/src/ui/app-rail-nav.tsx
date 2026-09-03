// src/ui/app-rail-nav.tsx
'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import {
  inboxAttentionPresentation,
  subscribeToInboxAttentionCount,
} from './inbox-count-client';
import {
  activeRunPresentation,
  subscribeToActiveRunCount,
} from './active-run-count-client';
import {
  ActivityIcon,
  CirclePlusIcon,
  FileTextIcon,
  FolderGit2Icon,
  InboxIcon,
  LayoutDashboardIcon,
} from './icons';
import { subscribeToProjectCount } from './project-count-signal';

// A glyph per destination, so the rail is navigable by shape once the
// operator knows it. The label stays and remains the accessible name; the
// icon is decorative, as it repeats a word that is already visible.
const NAV_ITEMS = [
  { href: '/', label: 'Overview', icon: LayoutDashboardIcon },
  {
    href: '/projects',
    label: 'Projects',
    icon: FolderGit2Icon,
    countKey: 'projects' as const,
  },
  { href: '/runs', label: 'Runs', icon: ActivityIcon },
  { href: '/inbox', label: 'Inbox', icon: InboxIcon },
  { href: '/configuration', label: 'Configuration', icon: FileTextIcon },
  { href: '/setup', label: 'Setup', icon: CirclePlusIcon },
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
  activeRunCount = 0,
}: {
  readonly children?: ReactNode;
  readonly inboxCount?: number;
  readonly projectCount?: number;
  readonly activeRunCount?: number;
}) {
  const pathname = usePathname();
  const [liveInboxCount, setLiveInboxCount] = useState(inboxCount);
  useEffect(() => setLiveInboxCount(inboxCount), [inboxCount]);
  useEffect(() => subscribeToInboxAttentionCount(setLiveInboxCount), []);
  // Seeded by the server layout, then kept live by anything that creates a
  // project without a navigation (the setup wizard). A later server render
  // re-seeds it through the effect below, so the server stays authoritative.
  const [liveProjectCount, setLiveProjectCount] = useState(projectCount);
  useEffect(() => setLiveProjectCount(projectCount), [projectCount]);
  useEffect(() => subscribeToProjectCount(setLiveProjectCount), []);
  const [liveActiveRunCount, setLiveActiveRunCount] = useState(activeRunCount);
  useEffect(() => setLiveActiveRunCount(activeRunCount), [activeRunCount]);
  useEffect(() => subscribeToActiveRunCount(setLiveActiveRunCount), []);

  return (
    <nav aria-label="Primary navigation">
      {NAV_ITEMS.map((item) => {
        const { href, label, icon: NavIcon } = item;
        const isActive = isNavItemActive(pathname, href);
        const inboxPresentation =
          href === '/inbox'
            ? inboxAttentionPresentation(liveInboxCount)
            : undefined;
        const runPresentation =
          href === '/runs'
            ? activeRunPresentation(liveActiveRunCount)
            : undefined;
        const count =
          href === '/inbox'
            ? inboxPresentation?.badgeText
            : 'countKey' in item && item.countKey === 'projects'
              ? liveProjectCount > 0
                ? liveProjectCount
                : undefined
              : runPresentation?.badgeText;

        return (
          <a
            key={href}
            aria-current={isActive ? 'page' : undefined}
            aria-label={
              inboxPresentation?.ariaLabel ??
              runPresentation?.ariaLabel ??
              (count === undefined ? undefined : `${label}, ${count}`)
            }
            href={href}
          >
            <span className="rail-nav-label">
              <NavIcon className="rail-nav-icon" />
              <span className="rail-nav-label-text">{label}</span>
              {runPresentation === undefined ? null : (
                <span
                  aria-hidden="true"
                  className="status-spinner rail-nav-spinner"
                />
              )}
            </span>
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
