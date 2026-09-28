import type { SignTransactionOptions, WalletAdapter, WalletConnection } from './types';

/** Minimal API implemented by injected Stellar wallet providers. */
export interface InjectedWalletProvider {
  connect(): Promise<WalletConnection>;
  disconnect?(): Promise<void>;
  isConnected?(): Promise<boolean>;
  getPublicKey?(): Promise<string>;
  signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string | { signedTxXdr: string }>;
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

/** Shared implementation for browser-injected wallet adapters. */
export abstract class InjectedWalletAdapter implements WalletAdapter {
  abstract readonly id: string;
  abstract readonly name: string;

  private connection: WalletConnection | null = null;

  protected constructor(private readonly provider: InjectedWalletProvider) {}

  async connect(): Promise<WalletConnection> {
    this.connection = await this.provider.connect();
    return this.connection;
  }

  /**
   * Restores an existing provider connection without prompting when possible,
   * falling back to {@link connect} only when no connection can be resumed.
   */
  async reconnect(): Promise<WalletConnection> {
    if (this.connection && (await this.isConnected())) {
      return this.connection;
    }
    const { isConnected, getPublicKey, getNetwork } = this.provider;
    if (isConnected && getPublicKey && getNetwork && (await isConnected.call(this.provider))) {
      const [publicKey, network] = await Promise.all([
        getPublicKey.call(this.provider),
        getNetwork.call(this.provider),
      ]);
      this.connection = { publicKey, ...network };
      return this.connection;
    }
    return this.connect();
  }

  async disconnect(): Promise<void> {
    await this.provider.disconnect?.();
    this.connection = null;
  }

  async isConnected(): Promise<boolean> {
    if (this.provider.isConnected) {
      return this.provider.isConnected();
    }
    if (this.connection && this.provider.getPublicKey) {
      try {
        await this.provider.getPublicKey();
      } catch {
        this.connection = null;
      }
    }
    return this.connection !== null;
  }

  async getPublicKey(): Promise<string> {
    if (this.provider.getPublicKey) {
      return this.provider.getPublicKey();
    }
    if (!this.connection) {
      throw new Error(`${this.name} is not connected. Call connect() first.`);
    }
    return this.connection.publicKey;
  }

  async signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string> {
    if (!this.connection) {
      throw new Error(`${this.name} is not connected. Call connect() first.`);
    }
    const result = await this.provider.signTransaction(transactionXdr, options);
    return typeof result === 'string' ? result : result.signedTxXdr;
  }

  async getNetwork?(): Promise<{ network: string; networkPassphrase: string }> {
    if (this.provider.getNetwork) {
      return this.provider.getNetwork();
    }
    if (!this.connection) {
      throw new Error(`${this.name} is not connected. Call connect() first.`);
    }
    return {
      network: this.connection.network,
      networkPassphrase: this.connection.networkPassphrase,
    };
  }
}
