import type FreighterApi from '@stellar/freighter-api';

import { FreighterInstallCheckError, SignTransactionTimeoutError } from './errors';

/**
 * `@stellar/freighter-api` is an optional peer dependency — consumers who
 * only use Albedo, Ledger, WalletConnect, or a custom {@link WalletAdapter}
 * are not required to install it. Importing it lazily (only when a
 * `FreighterWalletAdapter` method actually runs) keeps the SDK's main entry
 * point importable without it installed.
 */
let freighterApiPromise: Promise<typeof FreighterApi> | undefined;
function loadFreighterApi(): Promise<typeof FreighterApi> {
  if (!freighterApiPromise) {
    freighterApiPromise = import('@stellar/freighter-api').then((mod) => mod.default);
  }
  return freighterApiPromise;
}

/** Default timeout (ms) for a wallet signTransaction call. */
const DEFAULT_SIGN_TIMEOUT_MS = 120_000;

/**
 * The `code` Freighter's `isConnected()` API returns for the ordinary
 * "extension not present/injected" case (e.g. running outside a browser, or
 * no Freighter extension installed) — as opposed to an unexpected internal
 * Freighter error, which should surface instead of being treated as "not
 * installed".
 */
const FREIGHTER_NOT_INSTALLED_CODE = -1;

/** Result of a successful wallet connection. */
export interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface. {@link FreighterWalletAdapter}
 * is the default implementation, backed by the Freighter browser extension.
 */
/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface. The module-level
 * {@link getPublicKey} and {@link signTransaction} functions already satisfy
 * it (see {@link freighterAdapter}).
 *
 * ### Browser wallets
 *
 * Browser-extension adapters (Freighter, Albedo, …) implement this interface
 * and present a user-facing approval prompt when `signTransaction` is called.
 * These are the right choice for any application that handles real end-user
 * funds in a browser context.
 *
 * ### Scripts, automation, and testing — `KeypairSigner`
 *
 * For Node.js scripts, keeper bots, demo scripts, or unit tests where there is
 * no browser extension available, build a lightweight adapter directly on top
 * of `@stellar/stellar-sdk`'s `Keypair`:
 *
 * ```ts
 * import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
 * import type { WalletAdapter } from '@sorowill/sdk';
 *
 * export class KeypairSigner implements WalletAdapter {
 *   constructor(private readonly keypair: Keypair) {}
 *
 *   async getPublicKey(): Promise<string> {
 *     return this.keypair.publicKey();
 *   }
 *
 *   async signTransaction(
 *     transactionXdr: string,
 *     opts: { networkPassphrase: string },
 *   ): Promise<string> {
 *     const tx = TransactionBuilder.fromXDR(
 *       transactionXdr,
 *       opts.networkPassphrase,
 *     ) as Transaction;
 *     tx.sign(this.keypair);
 *     return tx.toXDR();
 *   }
 * }
 * ```
 *
 * Pass it to the client via the `wallet` option:
 *
 * ```ts
 * const signer = new KeypairSigner(Keypair.fromSecret('S...'));
 * const client = new SoroWillClient({ network: 'testnet', contractId: 'C...', wallet: signer });
 * ```
 *
 * > **Security warning:** `KeypairSigner` holds a raw secret key in memory.
 * > It is intended for scripts, automation, and testing only — never use it
 * > to handle real end-user funds in a browser or any environment where the
 * > secret could be exposed to untrusted code.
 */
export interface SignTransactionOptions {
  networkPassphrase: string;
  timeoutMs?: number;
}

export interface WalletAdapter {
  isConnected(): Promise<boolean>;
  connect(): Promise<WalletConnection>;
  reconnect(): Promise<WalletConnection>;
  disconnect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction(transactionXdr: string, opts: SignTransactionOptions): Promise<string>;
  /** Reports the network this wallet is currently set to, without prompting the user. Optional — not every wallet adapter can report this. */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

export class FreighterWalletAdapter implements WalletAdapter {
  /**
   * Reports whether the Freighter extension is present and reachable.
   *
   * Resolves `false` only for the ordinary "extension not installed/injected"
   * case. Any other error Freighter's `isConnected()` API reports (e.g. it
   * was called outside a browser, or Freighter hit an internal error) is
   * surfaced as a thrown {@link FreighterInstallCheckError} instead of being
   * silently treated as "not installed".
   */
  async isConnected(): Promise<boolean> {
    const freighterApi = await loadFreighterApi();
    const { isConnected, error } = await freighterApi.isConnected();
    if (error) {
      if (error.code === FREIGHTER_NOT_INSTALLED_CODE) {
        return false;
      }
      throw new FreighterInstallCheckError(error.code, error.message);
    }
    return isConnected;
  }

  async connect(): Promise<WalletConnection> {
    const freighterApi = await loadFreighterApi();
    const access = await freighterApi.requestAccess();
    if (access.error) {
      throw new Error(access.error.message);
    }

    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }

    return {
      publicKey: access.address,
      network: networkDetails?.network ?? '',
      networkPassphrase: networkDetails?.networkPassphrase ?? '',
    };
  }

  async reconnect(): Promise<WalletConnection> {
    const publicKey = await this.getPublicKey();
    const freighterApi = await loadFreighterApi();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }

    return {
      publicKey,
      network: networkDetails?.network ?? '',
      networkPassphrase: networkDetails?.networkPassphrase ?? '',
    };
  }

  async disconnect(): Promise<void> {
    return;
  }

  /** Reports the network Freighter is currently set to, without prompting the user. */
  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const freighterApi = await loadFreighterApi();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }
    return {
      network: networkDetails?.network ?? '',
      networkPassphrase: networkDetails?.networkPassphrase ?? '',
    };
  }

  async getPublicKey(): Promise<string> {
    const freighterApi = await loadFreighterApi();
    const { address, error } = await freighterApi.getAddress();
    if (error) {
      throw new Error(error.message);
    }
    if (!address) {
      throw new Error('No Freighter account is connected. Call connectWallet() first.');
    }
    return address;
  }

  async signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string; timeoutMs?: number },
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
    // Kicked off synchronously (not awaited yet) so the timeout below is
    // still registered before this function's first `await`, regardless of
    // how long the dynamic import takes to resolve.
    const freighterApiPromise = loadFreighterApi();

    // Race the Freighter call against a timer so that a hung or dismissed
    // popup never leaves the caller's promise pending indefinitely (#154).
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new SignTransactionTimeoutError(timeoutMs)),
        timeoutMs,
      );
    });

    try {
      const { signedTxXdr, error } = await Promise.race([
        freighterApiPromise.then((freighterApi) =>
          freighterApi.signTransaction(transactionXdr, {
            networkPassphrase: opts.networkPassphrase,
          }),
        ),
        timeoutPromise,
      ]);
      if (error) {
        throw new Error(error.message);
      }
      return signedTxXdr;
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }
}

const defaultFreighterWalletAdapter = new FreighterWalletAdapter();

/**
 * Checks whether the Freighter browser extension is installed. This does not
 * require the current site to be connected/allowed — it only checks for the
 * extension's presence.
 *
 * @throws {FreighterInstallCheckError} if the underlying check fails for a
 * reason other than the extension being absent (e.g. running outside a
 * browser, or an internal Freighter error). Callers that only want a
 * best-effort "should I show an install prompt?" signal can treat a caught
 * {@link FreighterInstallCheckError} as "unknown" rather than "not installed".
 */
export async function isFreighterInstalled(): Promise<boolean> {
  return await defaultFreighterWalletAdapter.isConnected();
}

/** Connects to the Freighter wallet and returns the connection details. */
export async function connectWallet(): Promise<WalletConnection> {
  return await defaultFreighterWalletAdapter.connect();
}

/** Returns the public key of the currently connected Freighter account. */
export async function getPublicKey(): Promise<string> {
  return await defaultFreighterWalletAdapter.getPublicKey();
}

/** Signs a transaction XDR using the connected Freighter wallet. */
export async function signTransaction(
  transactionXdr: string,
  opts: { networkPassphrase: string; timeoutMs?: number },
): Promise<string> {
  return await defaultFreighterWalletAdapter.signTransaction(transactionXdr, opts);
}

/** Returns the default Freighter-based wallet adapter instance. */
export function getDefaultWalletAdapter(): WalletAdapter {
  return defaultFreighterWalletAdapter;
}

/**
 * The default {@link WalletAdapter}, backed by the Freighter browser
 * extension. This is what {@link SoroWillClient} uses when no `wallet` option
 * is supplied, so existing Freighter-based usage keeps working unchanged.
 */
export const freighterAdapter: WalletAdapter = {
  isConnected: () => defaultFreighterWalletAdapter.isConnected(),
  connect: () => defaultFreighterWalletAdapter.connect(),
  reconnect: () => defaultFreighterWalletAdapter.reconnect(),
  disconnect: () => defaultFreighterWalletAdapter.disconnect(),
  getPublicKey,
  signTransaction,
  getNetwork: () => defaultFreighterWalletAdapter.getNetwork(),
};
