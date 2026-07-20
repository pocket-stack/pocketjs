// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © xt4d) —
// modules/math/RandomUtils.js. Bit-identical Mulberry32 sequence to the
// original: a playset port and a GameBlocks browser build seeded alike draw
// the SAME stream, which is what makes cross-engine golden traces possible.
//
// Determinism discipline (DETERMINISM.md): never use Math.random in game
// code. Construct one RandomGenerator per subsystem with an explicit seed —
// the shared DEFAULT_PRNG exists for GameBlocks port-compatibility, but two
// subsystems drawing from it interleave their streams (order-dependent).

export class RandomGenerator {
  private state = 0;

  constructor(seed = 42) {
    this.seed(seed);
  }

  seed(seed = 42): this {
    this.state = seed >>> 0;
    return this;
  }

  /** Mulberry32 — uniform in [0, 1). */
  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.random();
  }

  /** Integer in [min, max] (inclusive both ends, like the original). */
  randint(min: number, max: number): number {
    return Math.floor(this.uniform(min, max + 1));
  }

  randrange(start: number, stop: number | null = null, step = 1): number {
    if (stop == null) {
      stop = start;
      start = 0;
    }
    const count = Math.ceil((stop - start) / step);
    return start + Math.floor(this.random() * count) * step;
  }

  choice<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)];
  }
}

export const DEFAULT_PRNG = new RandomGenerator(42);
