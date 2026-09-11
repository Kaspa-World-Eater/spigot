/**
 * What the buyer asks for, and how it travels.
 *
 * metered carries a free-form `prompt` string with each reservation, and stays deliberately
 * ignorant of what it means -- the protocol's job is the accounting, not the application. This
 * file is the whole of what `prompt` means here: a catalogue path and a byte offset.
 *
 * THE BUYER DRIVES THE CURSOR, and that is a deliberate choice rather than the obvious one. A
 * seller that remembered "where each buyer had got to" would be holding a second copy of the
 * session's position, and the two copies could disagree -- which is precisely the class of problem
 * the protocol exists to remove. Here the request is complete in itself: the same ask always names
 * the same bytes, whoever is asking and whatever either side remembers. That also makes a resumed
 * download indistinguishable from a fresh one, because there is nothing to resume.
 */
export class MalformedAsk extends Error {}

export interface Ask {
  path: string;
  offset: number;
}

export const encodeAsk = (ask: Ask): string => JSON.stringify(ask);

/**
 * Parse an ask, refusing anything that is not exactly one.
 *
 * Validated rather than trusted, because this string arrives from the network and is the only
 * part of a babel a buyer controls freely. A negative or fractional offset would index a file at a
 * position that does not exist; refusing here means the delivery path never has to wonder.
 */
export function decodeAsk(prompt: string): Ask {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    throw new MalformedAsk('the ask is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new MalformedAsk('the ask is not an object');
  const { path, offset } = parsed as Record<string, unknown>;
  if (typeof path !== 'string' || path.length === 0) throw new MalformedAsk('the ask names no path');
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    throw new MalformedAsk('the ask has no whole, non-negative offset');
  }
  return { path, offset };
}
