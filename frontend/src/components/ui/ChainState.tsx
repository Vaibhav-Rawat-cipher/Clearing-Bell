import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useDemoSession } from '../../context/DemoSessionContext'
import { shortAddress } from '../../utils/format'

export function ChainState({ children }: { children: React.ReactNode }) {
  const { connectionStatus, error, refresh } = useDemoSession()
  if (connectionStatus === 'loading') return <div className="page-fallback" role="status"><i /><span>Reading auction contracts…</span></div>
  if (connectionStatus === 'error') return <section className="empty-state"><h2>Unable to read the market</h2><p>{error || 'The configured network is unavailable.'}</p><button className="secondary-action" onClick={() => void refresh()}><RefreshCw />Retry connection</button></section>
  return <>{children}</>
}

export function AddressLink({ value, transaction = false, full = false }: { value: string; transaction?: boolean; full?: boolean }) {
  const { config } = useDemoSession()
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const explorer = config?.explorerUrl?.replace(/\/$/, '')
  // HashScan uses /transaction/<hash> and /address/<addr>
  const path = transaction ? 'transaction' : 'address'
  return <span className="contract-address" title={value}>
    {explorer ? <a href={`${explorer}/${path}/${value}`} target="_blank" rel="noreferrer">{full ? value : shortAddress(value)}<ExternalLink size={12} /></a> : <span>{full ? value : shortAddress(value)}</span>}
    <button aria-label={`Copy ${transaction ? 'transaction hash' : 'address'} ${shortAddress(value)}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setCopyError(false); setTimeout(() => setCopied(false), 1800) } catch { setCopyError(true) } }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
    {copyError && <small role="status">Copy unavailable. Select the address to copy.</small>}
  </span>
}

/** Renders a clickable HashScan transaction link */
export function TxLink({ hash, label }: { hash: string; label?: string }) {
  const { config } = useDemoSession()
  const explorer = config?.explorerUrl?.replace(/\/$/, '')
  const short = `${hash.slice(0, 8)}…${hash.slice(-6)}`
  return explorer
    ? <a className="tx-link" href={`${explorer}/transaction/${hash}`} target="_blank" rel="noreferrer">{label ?? short}<ExternalLink size={11} /></a>
    : <code className="tx-link">{label ?? short}</code>
}
