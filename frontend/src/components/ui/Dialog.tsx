import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

type DialogProps = {
  open: boolean
  onClose: () => void
  titleId: string
  className?: string
  children: React.ReactNode
}

export function Dialog({ open, onClose, titleId, className = '', children }: DialogProps) {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const panel = panelRef.current
    const controls = () => Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, summary, [tabindex]') ?? [])
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0 && !element.closest('[inert], [hidden]'))
    controls()[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
      if (event.key !== 'Tab' || !panel) return
      const focusable = controls()
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.section ref={panelRef} className={`dialog-panel ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} initial={{ opacity: 0, y: 28, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: .99 }} transition={{ duration: .28, ease: [0.22, 1, 0.36, 1] }} onMouseDown={(event) => event.stopPropagation()}>
            <button className="icon-button dialog-close" onClick={onClose} aria-label="Close dialog"><X /></button>
            {children}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
