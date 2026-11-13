/**
 * Anchored popover for the composer pickers — no dependency, just a fixed-
 * positioned card laid out above its trigger.
 *
 * - Closes on `mousedown` outside the popover AND outside the anchor
 *   element (so the trigger button can toggle without double-firing).
 * - Elements carrying `data-popover-keep` (e.g. ModelPicker's side flyout,
 *   which lives outside this card's bounds) do NOT count as outside clicks.
 * - `Escape` closes; horizontal position is clamped inside the viewport.
 *
 * The composer sits at the window's bottom edge, so "above the trigger" is
 * always the open direction; `side="top"` exists only for readability.
 */
import { useLayoutEffect, useRef, useState } from 'react'

interface PopoverProps {
  /** Element the card anchors to — typically the toggle button. */
  anchor: HTMLElement | null
  onClose: () => void
  /** Which anchor edge the card aligns to. */
  align?: 'start' | 'end'
  /** Vertical gap between anchor and card. */
  gap?: number
  className?: string
  children: React.ReactNode
}

/** Pixels of margin kept between the card and the viewport edges. */
const VIEWPORT_MARGIN = 8

export function Popover({
  anchor,
  onClose,
  align = 'start',
  gap = 6,
  className,
  children,
}: PopoverProps): React.JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties | null>(null)

  /* Position once the card is mounted (needs its own width for `end`
   * alignment + viewport clamping). useLayoutEffect avoids a visible jump. */
  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!anchor || !el) return
    const rect = anchor.getBoundingClientRect()
    const width = el.offsetWidth
    const left =
      align === 'end'
        ? rect.right - width
        : rect.left
    setStyle({
      position: 'fixed',
      bottom: window.innerHeight - rect.top + gap,
      left: Math.min(
        Math.max(left, VIEWPORT_MARGIN),
        Math.max(window.innerWidth - width - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
      ),
    })
  }, [anchor, align, gap])

  /* Outside-click + Escape dismissal. */
  useLayoutEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (popoverRef.current?.contains(target)) return
      if (anchor?.contains(target)) return
      if (
        target instanceof Element &&
        target.closest('[data-popover-keep]') !== null
      ) {
        return
      }
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, onClose])

  if (!anchor) return null

  return (
    <div
      ref={popoverRef}
      role="dialog"
      // Render at left:-9999 until measured so the card never flashes
      // unpositioned in the top-left corner.
      style={style ?? { position: 'fixed', bottom: 0, left: -9999 }}
      className={`z-50 rounded-lg border border-neutral-200 bg-white shadow-lg ${className ?? ''}`}
    >
      {children}
    </div>
  )
}
