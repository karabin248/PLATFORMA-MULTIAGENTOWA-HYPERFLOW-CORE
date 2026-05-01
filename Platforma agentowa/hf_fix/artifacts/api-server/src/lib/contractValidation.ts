import type { ZodTypeAny } from "zod";

export function parseWithSchema<T extends ZodTypeAny>(schema: T, payload: unknown) {
  return schema.safeParse(payload);
}

export function assertResponseShape<T extends ZodTypeAny>(schema: T, payload: unknown, route: string) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Response schema assertion failed for ${route}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '_'}:${i.message}`).join('; ')}`);
  }
  return payload;
}
