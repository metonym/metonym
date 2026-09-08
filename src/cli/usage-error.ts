/** Thrown for bad CLI input (unknown flag, invalid value, unmatched paths). Caught once in `main()` → exit 2. */
export class UsageError extends Error {}
