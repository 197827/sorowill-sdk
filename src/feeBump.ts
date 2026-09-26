import {
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';

import { InvalidPublicKeyError, InvalidSecretKeyError } from './errors';
import { NETWORK_CONFIG, type SoroWillNetwork } from './SoroWillClient';

interface SendTransactionErrorResponse {
  status: string;
  hash?: string;
  diagnosticEventsXdr?: string;
  errorResultXdr?: string;
}

/** Options for building a fee-bump transaction. */
export interface FeeBumpOptions {
  /** The network to use. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the inner (prepared, unsigned) transaction. */
  innerTransactionXdr: string;
  /** The fee source account's public key (the account sponsoring the fee). */
  feeSourcePublicKey: string;
  /**
   * The maximum fee the sponsor is willing to pay, in stroops. Defaults to
   * the inner transaction's fee when omitted.
   */
  fee?: string;
}

/** Options for submitting a signed fee-bump transaction. */
export interface SubmitFeeBumpOptions {
  /** The network to use. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the signed fee-bump transaction. */
  feeBumpXdr: string;
  /** The maximum number of attempts to poll for transaction confirmation. Defaults to 30. */
  pollAttempts?: number;
}

/**
 * Build a fee-bump transaction that wraps an inner transaction,
 * allowing a different account (the fee sponsor) to pay the network fee.
 *
 * The inner transaction must already be prepared via
 * `server.prepareTransaction()`. The fee sponsor only needs to have
 * their account loaded — no Freighter connection is required on the
 * user's side.
 *
 * @returns The base64-encoded XDR of the fee-bump transaction envelope.
 * @throws {InvalidPublicKeyError} if `feeSourcePublicKey` is not a valid Stellar public key.
 */
export async function buildFeeBumpXdr(options: FeeBumpOptions): Promise<string> {
  const config = NETWORK_CONFIG[options.network];

  const { feeSourcePublicKey } = options;
  if (typeof feeSourcePublicKey !== 'string' || !feeSourcePublicKey.startsWith('G')) {
    throw new InvalidPublicKeyError('feeSourcePublicKey');
  }
  let feeSource: Keypair;
  try {
    feeSource = Keypair.fromPublicKey(feeSourcePublicKey);
  } catch (error) {
    throw new InvalidPublicKeyError('feeSourcePublicKey', { cause: error });
  }

  const innerTx = TransactionBuilder.fromXDR(
    options.innerTransactionXdr,
    config.networkPassphrase,
  ) as Transaction;

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    options.fee || innerTx.fee,
    innerTx,
    config.networkPassphrase,
  );

  return feeBumpTx.toXDR();
}

/**
 * Sign a fee-bump transaction with a secret key (the fee sponsor's key).
 * Returns the signed fee-bump transaction XDR.
 * @throws {InvalidSecretKeyError} if the secret key is malformed.
 */
export function signFeeBumpXdr(
  feeBumpXdr: string,
  secretKey: string,
  networkPassphrase: string,
): string {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secretKey);
  } catch {
    throw new InvalidSecretKeyError('signFeeBumpXdr');
  }

  const feeBump = TransactionBuilder.fromXDR(feeBumpXdr, networkPassphrase);

  const hashed = feeBump.hash();
  const sig = keypair.signDecorated(hashed);
  feeBump.addDecoratedSignature(sig);

  return feeBump.toXDR();
}

/** Renders an XDR value (or array of values) from an RPC response as base64 for error messages. */
function xdrToString(value: unknown): string {
  if (Array.isArray(value)) return value.map(xdrToString).join(', ');
  if (value && typeof (value as { toXDR?: unknown }).toXDR === 'function') {
    return (value as { toXDR: (format: 'base64') => string }).toXDR('base64');
  }
  return String(value);
}

/**
 * Submit a signed fee-bump transaction to the network and wait for confirmation.
 */
export async function submitFeeBumpTransaction(
  options: SubmitFeeBumpOptions,
): Promise<{ txHash: string; createdAt: number }> {
  const config = NETWORK_CONFIG[options.network];
  const rpcUrl = config.rpcUrls[0]!;
  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith('http://'),
  });

  const feeBumpTx = TransactionBuilder.fromXDR(
    options.feeBumpXdr,
    config.networkPassphrase,
  ) as Transaction;

  const sendResponse = await server.sendTransaction(feeBumpTx);
  if (sendResponse.status === 'ERROR') {
    const errorResponse = sendResponse as SendTransactionErrorResponse;
    const diagnosticInfo = errorResponse.diagnosticEventsXdr ?
      ` (diagnostics: ${errorResponse.diagnosticEventsXdr})` : '';
    const errorDetail = errorResponse.errorResultXdr ?
      ` (error: ${errorResponse.errorResultXdr})` : '';
    throw new Error(
      `Fee-bump transaction submission failed${diagnosticInfo}${errorDetail}`,
      { cause: sendResponse }
    );
  }

  const pollAttempts = options.pollAttempts ?? 30;
  const txResponse = await server.pollTransaction(sendResponse.hash, { attempts: pollAttempts });
  if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    const failed = txResponse as { resultXdr?: unknown; diagnosticEventsXdr?: unknown };
    const resultDetail = failed.resultXdr ? ` (result: ${xdrToString(failed.resultXdr)})` : '';
    const diagnosticDetail = failed.diagnosticEventsXdr ?
      ` (diagnostics: ${xdrToString(failed.diagnosticEventsXdr)})` : '';
    throw new Error(
      `Fee-bump transaction did not succeed: ${txResponse.status}${resultDetail}${diagnosticDetail}`,
      { cause: txResponse },
    );
  }

  return {
    txHash: sendResponse.hash,
    createdAt: txResponse.createdAt,
  };
}

/**
 * High-level helper: build, sign, and submit a fee-bump transaction in one call.
 *
 * @param options.innerTransactionXdr - Prepared inner transaction XDR (unsigned, after `server.prepareTransaction()`).
 * @param options.feeSourceSecretKey - Secret key of the fee sponsor account.
 * @param options.network - Stellar network to use.
 * @param options.pollAttempts - Maximum number of attempts to poll for transaction confirmation. Defaults to 30.
 */
export async function submitFeeBump(options: {
  innerTransactionXdr: string;
  feeSourceSecretKey: string;
  network: SoroWillNetwork;
  fee?: string;
  pollAttempts?: number;
}): Promise<{ txHash: string; createdAt: number }> {
  const config = NETWORK_CONFIG[options.network];
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(options.feeSourceSecretKey);
  } catch {
    throw new InvalidSecretKeyError('submitFeeBump');
  }
  const publicKey = keypair.publicKey();

  let fee = options.fee;
  if (!fee) {
    const innerTx = TransactionBuilder.fromXDR(
      options.innerTransactionXdr,
      config.networkPassphrase,
    ) as Transaction;
    fee = innerTx.fee;
  }

  const feeBumpXdr = await buildFeeBumpXdr({
    network: options.network,
    innerTransactionXdr: options.innerTransactionXdr,
    feeSourcePublicKey: publicKey,
    fee,
  });

  const signedXdr = signFeeBumpXdr(feeBumpXdr, options.feeSourceSecretKey, config.networkPassphrase);

  const submitOptions: SubmitFeeBumpOptions = {
    network: options.network,
    feeBumpXdr: signedXdr,
  };
  if (options.pollAttempts !== undefined) {
    submitOptions.pollAttempts = options.pollAttempts;
  }

  return submitFeeBumpTransaction(submitOptions);
}
