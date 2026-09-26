// Tests for SoroWillClient.forNetwork() — issue #117
// Tests for cancelWill refundAmount correctness — issue #118

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

import { SoroWillClient, DEFAULT_CONTRACT_IDS } from '../src/SoroWillClient';
import { WillStatus } from '../src/types';

// ---------------------------------------------------------------------------
// Issue #117 — SoroWillClient.forNetwork()
// ---------------------------------------------------------------------------

describe('SoroWillClient.forNetwork()', () => {
  it('constructs a testnet client using the default contract id', () => {
    const client = SoroWillClient.forNetwork('testnet');
    expect(client).toBeInstanceOf(SoroWillClient);
    // Verify the default contract id was used by inspecting the internal
    // contract object.
    const contractId = (client as unknown as { contract: { contractId: () => string } }).contract.contractId();
    expect(contractId).toBe(DEFAULT_CONTRACT_IDS.testnet);
  });

  it('accepts an explicit contractId override that supersedes the default', () => {
    const overrideId = 'CCUFS2KK3DXQRGN3EG6OJ55PQ3BXJV3TSEL5MNXLMZWDFHX5DTUUI66M';
    const client = SoroWillClient.forNetwork('testnet', { contractId: overrideId });
    expect(client).toBeInstanceOf(SoroWillClient);
    const contractId = (client as unknown as { contract: { contractId: () => string } }).contract.contractId();
    expect(contractId).toBe(overrideId);
  });

  it('passes additional overrides (e.g. timeoutMs) through to the constructor', () => {
    const client = SoroWillClient.forNetwork('testnet', { timeoutMs: 5_000 });
    expect(client).toBeInstanceOf(SoroWillClient);
    expect((client as unknown as { timeoutMs: number }).timeoutMs).toBe(5_000);
  });

  it('throws when mainnet has no default contract id and no override is provided', () => {
    // Temporarily clear the mainnet default to simulate a not-yet-deployed state.
    const originalMainnet = DEFAULT_CONTRACT_IDS.mainnet;
    DEFAULT_CONTRACT_IDS.mainnet = '';
    try {
      expect(() => SoroWillClient.forNetwork('mainnet')).toThrow(
        /No default contract address is available for network "mainnet"/,
      );
    } finally {
      DEFAULT_CONTRACT_IDS.mainnet = originalMainnet;
    }
  });

  it('succeeds on mainnet when contractId is supplied via overrides', () => {
    const mainnetId = 'CAQDVPJ6ZAZVI5WNJL4PBOBP232HCXMCEOHQXM5HH22LY25S4QJASHNZ';
    const client = SoroWillClient.forNetwork('mainnet', { contractId: mainnetId });
    expect(client).toBeInstanceOf(SoroWillClient);
    const contractId = (client as unknown as { contract: { contractId: () => string } }).contract.contractId();
    expect(contractId).toBe(mainnetId);
  });
});

// ---------------------------------------------------------------------------
// Issue #118 — cancelWill refundAmount correctness
// ---------------------------------------------------------------------------

describe('cancelWill refundAmount correctness', () => {
  /**
   * Helper that builds a minimal fake will payload matching the RawWill shape
   * expected by mapWill().
   */
  function rawWill(balance: bigint) {
    return {
      id: 1n,
      owner: 'GOWNER',
      token: 'CTOKEN',
      balance,
      beneficiaries: [{ address: 'GBEN', percentage: 100 }],
      checkin_period_days: 90n,
      grace_period_days: 7n,
      last_checkin: 1_700_000_000n,
      trigger_time: undefined as bigint | undefined,
      status: WillStatus.Active,
      guardians: [] as string[],
      guardian_votes: 0,
    };
  }

  it('returns refundAmount equal to the will balance when the contract returns it directly', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });

    const balanceAtCallTime = 5_000_000n;

    // Spec that decodes cancel_will to return the on-chain balance as a bigint.
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
      funcResToNative: (method: string, value: unknown) => {
        if (method === 'cancel_will') return balanceAtCallTime;
        return value;
      },
    };

    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => transaction,
      sendTransaction: async () => ({ status: 'PENDING' as const, hash: 'cancel-hash' }),
      pollTransaction: async () => ({
        status: 'SUCCESS' as const,
        createdAt: 1_700_000_000,
        // Simulate the contract returning the refunded balance as a ScVal.
        // cancelWill decodes this via funcResToNative so any truthy value works
        // here — the fakeSpec above drives the actual decoded value.
        returnValue: xdr.ScVal.scvVoid(),
      }),
    };

    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });
    Object.defineProperty(client, 'server', { value: fakeServer });
    // Write-path RPC calls go through the failover pool, so route it to the fake too.
    Object.defineProperty(client, 'rpcPool', {
      value: { withFailover: <T>(op: (server: typeof fakeServer) => Promise<T>) => op(fakeServer) },
    });

    const { txHash, refundAmount } = await client.cancelWill('1');

    expect(txHash).toBe('cancel-hash');
    // The refundAmount must equal the balance the contract reports, not some
    // stale or hardcoded value.
    expect(refundAmount).toBe(balanceAtCallTime.toString());
  });

  it('falls back to getWill balance when the contract returns no value (older contract versions)', async () => {
    const balanceFromRead = 3_000_000n;

    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
      funcResToNative: (_method: string, value: unknown) => value,
    };

    let simulateCallCount = 0;
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => transaction,
      sendTransaction: async () => ({ status: 'PENDING' as const, hash: 'fallback-hash' }),
      pollTransaction: async () => ({
        status: 'SUCCESS' as const,
        createdAt: 1_700_000_000,
        // No returnValue — triggers the fallback path in cancelWill.
        returnValue: undefined as unknown as xdr.ScVal,
      }),
      simulateTransaction: async () => {
        simulateCallCount += 1;
        // Return a raw will shape so getWill() can decode the balance.
        return { result: { retval: rawWill(balanceFromRead) } };
      },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as never,
    });
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });

    const { txHash, refundAmount } = await client.cancelWill('1');

    expect(txHash).toBe('fallback-hash');
    // The fallback reads the will balance via getWill() and returns that.
    expect(refundAmount).toBe(balanceFromRead.toString());
    // getWill() must have been called exactly once to obtain the balance.
    expect(simulateCallCount).toBe(1);
  });

  /**
   * Known limitation — documented as required by issue #118:
   *
   * The fallback path in cancelWill (for older contract versions that don't
   * return the balance directly) calls getWill() *after* the cancel
   * transaction is submitted. If a concurrent topUp lands between the
   * getWill() read and the cancel transaction, the balance returned by
   * getWill() may already reflect the top-up amount, making refundAmount
   * *larger* than what was actually refunded on-chain.
   *
   * The primary path (contract returns the balance via returnValue) is not
   * affected because it uses the value the contract itself reports at the
   * moment the cancel executes.
   */
  it('documents the theoretical race between a concurrent topUp and the fallback read', () => {
    // This test is intentionally descriptive — the race cannot be reproduced
    // deterministically in a unit test because it requires two concurrent
    // on-chain operations. Its presence in the suite serves as a permanent
    // record that the limitation is known and accepted.
    expect(true).toBe(true);
  });
});
