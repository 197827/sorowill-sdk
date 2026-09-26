import { StrKey } from '@stellar/stellar-sdk';

import type { Beneficiary, Will } from './types';
import { WillStatus } from './types';

/** USDC (and most Soroban SEP-41 tokens) use 7 decimal places, matching classic Stellar asset precision. */
const USDC_DECIMALS = 7;

/**
 * Approximate Soroban ledger close time, in milliseconds. Matches the
 * default `defaultPollIntervalMs` used internally by `SoroWillClient` for
 * event subscriptions, so consumers polling `getWill` or transaction status
 * themselves don't each have to hardcode this magic number independently.
 */
export const SOROBAN_LEDGER_CLOSE_TIME_MS = 5_000;

/**
 * Formats a base-unit token amount (e.g. contract-side `i128` stroops) as a
 * human-readable decimal string with thousands separators, e.g.
 * `formatUSDC(12345000000n) === "1,234.50"`.
 */
export function formatUSDC(stroops: bigint, decimals = USDC_DECIMALS): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;
  const cents = fraction / 10n ** BigInt(Math.max(decimals - 2, 0));

  const wholeFormatted = whole.toLocaleString('en-US');
  const centsFormatted = cents.toString().padStart(2, '0');

  return `${negative ? '-' : ''}${wholeFormatted}.${centsFormatted}`;
}

/**
 * Parses a human-readable decimal USDC string (e.g. `"1234.50"` or
 * `"1,234.5"`) into base units (stroops), as a `bigint`.
 */
export function toStroops(usdc: string, decimals = USDC_DECIMALS): bigint {
  const cleaned = usdc.replace(/,/g, '').trim();
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned) || cleaned === '-' || cleaned === '.') {
    throw new Error(`Invalid USDC amount: "${usdc}"`);
  }

  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholePart = '', fractionPart = ''] = unsigned.split('.');
  if (fractionPart.length > USDC_DECIMALS) {
    throw new Error(
      `Invalid USDC amount: "${usdc}" has more than ${USDC_DECIMALS} fractional digits, which would silently lose precision.`,
    );
  }
  const paddedFraction = fractionPart.padEnd(USDC_DECIMALS, '0');

  const whole = BigInt(wholePart === '' ? '0' : wholePart);
  const fraction = BigInt(paddedFraction === '' ? '0' : paddedFraction);
  const total = whole * (10n ** BigInt(decimals)) + fraction;

  return negative ? -total : total;
}

/**
 * Returns the number of seconds until `will`'s next check-in deadline.
 * Negative values mean the deadline has already passed.
 */
export function getTimeUntilCheckin(will: Will): number {
  const deadlineMs = will.lastCheckin.getTime() + will.checkinPeriodDays * 86_400 * 1000;
  return Math.floor((deadlineMs - Date.now()) / 1000);
}

/** Returns whether `will`'s check-in deadline has already passed. */
export function isCheckinDue(will: Will): boolean {
  return getTimeUntilCheckin(will) <= 0;
}

/**
 * Splits `balance` (base units, as a decimal string) across `beneficiaries`
 * proportionally to their percentages, mirroring the on-chain distribution
 * logic exactly: integer division per beneficiary, with any rounding
 * remainder paid to the final beneficiary so the shares always sum to the
 * full balance.
 *
 * This function mirrors the Rust contract's `distribute()` function in the
 * SoroWill contracts repository:
 * https://github.com/SoroWill/sorowill-contracts/blob/main/contracts/will/src/lib.rs
 * (see `fn distribute` — integer division with remainder assigned to the
 * last beneficiary). Keep this implementation in sync with any changes to
 * that contract function.
 *
 * `beneficiary.percentage` is the SDK's 0-100 value. The contract works in
 * basis points (`percentage * 100`) and divides by 10,000, which is
 * arithmetically identical to dividing by 100 here, so the split matches
 * on-chain distribution exactly.
 */
export function calculateShares(
  balance: string,
  beneficiaries: Beneficiary[],
): Array<{ address: string; share: string }> {
  const total = BigInt(balance);
  let remaining = total;

  return beneficiaries.map((beneficiary, index) => {
    const isLast = index === beneficiaries.length - 1;
    const share = isLast
      ? remaining
      : (total * BigInt(beneficiary.percentage)) / 100n;
    remaining -= share;
    return { address: beneficiary.address, share: share.toString() };
  });
}

/**
 * Tags each beneficiary with its index in the on-chain order. Callers who
 * want to sort or filter beneficiaries for display (e.g. alphabetically)
 * can sort the tagged copy and still recover the original on-chain order
 * (by sorting on `onChainIndex`) before passing beneficiaries to
 * {@link calculateShares}, so the rounding remainder is attributed correctly.
 */
export function tagOnChainOrder(
  beneficiaries: Beneficiary[],
): Array<Beneficiary & { onChainIndex: number }> {
  return beneficiaries.map((beneficiary, onChainIndex) => ({ ...beneficiary, onChainIndex }));
}

/** Formats a `Date` as a human-readable string, e.g. `"Jan 5, 2027, 3:45 PM"`. */
export function formatDeadline(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Maximum number of beneficiaries the SoroWill contract allows per will.
 *
 * **IMPORTANT**: This value mirrors the `MAX_BENEFICIARIES` constant in the
 * contract's `contracts/will/src/lib.rs` and must be kept in sync manually until the
 * contracts repo ships automated spec-drift tooling (issue #122).
 */
export const MAX_BENEFICIARIES = 10;

/**
 * Maximum number of guardians the SoroWill contract allows per will.
 *
 * **IMPORTANT**: This value mirrors the `MAX_GUARDIANS` constant in the
 * contract's `contracts/will/src/lib.rs` and must be kept in sync manually until the
 * contracts repo ships automated spec-drift tooling (issue #122).
 */
export const MAX_GUARDIANS = 3;

/**
 * Validates that a beneficiary list is well-formed: non-empty, at most
 * {@link MAX_BENEFICIARIES} entries, no duplicate addresses (compared
 * case-insensitively), every percentage is a positive integer, and
 * percentages sum to exactly 100.
 *
 * Percentages are on the SDK's 0-100 scale. `SoroWillClient` scales them to
 * the contract's basis points (summing to 10,000) when it submits a
 * transaction.
 */
export function validateBeneficiaries(beneficiaries: Beneficiary[]): boolean {
  if (beneficiaries.length === 0 || beneficiaries.length > MAX_BENEFICIARIES) {
    return false;
  }
  if (!beneficiaries.every((b) => StrKey.isValidEd25519PublicKey(b.address))) {
    return false;
  }
  if (hasDuplicateBeneficiaries(beneficiaries)) {
    return false;
  }
  if (!beneficiaries.every((b) => Number.isInteger(b.percentage) && b.percentage > 0)) {
    return false;
  }
  const sum = beneficiaries.reduce((acc, b) => acc + b.percentage, 0);
  return sum === 100;
}

/**
 * Returns whether two or more entries in `beneficiaries` share the same
 * address (compared case-insensitively), which the contract rejects with
 * `WillError::DuplicateBeneficiary`.
 */
export function hasDuplicateBeneficiaries(beneficiaries: Beneficiary[]): boolean {
  const addresses = new Set(beneficiaries.map((b) => b.address.toUpperCase()));
  return addresses.size !== beneficiaries.length;
}

/** Returns whether `address` is one of `will`'s guardians. */
export function isGuardian(will: Will, address: string): boolean {
  return will.guardians.includes(address);
}

/** Returns whether `address` is one of `will`'s beneficiaries. */
export function isBeneficiary(will: Will, address: string): boolean {
  return will.beneficiaries.some((b) => b.address === address);
}

/**
 * Describes what the wallet at `connectedAddress` can currently do for
 * `will`, combining its status, owner, guardians, and beneficiaries with
 * the check-in deadline. Intended to drive which action buttons a UI shows.
 */
export interface NextActionableState {
  canCheckIn: boolean;
  canTrigger: boolean;
  canEmergencyCheckIn: boolean;
  canRelease: boolean;
  canCancel: boolean;
  canGuardianVote: boolean;
}

export interface NextActionableStateOptions {
  guardianAlreadyVoted?: boolean;
}

/**
 * Computes {@link NextActionableState} for `will` from the perspective of
 * `connectedAddress`. Only the owner may check in, cancel, or emergency
 * check in; triggering and releasing are permissionless once their
 * on-chain preconditions are met; and guardians may vote for an early
 * release at any point before the will is released or cancelled.
 *
 * PendingConfirmation: the will exists but is not yet active, so no
 * owner actions are available until it transitions to Active.
 *
 * Settled: the will is fully closed; no further actions are possible.
 */
export function getNextActionableState(
  will: Will,
  connectedAddress: string,
  nowOrOptions: Date | NextActionableStateOptions = new Date(),
): NextActionableState {
  const now = nowOrOptions instanceof Date ? nowOrOptions : new Date();
  const options: NextActionableStateOptions = nowOrOptions instanceof Date ? {} : nowOrOptions;

  // Terminal / pre-active states with no available actions
  if (
    will.status === WillStatus.PendingConfirmation ||
    will.status === WillStatus.Released ||
    will.status === WillStatus.Cancelled ||
    will.status === WillStatus.Settled
  ) {
    return {
      canCheckIn: false,
      canTrigger: false,
      canEmergencyCheckIn: false,
      canRelease: false,
      canCancel: false,
      canGuardianVote: false,
    };
  }

  const isOwner = will.owner === connectedAddress;
  const isWillGuardian = isGuardian(will, connectedAddress);

  const graceDeadlineMs =
    (will.triggerTime?.getTime() ?? 0) + will.gracePeriodDays * 86_400 * 1000;
  const isGracePeriodExpired = will.triggerTime !== null && now.getTime() >= graceDeadlineMs;

  return {
    canCheckIn: isOwner && will.status === WillStatus.Active,
    canTrigger: will.status === WillStatus.Active && isCheckinDue(will),
    canEmergencyCheckIn: isOwner && will.status === WillStatus.Triggered && !isGracePeriodExpired,
    canRelease: will.status === WillStatus.Triggered && isGracePeriodExpired,
    canCancel: isOwner && will.status === WillStatus.Active,
    canGuardianVote:
      isWillGuardian &&
      !options.guardianAlreadyVoted &&
      (will.status === WillStatus.Active || will.status === WillStatus.Triggered),
  };
}
/**
 * Validates a guardian list: empty list is valid (guardians are optional),
 * at most {@link MAX_GUARDIANS} entries, every address (including the
 * optional `ownerAddress`) is a syntactically valid Stellar public key, no
 * duplicate addresses, and no owner address in the list.
 *
 * @param guardians - The list of guardian addresses to validate.
 * @param ownerAddress - Optional owner address; when supplied, the function
 *                       rejects any guardian that matches it.
 */
export function validateGuardians(guardians: string[], ownerAddress?: string): boolean {
  if (guardians.length > MAX_GUARDIANS) {
    return false;
  }
  if (!guardians.every((address) => StrKey.isValidEd25519PublicKey(address))) {
    return false;
  }
  if (ownerAddress !== undefined && !StrKey.isValidEd25519PublicKey(ownerAddress)) {
    return false;
  }
  const unique = new Set(guardians);
  if (unique.size !== guardians.length) {
    return false;
  }
  if (ownerAddress !== undefined && unique.has(ownerAddress)) {
    return false;
  }
  return true;
}
