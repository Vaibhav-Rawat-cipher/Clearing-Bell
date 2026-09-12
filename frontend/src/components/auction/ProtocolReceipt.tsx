import { ArrowRight, Check } from 'lucide-react'
import { useDemoSession } from '../../context/DemoSessionContext'
import type { View } from '../../types'
import { AddressLink } from '../ui/ChainState'
import { Dialog } from '../ui/Dialog'

export function ProtocolReceipt({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (view: View) => void }) {
  const { lastTxHash, selectedRound, config } = useDemoSession()
  return <Dialog open={open} onClose={onClose} titleId="receipt-title" className="protocol-dialog">
    <span className="receipt-state"><i><Check /></i>TRANSACTION CONFIRMED</span><h2 id="receipt-title">Your order is in the book.</h2>
    <p>The transaction has been confirmed on {config?.network}. Submission does not guarantee a fill. The final allocation is determined when the round closes.</p>
    <div className="receipt-grid"><div><span>Round</span><b>{selectedRound?.id}</b></div><div><span>Market</span><b>{selectedRound?.bond.symbol} / {selectedRound?.settlement.symbol}</b></div></div>
    {lastTxHash && <AddressLink value={lastTxHash} full transaction />}
    <p className="inline-notice">Keep your tokens and approval available until settlement. This contract does not support order cancellation.</p>
    <button className="primary-action receipt-action" onClick={() => { onClose(); onNavigate('portfolio') }}>View my orders <ArrowRight /></button>
  </Dialog>
}
