import { StrKey } from '@stellar/stellar-sdk';

import type { Beneficiary, Will } from './types';
import { WillStatus } from './types';

/**
 * Default decimal precision assumed by {@link formatUSDC} and
 * {@link toStroops} when the caller does not supply an explicit `decimals`
 * value.
 *
 * **Assumption**: this default of 6 matches canonical USDC on most chains
 * (Ethereum, Polygon, etc.). USDC-like or bridged tokens can use a different
 * scale (e.g. 7 decimals for classic Stellar asset precision, or 8 for some
 * wrapped tokens), so callers handling such tokens must pass the token's
 * actual `decimals` explicitly to avoid displaying incorrect amounts.
 */
const USDC_DECIMALS = 6;

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
 *
 * `decimals` is the token's on-chain decimal precision and defaults to
 * {@link USDC_DECIMALS} (6). Pass the token's actual `decimals` when it is
 * not 6 (e.g. 7 for classic Stellar asset precision) so the displayed
 * amount is scaled correctly instead of assuming a hardcoded 6.
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
 * Expands a number written in scientific notation (e.g. `"1e-8"`,
 * `"1.5e3"`, `"-2.5E-4"`) into its equivalent plain decimal string, so the
 * rest of {@link toStroops} can parse it with the same logic used for
 * standard decimal notation. Returns `null` when `value` is not valid
 * scientific notation.
 */
function expandScientificNotation(value: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) {
    return null;
  }

  const [, sign, intPart, fracPart = '', expPart] = match;
  const exponent = Number(expPart);
  const digits = intPart + fracPart;
  // Position of the decimal point relative to `digits` after applying the exponent.
  const pointPos = intPart.length + exponent;

  let expanded: string;
  if (pointPos <= 0) {
    expanded = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    expanded = `${digits}${'0'.repeat(pointPos - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }

  return `${sign}${expanded}`;
}

/**
 * Parses a human-readable decimal USDC string (e.g. `"1234.50"` or
 * `"1,234.5"`) into base units (stroops), as a `bigint`.
 *
 * `decimals` is the token's on-chain decimal precision and defaults to
 * {@link USDC_DECIMALS} (6). Pass the token's actual `decimals` when it is
 * not 6 so the parsed base units match the token's scale.
 *
 * Scientific notation (e.g. `"1e-8"`) is expanded to standard decimal
 * notation before the `decimals` offset is applied, so
 * `toStroops("1e-8", 8) === 100000000n`.
 */
export function toStroops(usdc: string, decimals = USDC_DECIMALS): bigint {
  const cleaned = usdc.replace(/,/g, '').trim();
  const expanded = expandScientificNotation(cleaned) ?? cleaned;
  if (expanded === '' || !/^-?\d*\.?\d*$/.test(expanded) || expanded === '-' || expanded === '.') {
    throw new Error(`Invalid USDC amount: "${usdc}"`);
  }

  const negative = expanded.startsWith('-');
  const unsigned = negative ? expanded.slice(1) : expanded;
  const [wholePart = '', fractionPart = ''] = unsigned.split('.');
  if (fractionPart.length > decimals) {
    throw new Error(
      `Invalid USDC amount: "${usdc}" has more than ${decimals} fractional digits, which would silently lose precision.`,
    );
  }
  const paddedFraction = fractionPart.padEnd(decimals, '0');

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
 * https://github.com/SoroWill/sorowill-contracts/blob/main/contracts/sorowill/src/contract.rs
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
 * contract's `errors.rs` and must be kept in sync manually until the
 * contracts repo ships automated spec-drift tooling (issue #122).
 */
export const MAX_BENEFICIARIES = 10;

/**
 * Maximum number of guardians the SoroWill contract allows per will.
 *
 * **IMPORTANT**: This value mirrors the `MAX_GUARDIANS` constant in the
 * contract's `errors.rs` and must be kept in sync manually until the
 * contracts repo ships automated spec-drift tooling (issue #122).
 */
export const MAX_GUARDIANS = 3;

/**
 * Validates that a beneficiary list is well-formed: non-empty, at most
 * {@link MAX_BENEFICIARIES} entries, every percentage is a positive
 * integer, and percentages sum to exactly 100.
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
  if (!beneficiaries.every((b) => Number.isInteger(b.percent

/* … truncated 1388 chars — edit only what you need near the top … */
