/** Every amount in Fiar is WLD, quoted to four decimals so a column of typed figures aligns like a
 *  real ledger — and so the karma spread stays visible at a catalogue priced under 0.10 WLD, where
 *  two decimals would round most of it away. */
export function wld(value: number): string {
  return value.toFixed(4);
}

export function points(value: number): string {
  return value.toFixed(1);
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Shortens `carol.alice.vouchme.eth` to `carol` and `0xC0FFEE…` to `0xC0FF…EE21`. */
export function shortName(idOrAddress: string): string {
  if (idOrAddress.startsWith("0x")) {
    return `${idOrAddress.slice(0, 6)}…${idOrAddress.slice(-4)}`;
  }
  return idOrAddress.split(".")[0] ?? idOrAddress;
}

export function tierLabel(tier: 0 | 1 | 2): string {
  return tier === 0 ? "Enrolled" : `Tier ${tier}`;
}
