/**
 * Numeric error codes returned by the SoroWill contract, mirroring the
 * `WillError` enum in the contract's `errors.rs`.
 *
 * **IMPORTANT**: These values must be kept in sync manually with the
 * contract repo until the spec-drift tooling proposed there exists.
 *
 * @see {@link https://github.com/SoroWill/sorowill-contracts/blob/main/src/errors.rs}
 */
export enum WillErrorCode {
  /** The will was not found. */
  WillNotFound = 1,
  /** The caller is not the will owner. */
  NotOwner = 2,
  /** The will is not in the Active state. */
  WillNotActive = 3,
  /** The will has not been triggered. */
  WillNotTriggered = 4,
  /** The grace period has not expired yet. */
  GracePeriodNotExpired = 5,
  /** The grace period has already expired. */
  GracePeriodExpired = 6,
  /** Beneficiary percentages do not sum to 100. */
  InvalidPercentages = 7,
  /** The guardian has already voted in this cycle. */
  AlreadyVoted = 8,
  /** The caller is not a guardian of the will. */
  NotGuardian = 9,
  /** The check-in deadline has not yet passed. */
  CheckinNotDue = 10,
  /** The supplied amount is zero. */
  ZeroAmount = 11,
  /** Too many beneficiaries (exceeds {@link MAX_BENEFICIARIES}). */
  TooManyBeneficiaries = 12,
  /** The action requires the will to be `Released` or `Cancelled`. */
  WillNotSettled = 13,
  /** A merge was attempted but one or both wills are not `Active`. */
  WillNotBothActive = 14,
  /** A merge was attempted with the same will id for both sides. */
  SameWillId = 15,
  /** A merge would exceed the beneficiary or guardian limits. */
  MergeWouldExceedLimits = 16,
  /** The owner cannot also be a guardian of their own will. */
  OwnerCannotBeGuardian = 17,
  /** The referenced beneficiary is not in the will's beneficiary list. */
  BeneficiaryNotFound = 18,
  /** The keeper bounty exceeds the maximum allowed (100 bps / 1%). */
  KeeperBountyExceedsMax = 19,
  /** The guardian threshold is out of range (must be 1..=guardians.len()). */
  InvalidGuardianThreshold = 20,
  /** The sum of all fixed-amount allocations exceeds the will's balance. */
  FixedAmountExceedsBalance = 21,
  /** A single beneficiary percentage is outside the valid range. */
  InvalidPercentage = 22,
  /** The action requires the will to be `Released`. */
  WillNotReleased = 23,
  /** A merge was attempted between wills owned by different addresses. */
  NotSameOwner = 24,
  /** A check-in or grace period was zero or too large to represent. */
  InvalidPeriod = 25,
  /** The same address was supplied more than once in a guardian list. */
  DuplicateGuardian = 26,
  /** The guardian-list cooldown has not yet elapsed. */
  GuardianCooldownActive = 27,
  /** The supplied token does not respond to a `decimals()` probe (not SEP-41). */
  InvalidToken = 28,
  /** The same beneficiary address was supplied more than once. */
  DuplicateBeneficiary = 29,
  /** `confirm_will` was called on a will that is not `PendingConfirmation`. */
  WillNotConfirmed = 30,
  /** `confirm_will` was called after the confirmation deadline elapsed. */
  ConfirmationWindowExpired = 31,
  /** `get_wills` was called with more ids than the contract allows. */
  TooManyIds = 32,
  /** `split_will` was asked to split more than the will's current balance. */
  InsufficientBalance = 33,
  /** `split_will` was called with an empty or otherwise invalid split. */
  InvalidSplit = 34,
  /** `reveal_and_claim` was called with a pre-image matching no commitment. */
  InvalidPreimage = 35,
  /** `reveal_and_claim` was called for a slot that was already claimed. */
  AlreadyClaimed = 36,
  /** An owner or beneficiary index is full and cannot accept another will id. */
  TooManyWills = 37,
}

/**
 * A single beneficiary entry: an address and the percentage of the will's
 * balance it is entitled to receive when the inheritance is released.
 *
 * `percentage` is on a 0-100 scale (a positive integer), and a will's
 * beneficiary percentages must sum to exactly 100. The SDK converts this to
 * the contract's internal basis-point representation (0-10,000, summing to
 * 10,000) when submitting a transaction, so a `percentage` of `30` is bound
 * on-chain as `3000` basis points.
 */
export interface Beneficiary {
  address: string;
  percentage: number;
}

/** Lifecycle state of a will, mirroring `WillStatus` in the SoroWill contract. */
export enum WillStatus {
  /** The will has been created but is not yet fully confirmed on-chain (e.g. awaiting initial deposit settlement). */
  PendingConfirmation = 'PendingConfirmation',
  /** The will is funded and the owner is checking in on schedule. */
  Active = 'Active',
  /** The owner missed a check-in deadline; the grace period is running. */
  Triggered = 'Triggered',
  /** The grace period expired (or guardians reached quorum) and funds were released. */
  Released = 'Released',
  /** The owner cancelled the will and withdrew the remaining balance. */
  Cancelled = 'Cancelled',
  /** The will has been fully settled: all balances distributed and the record is closed. */
  Settled = 'Settled',
}

/** The full on-chain state of a single will, decoded into native JS types. */
export interface Will {
  /** Unique identifier for this will, as a decimal string (contract-side `u64`). */
  id: string;
  /** The address that created and funds the will. */
  owner: string;
  /** The token contract address (e.g. a USDC Stellar Asset Contract) held by the will. */
  token: string;
  /** The amount of `token` currently locked, in base units, as a decimal string. */
  balance: string;
  /**
   * The beneficiaries and their percentage shares (0-100 scale). Always sums
   * to 100. On-chain these are stored as basis points summing to 10,000; the
   * SDK exposes them on the 0-100 `percentage` scale.
   */
  beneficiaries: Beneficiary[];
  /** How many days the owner may go without checking in before the will can be triggered. */
  checkinPeriodDays: number;
  /** How many days after being triggered the owner has to prove they are alive. */
  gracePeriodDays: number;
  /** When the owner last checked in. */
  lastCheckin: Date;
  /** When the will was triggered, or `null` if it has never been triggered. */
  triggerTime: Date | null;
  /** Current lifecycle state of the will. */
  status: WillStatus;
  /** Optional guardian addresses (up to 3) who may force an early release. */
  guardians: string[];
  /** Number of distinct guardians who have voted in the current release cycle. */
  guardianVotes: number;
}

/** Parameters for {@link SoroWillClient.createWill}. */
export interface CreateWillParams {
  /** The token contract address (e.g. a USDC Stellar Asset Contract) to lock. */
  token: string;
  /** The amount of `token` to lock, in base units, as a decimal string. */
  amount: string;
  /**
   * 1 to 10 beneficiaries whose `percentage` values (0-100 scale) sum to
   * exactly 100. The SDK scales these to basis points (summing to 10,000)
   * before submitting to the contract.
   */
  beneficiaries: Beneficiary[];
  /** How many days the owner may go without checking in. */
  checkinPeriodDays: number;
  /** How many days after being triggered the owner has to prove they are alive. */
  gracePeriodDays: number;
  /** 0 to 3 guardian addresses that may jointly force an early release. */
  guardians: string[];
}

/** Parameters for {@link SoroWillClient.updateBeneficiaries}. */
export interface UpdateBeneficiariesParams {
  willId: string;
  beneficiaries: Beneficiary[];
}

/** Optional client-side pagination controls for list-style SDK methods. */
export interface PaginationOptions {
  /** Maximum number of wills to return in this page. */
  pageSize?: number;
  /** Opaque cursor returned by the previous page, if any. */
  cursor?: string | undefined;
}

/** A page of wills plus the cursor needed to fetch the next page, if any. */
export interface PaginatedWillsResult {
  wills: Will[];
  nextCursor: string | null;
}

/** Normalized contract event emitted by the SoroWill contract. */
export interface SoroWillEvent {
  id: string;
  cursor: string;
  ledger: number | null;
  ledgerClosedAt: Date | null;
  contractId: string | null;
  txHash: string | null;
  type: string | null;
  topics: unknown[];
  value: unknown;
  raw: unknown;
}

/** Which transport backs an active event subscription. */
export type EventSubscriptionTransport = 'polling' | 'websocket';

/** Controls how event subscriptions are established and paged. */
export interface EventSubscriptionOptions {
  /** Cursor to resume from. Omit to start from the latest available cursor. */
  cursor?: string;
  /** Maximum number of events to request per fetch/stream chunk. */
  pageSize?: number;
  /** Polling interval when the polling transport is used. */
  pollIntervalMs?: number;
  /**
   * Force a specific transport, or auto-negotiate with WebSocket fallback.
   * `'websocket'` requires the client to be configured with both
   * `webSocketFactory` and `eventStreamUrl` — unlike `'auto'`, it throws
   * `WebSocketNotConfiguredError` rather than silently falling back to
   * polling when they aren't.
   */
  transport?: 'auto' | EventSubscriptionTransport;
  /**
   * How long to wait for the WebSocket to open before falling back to HTTP
   * polling. Guards against a server that accepts the connection but never
   * completes (or fails) the WebSocket handshake. Defaults to 10000 ms; set
   * to 0 to wait indefinitely.
   */
  websocketConnectTimeoutMs?: number;
  /** Optional callback for transport-level errors. */
  onError?: (error: Error) => void;
}

/** Handle for an active event subscription. */
export interface EventSubscription {
  readonly transport: EventSubscriptionTransport;
  readonly closed: boolean;
  close(): void;
}

/** Options accepted by individual SDK calls. */
export interface RequestOptions {
  /** Overrides the client's default RPC timeout for this call. */
  timeoutMs?: number;
  /** An AbortSignal that can be used to cancel the in-flight request. */
  signal?: AbortSignal;
}

/**
 * A contract invocation to submit via `batch`. Soroban allows only one
 * `InvokeHostFunction` operation per transaction, so a batch holds exactly one.
 */
export interface BatchOperation {
  /** Contract function name, such as `create_will` or `check_in`. */
  method: string;
  /** Native named arguments expected by the deployed contract spec. */
  args: Record<string, unknown>;
}

/** Result of submitting a batch (a single contract invocation) as a Stellar transaction. */
export interface BatchResult {
  txHash: string;
  createdAt: number;
}
