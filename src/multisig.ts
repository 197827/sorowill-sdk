import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

import { InvalidSecretKeyError, InvalidTransactionXdrError } from './errors';

/** A single collected signature from one signer. */
export interface CollectedSignature {
  /** The public key of the signer who signed. */
  signerPublicKey: string;
  /** The base64-encoded decorated signature. */
  signature: string;
}

/** Options for creating a {@link MultisigCollector}. */
export interface MultisigCollectorOptions {
  /** The base64-encoded XDR of the transaction envelope to sign. */
  transactionXdr: string;
  /** The Stellar network passphrase. */
  networkPassphrase: string;
  /** The number of signatures required before the transaction can be submitted. */
  threshold: number;
}

/**
 * Validates that a transaction XDR is well-formed and can be decoded.
 * @throws {InvalidTransactionXdrError} if the XDR is malformed.
 */
function validateTransactionXdr(transactionXdr: string): void {
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(transactionXdr, 'base64');
    if (
      envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx() &&
      envelope.switch() !== xdr.EnvelopeType.envelopeTypeTxFeeBump()
    ) {
      throw new Error('Unsupported transaction envelope type');
    }
  } catch {
    throw new InvalidTransactionXdrError();
  }
}

/**
 * Tracks partial signature collection for a multi-signature Stellar
 * transaction. Build the transaction, distribute the XDR to signers,
 * collect their signatures via {@link addSignature}, and submit once
 * the threshold is met.
 *
 * @example
 * ```ts
 * const collector = new MultisigCollector({
 *   transactionXdr: preparedTxXdr,
 *   networkPassphrase: Networks.TESTNET,
 *   threshold: 2,
 * });
 *
 * // Distribute collector.transactionXdr to each signer...
 * collector.addSignature('SIGNER_PUBLIC_KEY_1', sig1);
 * collector.addSignature('SIGNER_PUBLIC_KEY_2', sig2);
 *
 * if (collector.isReady) {
 *   const signedTx = collector.build();
 *   await server.sendTransaction(signedTx);
 * }
 * ```
 */
export class MultisigCollector {
  private readonly _transactionXdr: string;
  private readonly _networkPassphrase: string;
  private readonly _threshold: number;
  private readonly _signatures: CollectedSignature[] = [];

  constructor(options: MultisigCollectorOptions) {
    if (!Number.isInteger(options.threshold) || options.threshold < 1) {
      throw new Error('Threshold must be an integer of at least 1');
    }
    validateTransactionXdr(options.transactionXdr);
    this._transactionXdr = options.transactionXdr;
    this._networkPassphrase = options.networkPassphrase;
    this._threshold = options.threshold;
  }

  /** The base64-encoded XDR of the transaction envelope to be signed. */
  get transactionXdr(): string {
    return this._transactionXdr;
  }

  /** The Stellar network passphrase. */
  get networkPassphrase(): string {
    return this._networkPassphrase;
  }

  /** The number of signatures required before submission. */
  get threshold(): number {
    return this._threshold;
  }

  /** All collected signatures so far. */
  get signatures(): ReadonlyArray<CollectedSignature> {
    return this._signatures;
  }

  /** The number of signatures collected so far. */
  get signatureCount(): number {
    return this._signatures.length;
  }

  /** Whether enough signatures have been collected to submit. */
  get isReady(): boolean {
    return this._signatures.length >= this._threshold;
  }

  /**
   * Add a signature from a signer.
   * @throws if the signer has already signed.
   * @throws if signerPublicKey is not a valid Stellar Ed25519 public key.
   * @throws if signature is empty, not a valid decorated signature, or its hint does not match the signer.
   */
  addSignature(signerPublicKey: string, signature: string): void {
    if (!StrKey.isValidEd25519PublicKey(signerPublicKey)) {
      throw new Error(
        `"${signerPublicKey}" is not a valid Stellar public key. ` +
          'A Stellar Ed25519 public key must be a 56-character StrKey starting with "G".',
      );
    }
    if (this._signatures.some((s) => s.signerPublicKey === signerPublicKey)) {
      throw new Error(`Signer ${signerPublicKey} has already signed`);
    }
    if (!signature) {
      throw new Error(`Signature for signer ${signerPublicKey} must not be empty`);
    }
    let decorated: xdr.DecoratedSignature;
    try {
      decorated = xdr.DecoratedSignature.fromXDR(signature, 'base64');
    } catch {
      throw new Error(
        `Signature for signer ${signerPublicKey} is not a valid base64-encoded decorated signature`,
      );
    }
    if (decorated.signature().length !== 64) {
      throw new Error(`Signature for signer ${signerPublicKey} must be 64 bytes`);
    }
    if (!decorated.hint().equals(Keypair.fromPublicKey(signerPublicKey).signatureHint())) {
      throw new Error(`Signature hint does not match signer ${signerPublicKey}`);
    }
    this._signatures.push({ signerPublicKey, signature });
  }

  /** Remove all collected signatures, allowing the collection to restart. */
  reset(): void {
    this._signatures.length = 0;
  }

  /**
   * Build the final signed transaction by combining the envelope with all
   * collected signatures. Only call this when {@link isReady} is true.
   * @throws if the threshold has not been met.
   */
  build(): Transaction {
    if (!this.isReady) {
      throw new Error(
        `Not enough signatures: ${this._signatures.length}/${this._threshold} collected`,
      );
    }

    const envelope = xdr.TransactionEnvelope.fromXDR(this._transactionXdr, 'base64');
    if (
      envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx() &&
      envelope.switch() !== xdr.EnvelopeType.envelopeTypeTxFeeBump()
    ) {
      throw new Error('Unsupported transaction envelope type');
    }

    const txV1 =
      envelope.switch() === xdr.EnvelopeType.envelopeTypeTx()
        ? envelope.v1()
        : envelope.feeBump().tx().innerTx().v1();
    if (!txV1) {
      throw new Error('Transaction envelope is not a V1 transaction');
    }

    for (const sig of this._signatures.length > 0 ? this._signatures : [{ signerPublicKey: '', signature: '' }]) {
      if (!sig.signature) continue;
      const decoratedSignature = xdr.DecoratedSignature.fromXDR(sig.signature, 'base64');
      txV1.signatures().push(decoratedSignature);
    }

    return TransactionBuilder.fromXDR(
      envelope.toXDR().toString('base64'),
      this._networkPassphrase,
    ) as Transaction;
  }

  /** Serialise the collector state (signatures + metadata) for storage or transport. */
  toJSON(): {
    transactionXdr: string;
    networkPassphrase: string;
    threshold: number;
    signatures: CollectedSignature[];
  } {
    return {
      transactionXdr: this._transactionXdr,
      networkPassphrase: this._networkPassphrase,
      threshold: this._threshold,
      signatures: [...this._signatures],
    };
  }

  /** Reconstitute a collector from a serialised state.
   * @throws {InvalidTransactionXdrError} if the transaction XDR is malformed.
   */
  static fromJSON(data: {
    transactionXdr: string;
    networkPassphrase: string;
    threshold: number;
    signatures: CollectedSignature[];
  }): MultisigCollector {
    const collector = new MultisigCollector(data);
    for (const sig of data.signatures) {
      collector.addSignature(sig.signerPublicKey, sig.signature);
    }
    return collector;
  }
}

/**
 * Build a multisig-ready transaction XDR for a SoroWill contract call,
 * without signing or submitting it. The returned XDR can be distributed
 * to signers and collected via {@link MultisigCollector}.
 */
interface ContractSpec {
  funcArgsToScVals(method: string, args: Record<string, unknown>): unknown[];
}

export async function buildMultisigTransactionXdr(options: {
  rpcUrl: string;
  networkPassphrase: string;
  contractAddress: string;
  method: string;
  args: Record<string, unknown>;
  sourceAccount: string;
  fee?: string;
  timeout?: number;
  spec?: ContractSpec;
}): Promise<string> {
  const { Spec } = await import('@stellar/stellar-sdk').then((m) => m.contract);
  const server = new rpc.Server(options.rpcUrl, {
    allowHttp: options.rpcUrl.startsWith('http://'),
  });
  const contract = new Contract(options.contractAddress);

  // Use provided spec or fetch fresh from WASM.
  let spec: ContractSpec | undefined = options.spec;
  if (!spec) {
    const wasm = await server.getContractWasmByContractId(contract.contractId());
    spec = Spec.fromWasm(wasm) as ContractSpec;
  }

  const scArgs = spec.funcArgsToScVals(options.method, options.args);
  // @ts-expect-error scArgs type mismatch between ContractSpec and stellar-sdk
  const operation = contract.call(options.method, ...scArgs);

  const account = new Account(options.sourceAccount, '0');
  const tx = new TransactionBuilder(account, {
    fee: options.fee ?? BASE_FEE,
    networkPassphrase: options.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(options.timeout ?? 30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  return prepared.toXDR();
}

/**
 * Sign a transaction XDR with a specific secret key and return the
 * decorated signature as a base64 string suitable for
 * {@link MultisigCollector.addSignature}.
 * @throws {InvalidSecretKeyError} if the secret key is malformed.
 */
export function signWithSecretKey(
  transactionXdr: string,
  secretKey: string,
  networkPassphrase: string,
): string {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secretKey);
  } catch {
    throw new InvalidSecretKeyError('signWithSecretKey');
  }

  const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase) as Transaction;

  const hashed = tx.hash();
  const signature = keypair.signDecorated(hashed);
  return signature.toXDR().toString('base64');
}
