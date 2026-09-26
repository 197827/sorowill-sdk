import { Account, Transaction, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/wallet', () => ({
  freighterAdapter: {
    getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
    signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
  },
  getDefaultWalletAdapter: vi.fn(() => ({
    getPublicKey: async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    signTransaction: async (transactionXdr: string) => transactionXdr,
    isConnected: async () => true,
    connect: async () => ({ publicKey: 'GAAA', network: 'TESTNET', networkPassphrase: 'pass' }),
    reconnect: async () => ({ publicKey: 'GAAA', network: 'TESTNET', networkPassphrase: 'pass' }),
    disconnect: async () => undefined,
  })),
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
}));

import { SoroWillClient } from '../src/SoroWillClient';
import {
  mapContractError,
  NotOwnerError,
  RequestTimeoutError,
  UnsupportedBatchSizeError,
} from '../src/errors';
import { HookManager } from '../src/hooks';
import { RequestQueue } from '../src/requestQueue';

describe('RequestQueue', () => {
  it('applies backpressure to a burst of requests', async () => {
    const queue = new RequestQueue({ maxConcurrent: 2, requestsPerSecond: 100 });
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const burst = Array.from({ length: 6 }, (_, value) =>
      queue.enqueue(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return value;
      }),
    );

    await Promise.resolve();
    expect(peak).toBe(2);
    release?.();
    await expect(Promise.all(burst)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('rejects a hung request with the typed timeout error', async () => {
    const queue = new RequestQueue();
    const hung = queue.enqueue(() => new Promise<never>(() => undefined), 5);
    await expect(hung).rejects.toBeInstanceOf(RequestTimeoutError);
  });
});

describe('contract error mapping', () => {
  it('maps a Soroban contract code to its typed exception', () => {
    expect(mapContractError(new Error('HostError: Error(Contract, #2)'))).toBeInstanceOf(
      NotOwnerError,
    );
  });
});

describe('batch transactions', () => {
  it('prepares, signs, and submits a single operation as one transaction', async () => {
    let preparedOperationCount = 0;
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => {
        preparedOperationCount = transaction.operations.length;
        return transaction;
      },
      sendTransaction: async () => ({ status: 'PENDING', hash: 'batch-hash' }),
      pollTransaction: async () => ({
        status: 'SUCCESS',
        createdAt: 1_700_000_000,
        returnValue: xdr.ScVal.scvVoid(),
      }),
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as never,
    });
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    await expect(client.batch([{ method: 'first_operation', args: {} }])).resolves.toEqual({
      txHash: 'batch-hash',
      createdAt: 1_700_000_000,
    });
    expect(preparedOperationCount).toBe(1);
  });

  it('rejects batches with more than one operation, since Soroban allows one invocation per transaction', async () => {
    const getAccount = vi.fn();
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: { getAccount } as never,
    });

    await expect(
      client.batch([
        { method: 'first_operation', args: {} },
        { method: 'second_operation', args: {} },
      ]),
    ).rejects.toThrow(UnsupportedBatchSizeError);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('runs invoke hooks for the operation', async () => {
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => transaction,
      sendTransaction: async () => ({ status: 'PENDING', hash: 'batch-hash' }),
      pollTransaction: async () => ({
        status: 'SUCCESS',
        createdAt: 1_700_000_000,
        returnValue: xdr.ScVal.scvVoid(),
      }),
    };
    const hooks = new HookManager();
    const beforeMethods: string[] = [];
    const afterResults: Array<{ method: string; txHash: string | null; error: string | null }> = [];
    hooks.onBeforeInvoke(({ method }) => {
      beforeMethods.push(method);
    });
    hooks.onAfterInvoke(({ method, txHash, error }) => {
      afterResults.push({ method, txHash, error });
    });
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      hooks,
      rpcServer: fakeServer as never,
    });
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    await client.batch([{ method: 'first_operation', args: { value: 1 } }]);

    expect(beforeMethods).toEqual(['first_operation']);
    expect(afterResults).toEqual([{ method: 'first_operation', txHash: 'batch-hash', error: null }]);
  });
});

describe('mapWill trigger_time decoding', () => {
  // mapWill is exercised through getWill/getWillsByOwner which call it internally.
  // We use the same fakeSpec + fakeServer pattern to control the raw return value.

  it('maps trigger_time: undefined to triggerTime: null', async () => {
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
      funcResToNative: (_method: string, value: unknown) => value,
    };
    const fakeServer = {
      simulateTransaction: async () => ({
        result: {
          retval: {
            id: 1n,
            owner: 'GOWNER',
            token: 'CTOKEN',
            balance: 1000n,
            beneficiaries: [{ address: 'GBEN', percentage: 100 }],
            checkin_period_days: 90n,
            grace_period_days: 7n,
            last_checkin: 1_700_000_000n,
            trigger_time: undefined,
            status: 'Active',
            guardians: [] as string[],
            guardian_votes: 0,
          },
        },
      }),
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as never,
    });
    // Override specPromise to skip wasm fetch (which requires a real binary).
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    const will = await client.getWill('1');
    expect(will.triggerTime).toBeNull();
  });

  it('maps trigger_time set to a correct Date', async () => {
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
      funcResToNative: (_method: string, value: unknown) => value,
    };
    const fakeServer = {
      simulateTransaction: async () => ({
        result: {
          retval: {
            id: 1n,
            owner: 'GOWNER',
            token: 'CTOKEN',
            balance: 1000n,
            beneficiaries: [{ address: 'GBEN', percentage: 100 }],
            checkin_period_days: 90n,
            grace_period_days: 7n,
            last_checkin: 1_700_000_000n,
            trigger_time: 1_800_000_000n,
            status: 'Active',
            guardians: [] as string[],
            guardian_votes: 0,
          },
        },
      }),
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as never,
    });
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    const will = await client.getWill('1');
    expect(will.triggerTime).toBeInstanceOf(Date);
    expect(will.triggerTime!.getTime()).toBe(1_800_000_000 * 1000);
  });
});

describe('sendTransaction status handling', () => {
  it('throws a distinct error for TRY_AGAIN_LATER status', async () => {
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => transaction,
      sendTransaction: async () => ({ status: 'TRY_AGAIN_LATER' as const, hash: 'retry-hash' }),
      pollTransaction: async () => {
        throw new Error('should not reach poll');
      },
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as never,
    });
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    await expect(
      client.batch([{ method: 'dummy', args: {} }]),
    ).rejects.toThrow(/backpressure/);
  });

  it('proceeds to poll on DUPLICATE status', async () => {
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };
    let pollCalled = false;
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => transaction,
      sendTransaction: async () => ({ status: 'DUPLICATE' as const, hash: 'dup-hash' }),
      pollTransaction: async () => {
        pollCalled = true;
        return {
          status: 'SUCCESS' as const,
          createdAt: 1_700_000_000,
          returnValue: xdr.ScVal.scvVoid(),
        };
      },
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as never,
    });
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    await expect(
      client.batch([{ method: 'dummy', args: {} }]),
    ).resolves.toEqual({ txHash: 'dup-hash', createdAt: 1_700_000_000 });
    expect(pollCalled).toBe(true);
  });

  it('throws on ERROR status without polling', async () => {
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };
    let pollCalled = false;
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => transaction,
      sendTransaction: async () => ({ status: 'ERROR' as const, hash: '' }),
      pollTransaction: async () => {
        pollCalled = true;
        return { status: 'SUCCESS' as const, createdAt: 0, returnValue: xdr.ScVal.scvVoid() };
      },
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as never,
    });
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    await expect(
      client.batch([{ method: 'dummy', args: {} }]),
    ).rejects.toThrow(/submission failed/);
    expect(pollCalled).toBe(false);
  });
});

describe('pollAttempts option', () => {
  it('uses the configured pollAttempts value', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      pollAttempts: 7,
    });
    expect((client as unknown as { pollAttempts: number }).pollAttempts).toBe(7);
  });

  it('defaults pollAttempts to 30 when not configured', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });
    expect((client as unknown as { pollAttempts: number }).pollAttempts).toBe(30);
  });

  it('passes custom pollAttempts to pollTransaction', async () => {
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };
    let receivedAttempts = 0;
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => transaction,
      sendTransaction: async () => ({ status: 'PENDING' as const, hash: 'h' }),
      pollTransaction: async (_hash: string, options: { attempts: number }) => {
        receivedAttempts = options.attempts;
        return {
          status: 'SUCCESS' as const,
          createdAt: 1_700_000_000,
          returnValue: xdr.ScVal.scvVoid(),
        };
      },
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      pollAttempts: 99,
      rpcServer: fakeServer as never,
    });
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    await client.batch([{ method: 'dummy', args: {} }]);
    expect(receivedAttempts).toBe(99);
  });

  it('throws when pollAttempts is zero', async () => {
    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        pollAttempts: 0,
      });
    }).toThrow(/pollAttempts/);
  });

  it('throws when pollAttempts is negative', async () => {
    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        pollAttempts: -1,
      });
    }).toThrow(/pollAttempts/);
  });
});
