import { ArrowRight, Check, Eye, ShieldAlert, ShieldCheck, WalletCards } from 'lucide-react'
import { useDemoSession } from '../../context/DemoSessionContext'
import { requiredOrderFunds, sameAddress } from '../../lib/amounts'
import { amount } from '../../utils/format'

export function OrderComposer({ onCommitted, deadlinePassed, onBrowseMarkets }: { onCommitted: () => void; deadlinePassed: boolean; onBrowseMarkets: () => void }) {
  const { selectedRound: round, rounds, account, eligibility, identity, order, openIdentityDialog, setOrderSide, updateOrder, approveOrder, submitOrder, tokens, paused, pendingTx, walletChainId, config } = useDemoSession()
  let problem = ''
  let required = '0'
  let covered = false
  let notional = order.price && order.quantity ? (Number(order.price) * Number(order.quantity)).toString() : 'NaN'
  const fundingToken = round && (order.side === 'BUY' ? round.settlement : round.bond)
  const holding = tokens.find(t => sameAddress(t.address, fundingToken?.address))
  const balance = holding?.balance || '0'
  if (round && account) {
    try {
      const funds = requiredOrderFunds(order, round, rounds, account)
      required = funds.requiredFormatted
      notional = (Number(order.price) * Number(order.quantity)).toString()
      covered = Boolean(holding && holding.allowanceRaw >= funds.required)
      if (!holding || holding.balanceRaw < funds.required) problem = `Insufficient ${funds.token.symbol}. This order and your outstanding orders require ${amount(required, 6)}.`
    } catch (error) { problem = error instanceof Error ? error.message : 'Enter a valid order.' }
  }
  const closed = !round || round.phase !== 'open' || deadlinePassed
  const unavailable = Boolean(pendingTx) || paused || closed || walletChainId !== config?.chainId
  const eligibilityLabel = !account ? 'Connect to check eligibility' : eligibility === true ? 'Eligible for this security' : eligibility === false ? 'Not eligible for this security' : 'Checking eligibility…'
  if (closed && round) return <aside className="order-composer composer-complete">
    <span className="composer-state"><Check size={17} />{round.phase === 'closed' ? 'ROUND COMPLETE' : 'WINDOW CLOSED'}</span>
    <h2>{round.phase === 'closed' ? 'The result is on record.' : 'Awaiting settlement.'}</h2>
    <p>{round.phase === 'closed' ? 'Review the final clearing result and submitted orders in this workspace.' : 'No more orders can enter this round. A connected wallet can now trigger clearing.'}</p>
    <dl className="order-summary"><div><dt>Matched quantity</dt><dd>{round.phase === 'closed' ? `${amount(round.clearedQuantity)} ${round.bond.symbol}` : 'Pending'}</dd></div><div><dt>Clearing price</dt><dd>{round.clearedQuantityRaw > 0n ? `${amount(round.clearingPrice)} ${round.settlement.symbol}` : round.phase === 'closed' ? 'No match' : 'Pending'}</dd></div></dl>
    <button className="commit-action" onClick={onBrowseMarkets}>Browse other auctions <ArrowRight /></button>
  </aside>
  return <aside className="order-composer">
    <div className="composer-tabs" role="group" aria-label="Order side">{(['BUY', 'SELL'] as const).map(side => <button key={side} className={order.side === side ? `active ${side.toLowerCase()}` : ''} aria-pressed={order.side === side} onClick={() => setOrderSide(side)} disabled={Boolean(pendingTx)}>{side === 'BUY' ? 'Buy' : 'Sell'}</button>)}</div>
    <button className={`eligibility-decision ${identity}`} onClick={openIdentityDialog}><i>{!account ? <WalletCards /> : eligibility === true ? <ShieldCheck /> : <ShieldAlert />}</i><span><b>{eligibilityLabel}</b><small>{account ? 'Checked against the identity registry' : 'Your wallet stays in your control'}</small></span><ArrowRight /></button>
    <div className="composer-field"><label htmlFor="limit-price"><span>Limit price</span><small>{round?.settlement.symbol || 'Payment'} / bond</small></label><div><input id="limit-price" value={order.price} onChange={e => updateOrder({ price: e.target.value })} inputMode="decimal" autoComplete="off" disabled={Boolean(pendingTx)} aria-describedby="order-validation" /><b>{round?.settlement.symbol}</b></div></div>
    <div className="composer-field"><label htmlFor="order-quantity"><span>Quantity</span><small>{round?.bond.symbol}</small></label><div><input id="order-quantity" value={order.quantity} onChange={e => updateOrder({ quantity: e.target.value })} inputMode="decimal" autoComplete="off" disabled={Boolean(pendingTx)} aria-describedby="order-validation" /><b>BONDS</b></div><div className="size-options">{['1', '10', '25', '100'].map(value => <button key={value} disabled={Boolean(pendingTx)} onClick={() => updateOrder({ quantity: value })}>{value}</button>)}</div></div>
    <dl className="order-summary"><div><dt>{order.side === 'BUY' ? 'Maximum order value' : 'Limit order value'}</dt><dd>{amount(notional, 6)} {round?.settlement.symbol}</dd></div><div><dt>Wallet balance</dt><dd>{account ? `${amount(balance, 6)} ${fundingToken?.symbol}` : 'Connect wallet'}</dd></div><div><dt>Total approval needed</dt><dd>{!account ? 'Connect wallet' : order.price && order.quantity ? `${amount(required, 6)} ${fundingToken?.symbol}` : 'Enter an order'}</dd></div><div><dt>Price rule</dt><dd>Uniform clearing price</dd></div></dl>
    <div id="order-validation" aria-live="polite">{closed ? <p className="inline-notice">Bidding is closed for this round.</p> : paused ? <p className="inline-error">Trading is paused by the issuer.</p> : account && order.price && order.quantity && problem ? <p className="inline-error">{problem}</p> : null}</div>
    {!account ? <button className="commit-action" onClick={openIdentityDialog}><WalletCards />Connect wallet to trade</button> : <>
      {!covered && !closed && <button className="commit-action" disabled={unavailable || eligibility !== true || Boolean(problem)} onClick={() => void approveOrder()}><Check />{pendingTx?.label.startsWith('Approve') ? 'Approving…' : `1. Approve ${fundingToken?.symbol || 'tokens'}`}</button>}
      <button className="commit-action" disabled={unavailable || eligibility !== true || Boolean(problem) || !covered} onClick={async () => { if (await submitOrder()) onCommitted() }}><ArrowRight />{pendingTx ? 'Transaction in progress…' : `${covered ? '' : '2. '}Place ${order.side.toLowerCase()} order`}</button>
    </>}
    <p className="privacy-note"><Eye />Orders are public and cannot be cancelled. Keep enough tokens and approval available until the round settles. Approval includes your other open orders.</p>
  </aside>
}
