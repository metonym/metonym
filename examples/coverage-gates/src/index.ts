/**
 * Adds two numbers.
 *
 * @example
 * ```ts
 * import { add } from "example-coverage-gates"
 * expect(add(2, 3)).toBe(5)
 * ```
 */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * Multiplies two numbers.
 *
 * @example
 * ```ts
 * import { multiply } from "example-coverage-gates"
 * expect(multiply(3, 4)).toBe(12)
 * ```
 */
export function multiply(a: number, b: number): number {
  return a * b;
}

/**
 * Divides two numbers.
 *
 * @example
 * ```ts no-run
 * import { divide } from "example-coverage-gates"
 * const result = divide(10, 2)
 * ```
 */
export function divide(a: number, b: number): number {
  return a / b;
}
