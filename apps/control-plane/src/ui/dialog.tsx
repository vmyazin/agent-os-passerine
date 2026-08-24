'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  readonly children: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className="dialog-content" {...props}>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle(
  props: ComponentProps<typeof DialogPrimitive.Title>,
) {
  return <DialogPrimitive.Title className="dialog-title" {...props} />;
}

export function DialogDescription(
  props: ComponentProps<typeof DialogPrimitive.Description>,
) {
  return (
    <DialogPrimitive.Description className="dialog-description" {...props} />
  );
}
