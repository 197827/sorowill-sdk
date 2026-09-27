export interface BuildSep7TxUriOptions {
  callbackUrl: string;
  message?: string;
  networkPassphrase?: string;
  originDomain?: string;
}

export interface Sep7CallbackResult {
  transactionXdr: string;
  signerAddress?: string | undefined;
  status?: string | undefined;
  message?: string | undefined;
}

function normalizeSep7Params(input: string | URL | URLSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) {
    return new URLSearchParams(input);
  }

  if (input instanceof URL) {
    const raw = input.search.length > 1 ? input.search.slice(1) : input.hash.replace(/^#/, '');
    return new URLSearchParams(raw);
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return new URLSearchParams();
  }

  if (trimmed.includes('://') || trimmed.startsWith('web+stellar:')) {
    return normalizeSep7Params(new URL(trimmed));
  }

  return new URLSearchParams(trimmed.replace(/^[?#]/, ''));
}

/**
 * SEP-7 requires parameter values to be percent-encoded so that reserved
 * characters (?, &, =, #, spaces, etc.) inside values such as callback URLs
 * do not break URI parsing. URLSearchParams encodes spaces as `+`, which is
 * not valid in a URI query string, so we additionally normalize `+` to `%20`.
 */
function encodeSep7Params(params: URLSearchParams): string {
  return params.toString().replace(/\+/g, '%20');
}

export function buildSep7TxUri(transactionXdr: string, options: BuildSep7TxUriOptions): string {
  if (transactionXdr.trim().length === 0) {
    throw new Error('SEP-7 transaction XDR is required');
  }

  if (options.callbackUrl.trim().length === 0) {
    throw new Error('SEP-7 callback URL is required');
  }

  const params = new URLSearchParams({
    xdr: transactionXdr,
    callback: options.callbackUrl,
  });

  if (options.message) {
    params.set('msg', options.message);
  }

  if (options.networkPassphrase) {
    params.set('network_passphrase', options.networkPassphrase);
  }

  if (options.originDomain) {
    params.set('origin_domain', options.originDomain);
  }

  return `web+stellar:tx?${encodeSep7Params(params)}`;
}

export function parseSep7Callback(input: string | URL | URLSearchParams): Sep7CallbackResult {
  const params = normalizeSep7Params(input);
  const transactionXdrValue =
    params.get('xdr') ??
    params.get('signedTxXdr') ??
    params.get('signed_tx_xdr') ??
    params.get('tx');

  if (!transactionXdrValue) {
    throw new Error('SEP-7 callback did not include a signed transaction XDR');
  }

  const transactionXdr = transactionXdrValue;
  const signerAddressValue = params.get('pubkey') ?? params.get('signer');
  const signerAddress: string | undefined = signerAddressValue ?? undefined;
  const status: string | undefined = params.get('status') ?? undefined;
  const message: string | undefined = params.get('message') ?? params.get('msg') ?? undefined;

  const result: Sep7CallbackResult = { transactionXdr };
  if (signerAddress !== undefined) result.signerAddress = signerAddress;
  if (status !== undefined) result.status = status;
  if (message !== undefined) result.message = message;
  return result;
}
