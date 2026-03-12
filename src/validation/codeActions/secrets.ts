export function looksSensitivePath(path: string): boolean {
  return /(token|api(?:_|-)?key|secret|password|private(?:_|-)?key|access(?:_|-)?key)/i.test(path);
}

export function toEnvVarName(path: string): string {
  const segments = path
    .split(".")
    .filter((segment) => segment && !/^\d+$/.test(segment))
    .map((segment) =>
      segment
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toUpperCase(),
    )
    .filter(Boolean);

  const suffix = segments.slice(-4).join("_");
  if (!suffix) {
    return "OPENCLAW_SECRET";
  }
  return `OPENCLAW_${suffix}`;
}
