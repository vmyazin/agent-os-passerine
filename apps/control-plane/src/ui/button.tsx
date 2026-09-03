import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';

import type { Icon } from './icons';

/**
 * How much weight a control carries.
 *
 * `primary` is the action a view exists to perform, and there is normally one
 * per view. `secondary` is everything else with a border around it.
 * `quiet` is an affordance that should not compete with the content beside
 * it -- a copy control in a header, a close in a dialog corner.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet';

/** `md` is the page default; `sm` is for controls that sit inside dense rows. */
export type ButtonSize = 'sm' | 'md';

export interface ButtonAppearance {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** A glyph before the label, sized under it. */
  readonly icon?: Icon;
  /** Fills the width it is given, for stacked forms and narrow screens. */
  readonly block?: boolean;
  readonly className?: string;
}

export function buttonClassName({
  variant = 'primary',
  size = 'md',
  block = false,
  className,
}: ButtonAppearance): string {
  return [
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    block ? 'btn-block' : '',
    className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}

export type ButtonProps = ButtonAppearance &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>;

/**
 * Every button in the control plane.
 *
 * Appearance is chosen by name rather than by class, so a view says what a
 * control means -- primary, secondary, quiet -- and how that looks is decided
 * in one place. Before this, weight was spelled `className="secondary"` at
 * fifty-odd call sites and the compact-vs-large question had no answer at
 * all.
 *
 * `type` defaults to `button`. HTML defaults it to `submit`, which inside a
 * form makes an unrelated control submit it; the buttons here that do mean
 * submit say so.
 */
export function Button({
  variant,
  size,
  icon: Glyph,
  block,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      className={buttonClassName({
        ...(variant === undefined ? {} : { variant }),
        ...(size === undefined ? {} : { size }),
        ...(block === undefined ? {} : { block }),
        ...(className === undefined ? {} : { className }),
      })}
      type={type}
      {...rest}
    >
      {Glyph === undefined ? null : <Glyph className="button-icon" />}
      {children}
    </button>
  );
}

export type ButtonLinkProps = ButtonAppearance &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'>;

/**
 * A link that carries a button's weight.
 *
 * Navigation stays a link -- it opens in a new tab, it can be copied, it
 * works without JavaScript -- while looking like the action it is.
 */
export function ButtonLink({
  variant,
  size,
  icon: Glyph,
  block,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <a
      className={buttonClassName({
        ...(variant === undefined ? {} : { variant }),
        ...(size === undefined ? {} : { size }),
        ...(block === undefined ? {} : { block }),
        ...(className === undefined ? {} : { className }),
      })}
      {...rest}
    >
      {Glyph === undefined ? null : <Glyph className="button-icon" />}
      {children}
    </a>
  );
}
