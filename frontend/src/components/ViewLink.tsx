import type { ComponentProps } from 'react'
import { viewHref } from '../hooks/useHashRoute'
import type { View } from '../types'

/** Keep real URLs available to crawlers, keyboard users, and open-in-new-tab. */
export function ViewLink({ view, onNavigate, onClick, ...props }: Omit<ComponentProps<'a'>, 'href'> & { view: View; onNavigate: (view: View) => void }) {
  return <a {...props} href={viewHref(view)} onClick={event => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === '_blank') return
    event.preventDefault()
    onNavigate(view)
  }} />
}
