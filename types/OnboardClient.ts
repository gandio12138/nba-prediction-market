/**
 * OnboardClient — venue-agnostic interface for preparing a wallet to trade.
 *
 * Each market venue (Polymarket, Kalshi, ...) provides an adapter that
 * implements this interface. The CLI driver and strategies depend on the
 * interface, never on a specific SDK.
 */

/** Snapshot of a wallet's onboarding state on a given venue. */
export interface OnboardStatus {
  /** True when the funder contract (Safe / proxy / EOA itself) exists. */
  funderDeployed: boolean;
  /** True when every spender required for trading has sufficient allowance. */
  approvalsReady: boolean;
  /** True when CLOB API credentials can be derived from the signer. */
  credsReady: boolean;
  /** Collateral balance on the funder, in human units. */
  fundedCollateral: number;
  /** The address that holds collateral and signs orders' funder field. */
  funderAddress: string;
}

/** Operations for bringing a wallet from "fresh EOA" to "ready to trade". */
export interface OnboardClient {
  /** Pure / cheap lookup. Never mutates state. */
  status(): Promise<OnboardStatus>;
  /** Deploy funder if not deployed. No-op when already deployed. */
  ensureFunder(): Promise<{ deployed: boolean; txHash?: string }>;
  /** Set every spender approval. No-op for already-approved spenders. */
  ensureApprovals(): Promise<{ approved: boolean; txHash?: string }>;
  /** Derive (or create) CLOB API creds. Idempotent. */
  ensureCreds(): Promise<{ key: string; secret: string; passphrase: string }>;
  /**
   * Move the EOA's collateral into the funder, gaslessly.
   *
   * Pulls the source token (e.g. native USDC on Polygon) from the EOA via
   * an off-chain EIP-2612 permit, swaps to the venue's tradeable form on a
   * DEX, and wraps into the venue's collateral token — all in one batched
   * funder-initiated tx paid for by the relayer. The EOA never touches gas.
   *
   * No-op (`funded: false`) when the EOA holds zero of the source token.
   * `amountBaseUnits` (6-decimal base units for USDC) caps the pull;
   * defaults to the EOA's full balance.
   */
  ensureFunded(amountBaseUnits?: bigint): Promise<{
    funded: boolean;
    /** Source amount pulled from the EOA, in base units. */
    amount: bigint;
    /** Expected collateral amount delivered to the funder, in base units. */
    expectedOut: bigint;
    txHash?: string;
  }>;
}
