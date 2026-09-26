import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { MemoryCachePersistenceAdapter } from '../src/cache';
import { RequestTimeoutError, SoroWillError, WalletNetworkMismatchError } from '../src/errors';
import { ReadCache } from '../src/cache';
import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import type { WillEvent, WillEventSource } from '../src/events';
import { WillStatus } from '../src/types';
import type { WalletAdapter, WalletConnection } from '../src/wallet';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();

interface RawWillShape {
  id: bigint;
  owner: string;
  token: string;
  balance: bigint;
  beneficiaries: Array<{ address: string; percentage: number }>;
  checkin_period_days: bigint;
  grace_period_days: bigint;
  last_checkin: bigint;
  trigger_time: bigint | undefined;
  status: WillStatus;
  guardians: string[];
  guardian_votes: number;
}

function makeRawWill(id: bigint): RawWillShape {
  return {
    id,
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };
}

class StubWalletAdapter implements WalletAdapter {
  async isConnected(): Promise<boolean> {
    return true;
  }

  async connect(): Promise<WalletConnection> {
    return {
      publicKey: TEST_ACCOUNT,
      network: 'testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
    };
  }

  async reconnect(): Promise<WalletConnection> {
    return await this.connect();
  }

  async disconnect(): Promise<void> {
    return;
  }

  async getPublicKey(): Promise<string> {
    return TEST_ACCOUNT;
  }

  async signTransaction(transactionXdr: string, _opts: { networkPassphrase: string }): Promise<string> {
    return transactionXdr;
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const connection = await this.connect();
    return { network: connection.network, networkPassphrase: connection.networkPassphrase };
  }
}

class StubEventSource implements WillEventSource {
  private listener: ((event: WillEvent) => void) | null = null;

  subscribe(listener: (event: WillEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: WillEvent): void {
    this.listener?.(event);
  }
}

function createSpec(results: Record<string, unknown[]>) {
  return {
    funcArgsToScVals(_method: string, _args: Record<string, unknown>): xdr.ScVal[] {
      return [];
    },
    funcResToNative(method: string, _value: xdr.ScVal): unknown {
      const queue = results[method];
      if (!queue || queue.length === 0) {
        throw new Error(`No stub result queued for ${method}`);
      }
      return queue.shift();
    },
  };
}

function createRpcServer(options: {
  simulateTransactionImpl?: () => Promise<unknown>;
  pollTransactionImpl?: () => Promise<unknown>;
  sendTransactionImpl?: () => Promise<unknown>;
  getFeeStatsImpl?: () => Promise<unknown>;
} = {}): SoroWillRpcServer {
  return {
    async getContractWasmByContractId(_contractId: string): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async simulateTransaction(_transaction) {
      if (options.simulateTransactionImpl) {
        return (await options.simulateTransactionImpl()) as never;
      }
      return {
        result: {
          retval: VOID_SCVAL,
        },
      } as never;
    },
    async getAccount(_address: string): Promise<Account> {
      return new Account(TEST_ACCOUNT, '1');
    },
    async prepareTransaction(transaction) {
      return transaction;
    },
    async sendTransaction(_transaction) {
      if (options.sendTransactionImpl) {
        return (await options.sendTransactionImpl()) as never;
      }
      return {
        status: 'PENDING',
        hash: 'abc123',
      } as never;
    },
    async pollTransaction(_hash: string, _options: { attempts: number }) {
      if (options.pollTransactionImpl) {
        return (await options.pollTransactionImpl()) as never;
      }
      return {
        status: 'SUCCESS',
        createdAt: 1_700_000_000,
        returnValue: VOID_SCVAL,
      } as never;
    },
    async getFeeStats() {
      if (options.getFeeStatsImpl) {
        return (await options.getFeeStatsImpl()) as never;
      }
      return {
        sorobanInclusionFee: { max: '100', min: '100', mode: '100', p10: '100', p20: '100', p30: '100', p40: '100', p50: '100', p60: '100', p70: '100', p80: '100', p90: '100', p95: '100', p99: '100', transactionCount: '0', ledgerCount: 0 },
        inclusionFee: { max: '100', min: '100', mode: '100', p10: '100', p20: '100', p30: '100', p40: '100', p50: '100', p60: '100', p70: '100', p80: '100', p90: '100', p95: '100', p99: '100', transactionCount: '0', ledgerCount: 0 },
        latestLedger: 12345,
      } as never;
    },
  };
}

describe('SoroWillClient.getNetworkFeeStats', () => {
  it('passes through the RPC server fee-stats response', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      readCache: false,
      spec: createSpec({}),
      rpcServer: createRpcServer({
        async getFeeStatsImpl() {
          return {
            sorobanInclusionFee: { max: '5000', min: '100', mode: '150' },
            inclusionFee: { max: '400', min: '100', mode: '100' },
            latestLedger: 999,
          };
        },
      }),
    });

    const stats = (await client.getNetworkFeeStats()) as {
      latestLedger: number;
      sorobanInclusionFee: { max: string };
    };
    expect(stats.latestLedger).toBe(999);
    expect(stats.sorobanInclusionFee.max).toBe('5000');
  });
});

describe('SoroWillClient read cache persistence', () => {
  it('rehydrates persisted getWill results after a new client instance is created', async () => {
    const persistence = new MemoryCachePersistenceAdapter();
    let simulateCalls = 0;

    const clientA = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: new StubWalletAdapter(),
      readCache: { ttlMs: 60_000, persistence },
      spec: createSpec({ get_will: [makeRawWill(1n)] }),
      rpcServer: createRpcServer({
        async simulateTransactionImpl() {
          simulateCalls += 1;
          return { result: { retval: VOID_SCVAL } };
        },
      }),
    });

    // First read: populates the persistent cache.
    await clientA.getWill('1');
    expect(simulateCalls).toBe(1);

    const clientB = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: new StubWalletAdapter(),
      readCache: { ttlMs: 60_000, persistence },
      spec: createSpec({ get_will: [makeRawWill(999n)] }),
      rpcServer: createRpcServer({
        async simulateTransactionImpl() {
          simulateCalls += 1;
          return { result: { retval: VOID_SCVAL } };
        },
      }),
    });

    const secondRead = await clientB.getWill('1');
    expect(secondRead.id).toBe('1');
    // RPC must still be 1 — clientB served the result from the shared persistence.
    expect(simulateCalls).toBe(1);
  });
});

describe('SoroWillClient read cache', () => {
  it('caches getWill results within the TTL window', async () => {
    const cache = new ReadCache({ ttlMs: 60_000 });

    cache.set('key1', { id: 'cached' });
    expect(await cache.get('key1')).toEqual({ id: 'cached' });

    cache.clear();
    expect(await cache.get('key1')).toBeUndefined();
  });
});

describe('SoroWillClient event-driven invalidation', () => {
  it('invalidates a cached will when a matching event is received', async () => {
    const events = new StubEventSource();
    let simulateCalls = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: new StubWalletAdapter(),
      readCache: { ttlMs: 60_000 },
      eventSource: events,
      spec: createSpec({ get_will: [makeRawWill(1n), makeRawWill(1n)] }),
      rpcServer: createRpcServer({
        async simulateTransactionImpl() {
          simulateCalls += 1;
          return { result: { retval: VOID_SCVAL } };
        },
      }),
    });

    await client.getWill('1');
    await client.getWill('1');
    expect(simulateCalls).toBe(1);

    events.emit({ type: 'will.updated', willId: '1' });

    await client.getWill('1');
    expect(simulateCalls).toBe(2);
  });
});

describe('SoroWillClient RPC retries', () => {
  it('retries a transient simulateTransaction failure and then succeeds', async () => {
    let attempts = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: new StubWalletAdapter(),
      readCache: false,
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 },
      spec: createSpec({ get_will: [makeRawWill(1n)] }),
      rpcServer: createRpcServer({
        async simulateTransactionImpl() {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('temporary rpc outage');
          }
          return { result: { retval: VOID_SCVAL } };
        },
      }),
    });

    const will = await client.getWill('1');
    expect(will.id).toBe('1');
    expect(attempts).toBe(2);
  });

  it('throws after the configured retry budget is exhausted', async () => {
    let attempts = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: new StubWalletAdapter(),
      readCache: false,
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
      spec: createSpec({ get_will: [makeRawWill(1n), makeRawWill(1n)] }),
      rpcServer: createRpcServer({
        async simulateTransactionImpl() {
          attempts += 1;
          throw new Error('still failing');
        },
      }),
    });

    await expect(client.getWill('1')).rejects.toThrow(/failed after 2 attempts/i);
    expect(attempts).toBe(2);
  });
});

describe('SoroWillClient wallet network cross-check', () => {
  it('throws WalletNetworkMismatchError before signing when the wallet is on a different network', async () => {
    let sendTransactionCalls = 0;
    const wallet: WalletAdapter = {
      async isConnected() {
        return true;
      },
      async connect() {
        return { publicKey: TEST_ACCOUNT, network: 'mainnet', networkPassphrase: 'Public Global Stellar Network ; September 2015' };
      },
      async reconnect() {
        return { publicKey: TEST_ACCOUNT, network: 'mainnet', networkPassphrase: 'Public Global Stellar Network ; September 2015' };
      },
      async disconnect() {},
      async getPublicKey() {
        return TEST_ACCOUNT;
      },
      async signTransaction(transactionXdr: string) {
        return transactionXdr;
      },
      async getNetwork() {
        return { network: 'mainnet', networkPassphrase: 'Public Global Stellar Network ; September 2015' };
      },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet,
      readCache: false,
      spec: createSpec({}),
      rpcServer: createRpcServer({
        async sendTransactionImpl() {
          sendTransactionCalls += 1;
          return { status: 'PENDING', hash: 'abc123' };
        },
      }),
    });

    await expect(client.triggerWill('1')).rejects.toBeInstanceOf(WalletNetworkMismatchError);
    expect(sendTransactionCalls).toBe(0);
  });

  it('does not throw when the wallet is on the matching network', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: new StubWalletAdapter(),
      readCache: false,
      spec: createSpec({}),
      rpcServer: createRpcServer(),
    });

    await expect(client.triggerWill('1')).resolves.toEqual({ txHash: 'abc123' });
  });

  it('skips the check for adapters that cannot report their network', async () => {
    const minimalWallet: WalletAdapter = {
      async isConnected() {
        return true;
      },
      async connect() {
        return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' };
      },
      async reconnect() {
        return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' };
      },
      async disconnect() {},
      async getPublicKey() {
        return TEST_ACCOUNT;
      },
      async signTransaction(transactionXdr: string) {
        return transactionXdr;
      },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: minimalWallet,
      readCache: false,
      spec: createSpec({}),
      rpcServer: createRpcServer(),
    });

    await expect(client.triggerWill('1')).resolves.toEqual({ txHash: 'abc123' });
  });

  it('assertWalletNetwork throws on mismatch and passes on match', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: new StubWalletAdapter(),
      readCache: false,
      spec: createSpec({}),
      rpcServer: createRpcServer(),
    });

    await expect(
      client.assertWalletNetwork({ networkPassphrase: 'Public Global Stellar Network ; September 2015' }),
    ).rejects.toBeInstanceOf(WalletNetworkMismatchError);
    await expect(
      client.assertWalletNetwork({ networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).resolves.toBeUndefined();
  });
});

const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

describe('SoroWillClient.getNetworkFeeStats receiver and support (#363)', () => {
  it('invokes getFeeStats with its server as the receiver', async () => {
    const rpcServer = createRpcServer();
    const receiverAwareServer = Object.assign(Object.create(null), rpcServer, {
      latestLedger: 4242,
      async getFeeStats(this: { latestLedger: number }) {
        return { latestLedger: this.latestLedger } as never;
      },
    }) as SoroWillRpcServer;
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      readCache: false,
      spec: createSpec({}),
      rpcServer: receiverAwareServer,
    });

    const stats = await client.getNetworkFeeStats();
    expect(stats.latestLedger).toBe(4242);
  });

  it('throws a SoroWillError when the server does not support getFeeStats', async () => {
    const rpcServer = createRpcServer();
    delete (rpcServer as { getFeeStats?: unknown }).getFeeStats;
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      readCache: false,
      spec: createSpec({}),
      rpcServer,
    });

    await expect(client.getNetworkFeeStats()).rejects.toBeInstanceOf(SoroWillError);
  });
});

describe('SoroWillClient read error propagation (#365)', () => {
  it('propagates RequestTimeoutError unchanged from reads', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      readCache: false,
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 },
      timeoutMs: 10,
      spec: createSpec({ get_will: [makeRawWill(1n)] }),
      rpcServer: createRpcServer({
        simulateTransactionImpl: () => new Promise(() => undefined),
      }),
    });

    await expect(client.getWill('1')).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('propagates AbortError unchanged from reads', async () => {
    const controller = new AbortController();
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      readCache: false,
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 },
      spec: createSpec({ get_will: [makeRawWill(1n)] }),
      rpcServer: createRpcServer(),
    });
    controller.abort();

    const error = await client.getWill('1', { signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('SoroWillClient constructor option validation (#366)', () => {
  const base = { network: 'testnet' as const, contractId: CONTRACT_ID, readCache: false as const };

  it.each([0, -1, 1.5, Number.NaN])('rejects retry.maxAttempts = %s', (maxAttempts) => {
    expect(() => new SoroWillClient({ ...base, retry: { maxAttempts } })).toThrow(RangeError);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects retry delays = %s', (delay) => {
    expect(() => new SoroWillClient({ ...base, retry: { initialDelayMs: delay } })).toThrow(RangeError);
    expect(() => new SoroWillClient({ ...base, retry: { maxDelayMs: delay } })).toThrow(RangeError);
  });

  it.each([0.5, 0, Number.NaN])('rejects retry.backoffFactor = %s', (backoffFactor) => {
    expect(() => new SoroWillClient({ ...base, retry: { backoffFactor } })).toThrow(RangeError);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects transactionTimeoutSeconds = %s',
    (transactionTimeoutSeconds) => {
      expect(() => new SoroWillClient({ ...base, transactionTimeoutSeconds })).toThrow(RangeError);
    },
  );

  it.each([0, -1, Number.NaN])('rejects defaultPollIntervalMs = %s', (defaultPollIntervalMs) => {
    expect(() => new SoroWillClient({ ...base, defaultPollIntervalMs })).toThrow(RangeError);
  });
});

describe('SoroWillClient write-path failover (#367)', () => {
  it('fails over to the backup endpoint for getAccount and prepareTransaction', async () => {
    const calls = { getAccount: 0, prepareTransaction: 0 };
    const rpcServer = createRpcServer();
    const baseGetAccount = rpcServer.getAccount.bind(rpcServer);
    const basePrepare = rpcServer.prepareTransaction.bind(rpcServer);
    rpcServer.getAccount = async (address) => {
      calls.getAccount += 1;
      if (calls.getAccount === 1) throw new Error('fetch failed');
      return baseGetAccount(address);
    };
    rpcServer.prepareTransaction = async (tx) => {
      calls.prepareTransaction += 1;
      if (calls.prepareTransaction === 1) throw new Error('ECONNREFUSED');
      return basePrepare(tx);
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcUrls: ['https://primary.example', 'https://backup.example'],
      wallet: new StubWalletAdapter(),
      readCache: false,
      spec: createSpec({ get_will: [makeRawWill(1n)], check_in: [undefined] }),
      rpcServer,
    });

    await expect(client.checkIn('1')).resolves.toMatchObject({ txHash: 'abc123' });
    expect(calls).toEqual({ getAccount: 2, prepareTransaction: 2 });
  });
});
