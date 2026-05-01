import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

export function validateJsonSchema(
  schema: Record<string, unknown>,
  data: unknown,
): { valid: true } | { valid: false; errors: string[] } {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true };
  }

  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (valid) return { valid: true };

  const errors = (validate.errors || []).map(
    (e) => `${e.instancePath || "/"} ${e.message}`,
  );
  return { valid: false, errors };
}
