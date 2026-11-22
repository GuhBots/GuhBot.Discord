/** Returns a random integer from `min` to `max`, inclusive. */
export function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Returns a random item from a non-empty list. */
export function pick<T>(items: readonly T[]): T {
  return items[randomInt(0, items.length - 1)]!;
}
