/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string
  readonly VITE_CHAIN_ID?: string
  readonly VITE_AUCTION_ENGINE_ADDRESS?: string
  readonly VITE_DEPLOYMENT_BLOCK?: string
  readonly VITE_NETWORK_NAME?: string
  readonly VITE_EXPLORER_URL?: string
}
