export function hydrateTemplate(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(/\{\{input\.(\w+)\}\}/g, (_match, key: string) => {
    const value = input[key];
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}
