// src/ui/icons.ts
//
// Lucide icons, vendored rather than installed.
//
// The geometry is Lucide's own, taken from lucide-static v1.39.0, which is
// ISC licensed (see LICENSE-lucide in this directory). Copying about a dozen
// paths keeps the dependency list as deliberate as the rest of this app and
// gives exact control of stroke and size; the cost is that adding the next
// icon is a manual step, which is the trade that was chosen.
//
// Every icon is decorative by default: `aria-hidden` unless a `title` is
// given, because status and actions in this UI are named in text and an icon
// that repeats a visible word only adds noise for a screen reader. An
// icon-only control must pass a `title` so it has an accessible name.
import { createElement, type ReactElement } from 'react';

export interface IconProps {
  /** Pixel size; the stroke scales with it. Defaults to 1em so it matches text. */
  readonly size?: number | string;
  readonly className?: string;
  /**
   * An accessible name. Omit for an icon that sits beside a text label, which
   * is the common case here; pass one only when the icon is the whole control.
   */
  readonly title?: string;
}

type IconElement = readonly [tag: string, attributes: Record<string, string>];

/** The shape every icon in this module has, so a set of them is one type. */
export type Icon = (props: IconProps) => ReactElement;

function icon(name: string, elements: readonly IconElement[]): Icon {
  return function Icon({
    size = '1em',
    className,
    title,
  }: IconProps): ReactElement {
    return createElement(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className:
          className === undefined
            ? `icon icon-${name}`
            : `icon icon-${name} ${className}`,
        focusable: 'false',
        ...(title === undefined
          ? { 'aria-hidden': true }
          : { role: 'img', 'aria-label': title }),
      },
      ...elements.map(([tag, attributes], index) =>
        createElement(tag, { key: index, ...attributes }),
      ),
    );
  };
}

export const BanIcon = icon('ban', [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'M4.929 4.929 19.07 19.071' }],
]);

export const CheckIcon = icon('check', [['path', { d: 'M20 6 9 17l-5-5' }]]);

export const ChevronRightIcon = icon('chevron-right', [
  ['path', { d: 'm9 18 6-6-6-6' }],
]);

export const CircleCheckIcon = icon('circle-check', [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'm16 9-5.5 5.5L8 12' }],
]);

export const CircleDashedIcon = icon('circle-dashed', [
  ['path', { d: 'M10.1 2.182a10 10 0 0 1 3.8 0' }],
  ['path', { d: 'M13.9 21.818a10 10 0 0 1-3.8 0' }],
  ['path', { d: 'M17.609 3.721a10 10 0 0 1 2.69 2.7' }],
  ['path', { d: 'M2.182 13.9a10 10 0 0 1 0-3.8' }],
  ['path', { d: 'M20.279 17.609a10 10 0 0 1-2.7 2.69' }],
  ['path', { d: 'M21.818 10.1a10 10 0 0 1 0 3.8' }],
  ['path', { d: 'M3.721 6.391a10 10 0 0 1 2.7-2.69' }],
  ['path', { d: 'M6.391 20.279a10 10 0 0 1-2.69-2.7' }],
]);

export const CircleXIcon = icon('circle-x', [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'm15 9-6 6' }],
  ['path', { d: 'm9 9 6 6' }],
]);

export const ClockIcon = icon('clock', [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'M12 6v6l4 2' }],
]);

export const CopyIcon = icon('copy', [
  ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
  ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
]);

export const ExternalLinkIcon = icon('external-link', [
  ['path', { d: 'M15 3h6v6' }],
  ['path', { d: 'M10 14 21 3' }],
  ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
]);

export const FileTextIcon = icon('file-text', [
  [
    'path',
    {
      d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    },
  ],
  ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
  ['path', { d: 'M10 9H8' }],
  ['path', { d: 'M16 13H8' }],
  ['path', { d: 'M16 17H8' }],
]);

export const GitBranchIcon = icon('git-branch', [
  ['path', { d: 'M15 6a9 9 0 0 0-9 9V3' }],
  ['circle', { cx: '18', cy: '6', r: '3' }],
  ['circle', { cx: '6', cy: '18', r: '3' }],
]);

export const GitCommitHorizontalIcon = icon('git-commit-horizontal', [
  ['circle', { cx: '12', cy: '12', r: '3' }],
  ['line', { x1: '3', x2: '9', y1: '12', y2: '12' }],
  ['line', { x1: '15', x2: '21', y1: '12', y2: '12' }],
]);

export const GitPullRequestIcon = icon('git-pull-request', [
  ['circle', { cx: '18', cy: '18', r: '3' }],
  ['circle', { cx: '6', cy: '6', r: '3' }],
  ['path', { d: 'M13 6h3a2 2 0 0 1 2 2v7' }],
  ['line', { x1: '6', x2: '6', y1: '9', y2: '21' }],
]);

export const PlayIcon = icon('play', [
  [
    'path',
    {
      d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z',
    },
  ],
]);

export const RotateCcwIcon = icon('rotate-ccw', [
  ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
  ['path', { d: 'M3 3v5h5' }],
]);

export const SquareIcon = icon('square', [
  ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
]);

export const XIcon = icon('x', [
  ['path', { d: 'M18 6 6 18' }],
  ['path', { d: 'm6 6 12 12' }],
]);
