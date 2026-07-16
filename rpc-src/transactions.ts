import { Transaction, getAddress } from 'ethers';

const RAW_TRANSACTION_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/;
const MAX_TRON_CALL_VALUE = BigInt(Number.MAX_SAFE_INTEGER);

/** Options accepted by {@link decodeLegacyTransaction}. */
export interface DecodeLegacyTransactionOptions {
  expectedSender?: string;
  expectedChainId?: number | bigint;
}

/** The shape returned by a successful {@link decodeLegacyTransaction} call. */
export interface DecodedLegacyTransaction {
  raw: string;
  hash: string | null;
  type: 0;
  kind: 'deployment' | 'call';
  from: string;
  to: string | null;
  chainId: bigint;
  nonce: number;
  gasLimit: bigint;
  gasPrice: bigint;
  value: bigint;
  callValue: string;
  data: string;
}

class TransactionDecodeError extends Error {
  code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransactionDecodeError';
    this.code = code;
  }
}

function expectedChainId(value: number | bigint | undefined): bigint {
  let chainId;
  try {
    chainId = BigInt(value as number | bigint);
  } catch (error) {
    throw new TransactionDecodeError('INVALID_EXPECTED_CHAIN', 'Expected chain ID must be a positive integer', {
      cause: error,
    });
  }
  if (chainId <= 0n) {
    throw new TransactionDecodeError('INVALID_EXPECTED_CHAIN', 'Expected chain ID must be a positive integer');
  }
  return chainId;
}

function expectedSender(value: string | undefined): string {
  try {
    return getAddress(value as string);
  } catch (error) {
    throw new TransactionDecodeError('INVALID_EXPECTED_SENDER', 'Expected sender is not a valid address', {
      cause: error,
    });
  }
}

function decodeLegacyTransaction(raw: string, options: DecodeLegacyTransactionOptions = {}): DecodedLegacyTransaction {
  const requiredSender = expectedSender(options.expectedSender);
  const requiredChainId = expectedChainId(options.expectedChainId);
  if (typeof raw !== 'string' || !RAW_TRANSACTION_PATTERN.test(raw)) {
    throw new TransactionDecodeError('INVALID_RAW_TRANSACTION', 'Malformed raw transaction bytes');
  }

  let transaction;
  try {
    transaction = Transaction.from(raw);
  } catch (error) {
    throw new TransactionDecodeError('INVALID_RAW_TRANSACTION', 'Malformed or noncanonical raw transaction', {
      cause: error,
    });
  }

  let canonical;
  try {
    canonical = transaction.serialized;
  } catch (error) {
    throw new TransactionDecodeError('UNSIGNED_TRANSACTION', 'Raw transaction must be signed', { cause: error });
  }
  if (canonical.toLowerCase() !== raw.toLowerCase()) {
    throw new TransactionDecodeError('INVALID_RAW_TRANSACTION', 'Raw transaction must use canonical legacy encoding');
  }
  if (transaction.type !== 0) {
    throw new TransactionDecodeError('UNSUPPORTED_TRANSACTION_TYPE', 'Only legacy type-0 transactions are supported');
  }
  if (!transaction.isSigned() || transaction.from === null) {
    throw new TransactionDecodeError('UNSIGNED_TRANSACTION', 'Raw transaction must be signed');
  }
  if (transaction.chainId <= 0n) {
    throw new TransactionDecodeError(
      'UNPROTECTED_TRANSACTION',
      'Legacy transaction must be protected with an EIP-155 chain ID',
    );
  }

  if (transaction.chainId !== requiredChainId) {
    throw new TransactionDecodeError(
      'CHAIN_ID_MISMATCH',
      'Signed transaction chain ID does not match the configured chain',
    );
  }
  if (transaction.from !== requiredSender) {
    throw new TransactionDecodeError(
      'SENDER_MISMATCH',
      'Recovered transaction sender does not match the expected sender',
    );
  }
  if (transaction.value > MAX_TRON_CALL_VALUE) {
    throw new TransactionDecodeError(
      'VALUE_OUT_OF_RANGE',
      'Transaction value exceeds the exact TronWeb safe-integer range',
    );
  }
  if (transaction.gasPrice === null) {
    throw new TransactionDecodeError('INVALID_RAW_TRANSACTION', 'Legacy transaction is missing gasPrice');
  }

  return {
    raw: canonical.toLowerCase(),
    hash: transaction.hash,
    type: 0,
    kind: transaction.to === null ? 'deployment' : 'call',
    from: transaction.from,
    to: transaction.to,
    chainId: transaction.chainId,
    nonce: transaction.nonce,
    gasLimit: transaction.gasLimit,
    gasPrice: transaction.gasPrice,
    value: transaction.value,
    callValue: transaction.value.toString(),
    data: transaction.data,
  };
}

export { MAX_TRON_CALL_VALUE, TransactionDecodeError, decodeLegacyTransaction };
