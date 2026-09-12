import { BaseError, ContractFunctionRevertedError } from 'viem'

export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/User rejected|User denied|rejected the request|user rejected/i.test(message)) return 'The request was declined in your wallet. No transaction was submitted.'
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      const reasons: Record<string, string> = {
        NotIssuer: 'Only the issuer account can perform this action.',
        RoundNotOpen: 'This round is no longer open. Refresh to view its latest status.',
        RoundStillOpen: 'The bidding deadline has not passed. Only the issuer can close a round early.',
        BidWindowClosed: 'The bidding deadline has passed. Your order was not submitted.',
        BidderNotEligible: 'This wallet is not eligible to trade this bond. The issuer must approve it in the identity registry.',
        RegistryNotSet: 'The issuer has not registered an identity registry for this bond.',
        EnforcedPause: 'The auction engine is paused by the issuer.',
        ExpectedPause: 'The auction engine is already active.',
        ERC20InsufficientBalance: 'Settlement cannot proceed because a participant has an insufficient token balance.',
        ERC20InsufficientAllowance: 'Settlement cannot proceed because a participant has insufficient token approval.',
        SafeERC20FailedOperation: 'A token transfer failed. Check token approvals, balances, and transfer restrictions.',
      }
      if (name && reasons[name]) return reasons[name]
      return reverted.shortMessage || 'The contract rejected this request.'
    }
    if (/HTTP request failed|fetch failed|Failed to fetch|timeout|timed out|ECONNREFUSED/i.test(message)) {
      return 'Cannot reach the configured blockchain RPC. Check that the network or local chain is running, then retry.'
    }
    return error.shortMessage
  }
  return message
}
