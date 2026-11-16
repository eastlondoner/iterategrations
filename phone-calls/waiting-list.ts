// waiting-list.ts — the one thing a sales call can do: note an email address for the mind's
// waiting list. Pure: the bridge keeps the address on the call and puts it on `call-ended`; the
// mind's own code decides whether to send one email after the call.

/** How many times one call may note an address. The last one stands. */
export const WAITING_LIST_CHANGES = 3;

/** The longest address a mail system accepts (RFC 5321). */
const MAX_ADDRESS = 254;
const ADDRESS = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi;

/** What `salesMessage` answers for one delegation. */
export type WaitingListOutcome =
  | { ok: true; status: "noted" }
  | { ok: false; status: "no-address" | "several-addresses" | "too-many-changes" };

/** The one email address in free text, in lower case. None, or more than one distinct, is refused. */
export function emailIn(
  words: string,
): { ok: true; email: string } | { ok: false; status: "no-address" | "several-addresses" } {
  const found = new Set(
    [...words.matchAll(ADDRESS)]
      .map(([address]) => address.toLowerCase())
      .filter((address) => address.length <= MAX_ADDRESS),
  );
  if (found.size === 0) return { ok: false, status: "no-address" };
  if (found.size > 1) return { ok: false, status: "several-addresses" };
  return { ok: true, email: [...found][0]! };
}
