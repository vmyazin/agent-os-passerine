# Email-style inbox design

## Outcome

Replace the current card grid with a calm correspondence workspace that lets the
single operator scan pending requests and act on one item without losing queue
context.

## Intent

- **Human:** a trusted operator checking agent requests between development tasks.
- **Primary task:** identify the next pending request, understand its scope, and
  approve, reject, or reply.
- **Feel:** a precise email client with the restraint of an operations console.

## Domain exploration

- **Concepts:** queue, correspondent, subject, preview, received time, thread,
  unread state, decision, reply, run context.
- **Color world:** graphite ink, white correspondence sheet, cool gray dividers,
  muted violet selection, amber waiting state, restrained green completion.
- **Signature:** every request is presented as correspondence from an Agent OS
  role, with a compact type marker, run identity, and attention state.
- **Defaults rejected:** a card grid becomes a continuous message queue; a giant
  page heading becomes a compact mailbox toolbar; raw JSON becomes readable
  message copy with machine details disclosed separately.

## Layout

On desktop, use a bordered two-column mailbox surface. The left column is a
compact list of approvals and questions sorted newest first. The selected item is
shown in a reading pane on the right with run metadata, readable content, and the
existing action controls. On narrow screens, stack the queue above the reading
pane without horizontal overflow.

Selection is local UI state only. It does not introduce read receipts or mutate
the domain. The first pending item is selected initially. Each row is a native
button with visible focus and selected state.

## Content hierarchy

1. Mailbox title and pending count.
2. Request type, subject, run identity, and received time in the queue.
3. Human-readable request or approval scope in the reading pane.
4. Primary action: reply or approve. Reject remains a clearly labeled secondary
   action.
5. Scope hash and expiry are supporting metadata, not headline content.

## Visual system

Retain the existing Inter/system font stack and existing graphite, off-white,
gray, and violet tokens. Use borders-only depth for the inbox surface and rows.
Use an 8 px spacing base, 12 px panel radii, and the existing focus ring. Color
appears only on selection, focus, request markers, and semantic states.

## Accessibility and responsive behavior

- Label the request list and reading pane as named regions.
- Expose selection with `aria-pressed` and visible text, not color alone.
- Keep controls at least 44 px high on touch screens.
- Preserve DOM order as queue then selected message on mobile.
- Clamp and wrap long run IDs, scope hashes, and request bodies.
- Avoid decorative motion; selection changes are immediate.

## Scope

The work changes presentation only. Approval/rejection/reply endpoints,
idempotency, persistence, and service projections remain unchanged.
