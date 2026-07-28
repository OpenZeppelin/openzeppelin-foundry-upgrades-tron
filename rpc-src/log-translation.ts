// Event logs cross the predicted/actual address boundary just like storage slots and call
// results: a log emitted on-chain carries ACTUAL addresses (the log's own emitter, plus any
// address embedded in an indexed `topic` or in the ABI-encoded `data`), and an inbound
// `eth_getLogs` filter is expressed by the caller in PREDICTED addresses. This module maps
// addresses in either direction through a caller-supplied {@link AddressMapper}; the same
// scanner serves the outbound reverse-map (actual -> predicted, on results and receipts) and
// the inbound forward-map (predicted -> actual, on the filter) by varying only the mapper.
//
// External log/filter content is dynamically-shaped JSON hex with no canonical type here, so
// `any` marks that deliberately untyped seam; every value is validated inline before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

const WORD_BODY = /^[0-9a-f]{64}$/;
const ADDRESS_BODY = /^[0-9a-f]{40}$/;
const HIGH_ZERO = '0'.repeat(24);

/**
 * Maps one lowercase `0x`-prefixed EVM address to its counterpart in the other world, returning
 * the address unchanged when there is no mapping. Exact lookup — never a heuristic on the value.
 */
export type AddressMapper = (evmAddress: string) => string;

function lowerBody(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase();
}

/**
 * Map a plain 20-byte address field (a log's `address`, or a filter `address` entry). Non-address
 * or zero inputs are returned untouched.
 */
export function mapAddressField(address: JsonAny, map: AddressMapper): JsonAny {
  if (typeof address !== 'string') return address;
  const body = lowerBody(address);
  if (!ADDRESS_BODY.test(body) || /^0+$/.test(body)) return address;
  return map(`0x${body}`);
}

/**
 * Map a single 32-byte log word (an event topic, or one ABI word of `data`). A word is treated as
 * an address only when it is a left-padded, non-zero 20-byte address; hashes, bytes32, numeric
 * amounts, and the zero word are left byte-for-byte untouched. The mapper is an exact lookup
 * against the known gateway addresses (identity when unmapped), so a coincidental non-address
 * value is only ever rewritten if its low 20 bytes exactly equal a mapped address — which does
 * not occur for real ABI-encoded numeric/hash data.
 */
export function mapLogWord(word: JsonAny, map: AddressMapper): JsonAny {
  if (typeof word !== 'string') return word;
  const body = lowerBody(word);
  if (!WORD_BODY.test(body)) return word; // not a 32-byte word — untouched
  if (!body.startsWith(HIGH_ZERO)) return word; // high 12 bytes set — not an address
  const low = body.slice(24);
  if (/^0+$/.test(low)) return word; // zero address — untouched
  const mapped = lowerBody(map(`0x${low}`));
  if (!ADDRESS_BODY.test(mapped) || mapped === low) return word; // unmapped/invalid — untouched
  return `0x${HIGH_ZERO}${mapped}`;
}

/** Map every entry of a topics array through {@link mapLogWord}. */
export function mapTopics(topics: JsonAny, map: AddressMapper): JsonAny {
  if (!Array.isArray(topics)) return topics;
  return topics.map(topic => mapLogWord(topic, map));
}

/** Map each complete 32-byte word of ABI-encoded log `data`; trailing sub-word bytes are kept. */
export function mapLogData(data: JsonAny, map: AddressMapper): JsonAny {
  if (typeof data !== 'string') return data;
  const body = lowerBody(data);
  if (body.length === 0) return typeof data === 'string' && /^0x/i.test(data) ? '0x' : data;
  let out = '';
  let offset = 0;
  for (; offset + 64 <= body.length; offset += 64) {
    out += lowerBody(mapLogWord(`0x${body.slice(offset, offset + 64)}`, map));
  }
  out += body.slice(offset); // trailing bytes that do not fill a 32-byte word — untouched
  return `0x${out}`;
}

/** Reverse/forward-map a whole log entry: its `address`, `topics`, and `data`. */
export function mapLogEntry(log: JsonAny, map: AddressMapper): JsonAny {
  if (log === null || typeof log !== 'object' || Array.isArray(log)) return log;
  const mapped: JsonAny = { ...log };
  if ('address' in log) mapped.address = mapAddressField(log.address, map);
  if ('topics' in log) mapped.topics = mapTopics(log.topics, map);
  if ('data' in log) mapped.data = mapLogData(log.data, map);
  return mapped;
}

/** Forward-map the address/topics of an `eth_getLogs` positional parameter array (filter is [0]). */
export function mapFilterParams(params: JsonAny, map: AddressMapper): JsonAny {
  if (!Array.isArray(params) || params.length === 0) return params;
  const [filter, ...rest] = params;
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) return params;
  const mapped: JsonAny = { ...filter };
  if (typeof filter.address === 'string') {
    mapped.address = mapAddressField(filter.address, map);
  } else if (Array.isArray(filter.address)) {
    mapped.address = filter.address.map((entry: JsonAny) => mapAddressField(entry, map));
  }
  if (Array.isArray(filter.topics)) {
    mapped.topics = filter.topics.map((entry: JsonAny) =>
      Array.isArray(entry) ? entry.map((inner: JsonAny) => mapLogWord(inner, map)) : mapLogWord(entry, map),
    );
  }
  return [mapped, ...rest];
}
