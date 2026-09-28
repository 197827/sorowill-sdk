import { SignTransactionTimeoutError } from './errors';
import type { WalletAdapter, WalletConnection } from './wallet';

export interface WalletConnectSessionNamespace {
  accounts?: string[];
  chains?: string[];
  methods?: string[];
  events?: string[];
}

export interface WalletConnectSession {
  topic: string;
  namespaces?: Record<string, WalletConnectSessionNamespace>;
  sessionProperties?: Record<string, string>;
}

export interface WalletConnectConnectResult {
  uri?: string;
  approval(): Promise<WalletConnectSession>;
}

export interface WalletConnectClient {
  connect(options: {
    requiredNamespaces: Record<string, WalletConnectSessionNamespace>;
    optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
    pairingTopic?: string;
  }): Promise<WalletConnectConnectResult>;
  disconnect(options: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  getSession(topic: string): Promise<WalletConnectSession | null> | WalletConnectSession | null;
  request<T>(options: {
    topic: string;
    chainId: string;
    request: {
      method: string;
      params: unknown;
    };
  }): Promise<T>;
}

export interface WalletConnectSessionStore {
  getSessionTopic(): Promise<string | null> | string | null;
  setSessionTopic(topic: string): Promise<void> | void;
  clearSessionTopic(): Promise<void> | void;
}

export interface WalletConnectAdapterOptions {
  requiredNamespaces?: Record<string, WalletConnectSessionNamespace>;
  optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
  pairingTopic?: string;
  network?: string;
  networkPassphrase?: string;
  requestChainId?: string;
  /** Defaults to `stellar_signXDR`, per the WalletConnect Stellar namespace documentation. */
  signTransactionMethod?: string;
  /**
   * Builds the signing request params. Defaults to `{ xdr }`, per the WalletConnect
   * Stellar namespace documentation.
   */
  getSignTransactionParams?(transactionXdr: string, networkPassphrase: string): unknown;
  disconnectReason?: { code: number; message: string };
  sessionStore?: WalletConnectSessionStore;
  /**
   * Milliseconds to wait for the relay to return a signed transaction before
   * rejecting with {@link SignTransactionTimeoutError}. Defaults to 120000.
   * Used when the mobile wallet fails to respond — either backgrounded, inactive,
   * or experiencing relay message loss.
   */
  timeoutMs?: number;
  onPairingUri?(uri: string): void | Promise<void>;
  getPublicKeyFromSession?(session: WalletConnectSession): string;
  getNetworkFromSession?(session: WalletConnectSession): { network: string; networkPassphrase: string };
  getSignedTransactionXdr?(response: unknown): string;
}

const DEFAULT_REQUIRED_NAMESPACES: Record<string, WalletConnectSessionNamespace> = {
  stellar: {
    methods: ['stellar_signXDR'],
    chains: ['stellar:pubnet', 'stellar:testnet'],
    events: [],
  },
};

const DEFAULT_DISCONNECT_REASON = { code: 6000, message: 'Disconnected by client' };
const DEFAULT_SIGN_TIMEOUT_MS = 120_000;

function getFirstAccount(session: WalletConnectSession): string | undefined {
  const namespaces = session.namespaces ?? {};
  const stellarNamespace = namespaces['stellar'];
  if (stellarNamespace?.accounts?.[0]) {
    return stellarNamespace.accounts[0];
  }

  for (const namespace of Object.values(namespaces)) {
    const account = namespace.accounts?.[0];
    if (account) {
      return account;
    }
  }
  return undefined;
}

function getDefaultPublicKeyFromSession(session: WalletConnectSession): string {
  const account = getFirstAccount(session);
  if (!account) {
    throw new Error('WalletConnect session does not contain a Stellar account');
  }

  const parts = account.split(':');
  return parts[parts.length - 1] ?? account;
}

function getDefaultChainId(session: WalletConnectSession): string {
  const account = getFirstAccount(session);
  if (!account) {
    throw new Error('WalletConnect session does not contain a WalletConnect chain id');
  }

  const parts = account.split(':');
  if (parts.length >= 2) {
    return `${parts[0]}:${parts[1]}`;
  }

  throw new Error('WalletConnect account is not in namespace:chain:address format');
}

function getDefaultNetwork(session: WalletConnectSession): { network: string; networkPassphrase: string } {
  const chainId = getDefaultChainId(session);
  switch (chainId) {
    case 'stellar:testnet':
      return { network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' };
    case 'stellar:pubnet':
      return { network: 'mainnet', networkPassphrase: 'Public Global Stellar Network ; September 2015' };
    default:
      return {
        network: chainId,
        networkPassphrase: session.sessionProperties?.networkPassphrase ?? '',
      };
  }
}

function getDefaultSignedTransactionXdr(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (
    response &&
    typeof response === 'object' &&
    'signedXDR' in response &&
    typeof response.signedXDR === 'string'
  ) {
    return response.signedXDR;
  }

  if (
    response &&
    typeof response === 'object' &&
    'signedTxXdr' in response &&
    typeof response.signedTxXdr === 'string'
  ) {
    return response.signedTxXdr;
  }

  throw new Error('WalletConnect signing response did not include a signed transaction XDR');
}

export class MemoryWalletConnectSessionStore implements WalletConnectSessionStore {
  private sessionTopic: string | null = null;

  async getSessionTopic(): Promise<string | null> {
    return this.sessionTopic;
  }

  async setSessionTopic(topic: string): Promise<void> {
    this.sessionTopic = topic;
  }

  async clearSessionTopic(): Promise<void> {
    this.sessionTopic = null;
  }
}

export class LocalStorageWalletConnectSessionStore implements WalletConnectSessionStore {
  private readonly storage: Storage;
  private readonly key: string;

  constructor(storage: Storage, key = 'sorowill:walletconnect:session-topic') {
    this.storage = storage;
    this.key = key;
  }

  async getSessionTopic(): Promise<string | null> {
    return this.storage.getItem(this.key);
  }

  async setSessionTopic(topic: string): Promise<void> {
    this.storage.setItem(this.key, topic);
  }

  async clearSessionTopic(): Promise<void> {
    this.storage.removeItem(this.key);
  }
}

export class WalletConnectAdapter implements WalletAdapter {
  private readonly client: WalletConnectClient;
  private readonly options: WalletConnectAdapterOptions;
  private readonly sessionStore: WalletConnectSessionStore;
  private session: WalletConnectSession | null = null;
  private connection: WalletConnection | null = null;

  constructor(client: WalletConnectClient, options: WalletConnectAdapterOptions = {}) {
    this.client = client;
    this.options = options;
    this.sessionStore = options.sessionStore ?? new MemoryWalletConnectSessionStore();
  }

  async isConnected(): Promise<boolean> {
    if (this.session) {
      return true;
    }

    const topic = await this.sessionStore.getSessionTopic();
    if (!topic) {
      return false;
    }

    const session = await this.client.getSession(topic);
    return session !== null;
  }

  async connect(): Promise<WalletConnection> {
    const connectOptions: {
      requiredNamespaces: Record<string, WalletConnectSessionNamespace>;
      optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
      pairingTopic?: string;
    } = {
      requiredNamespaces: this.options.requiredNamespaces ?? DEFAULT_REQUIRED_NAMESPACES,
    };
    if (this.options.optionalNamespaces) {
      connectOptions.optionalNamespaces = this.options.optionalNamespaces;
    }
    if (this.options.pairingTopic) {
      connectOptions.pairingTopic = this.options.pairingTopic;
    }

    const connection = await this.client.connect(connectOptions);

    if (connection.uri) {
      await this.options.onPairingUri?.(connection.uri);
    }

    const session = await connection.approval();
    return this.useSession(session);
  }

  async reconnect(): Promise<WalletConnection> {
    if (this.session && this.connection) {
      const freshSession = await this.client.getSession(this.session.topic);
      if (freshSession) {
        return this.useSession(freshSession);
      }
      this.session = null;
      this.connection = null;
      await this.sessionStore.clearSessionTopic();
    }

    const topic = await this.sessionStore.getSessionTopic();
    if (!topic) {
      throw new Error('No WalletConnect session topic is stored');
    }

    const session = await this.client.getSession(topic);
    if (!session) {
      await this.sessionStore.clearSessionTopic();
      throw new Error('Stored WalletConnect session no longer exists');
    }

    return this.useSession(session);
  }

  async disconnect(): Promise<void> {
    try {
      if (this.session) {
        await this.client.disconnect({
          topic: this.session.topic,
          reason: this.options.disconnectReason ?? DEFAULT_DISCONNECT_REASON,
        });
      }
    } finally {
      this.session = null;
      this.connection = null;
      await this.sessionStore.clearSessionTopic();
    }
  }

  async getPublicKey(): Promise<string> {
    const connection = this.connection ?? (await this.reconnect());
    return connection.publicKey;
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const connection = this.connection ?? (await this.reconnect());
    return { network: connection.network, networkPassphrase: connection.networkPassphrase };
  }

  async signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string> {
    if (!this.session) {
      await this.reconnect();
    }
    const session = this.session;
    if (!session) {
      throw new Error('WalletConnect session is not available');
    }

    const sessionNetwork = this.resolveNetwork(session);
    if (opts.networkPassphrase !== sessionNetwork.networkPassphrase) {
      throw new Error(
        `WalletConnect session is connected to ${sessionNetwork.network} (${sessionNetwork.networkPassphrase}) but transaction is for a different network (${opts.networkPassphrase})`,
      );
    }

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new SignTransactionTimeoutError(timeoutMs)),
        timeoutMs,
      );
    });

    try {
      const response = await Promise.race([
        this.client.request({
          topic: session.topic,
          chainId: this.options.requestChainId ?? getDefaultChainId(session),
          request: {
            method: this.options.signTransactionMethod ?? 'stellar_signXDR',
            params: this.options.getSignTransactionParams
              ? this.options.getSignTransactionParams(transactionXdr, opts.networkPassphrase)
              : { xdr: transactionXdr },
          },
        }),
        timeoutPromise,
      ]);

      return (this.options.getSignedTransactionXdr ?? getDefaultSignedTransactionXdr)(response);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }

  private async useSession(session: WalletConnectSession): Promise<WalletConnection> {
    this.session = session;
    await this.sessionStore.setSessionTopic(session.topic);

    const connection = this.buildConnection(session);
    this.connection = connection;
    return connection;
  }

  private buildConnection(session: WalletConnectSession): WalletConnection {
    const publicKey = (this.options.getPublicKeyFromSession ?? getDefaultPublicKeyFromSession)(session);
    const network = this.resolveNetwork(session);

    return {
      publicKey,
      network: network.network,
      networkPassphrase: network.networkPassphrase,
    };
  }

  private resolveNetwork(session: WalletConnectSession): { network: string; networkPassphrase: string } {
    return (
      this.options.getNetworkFromSession?.(session) ?? {
        network: this.options.network ?? getDefaultNetwork(session).network,
        networkPassphrase:
          this.options.networkPassphrase ?? getDefaultNetwork(session).networkPassphrase,
      }
    );
  }
}
