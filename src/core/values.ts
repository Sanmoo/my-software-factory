// Small value helpers shared by the core, the tracker and PR adapters, the config loader and the
// runtime. One definition each: copies drift apart.

export type Obj = Record<string, unknown>;

export const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
