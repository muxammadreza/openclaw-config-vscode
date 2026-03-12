type UiHintRecord = Record<string, { label?: string; help?: string }>;

export function resolveUiHint(
  hints: UiHintRecord,
  fullPath: string,
): { label?: string; help?: string } | undefined {
  const normalized = normalizePath(fullPath);
  if (!normalized) {
    return undefined;
  }

  if (hints[normalized]) {
    return hints[normalized];
  }

  let bestMatch: { label?: string; help?: string } | undefined;
  let bestScore = -1;
  const actualSegments = normalized.split(".");

  for (const [pattern, hint] of Object.entries(hints)) {
    const patternSegments = normalizePath(pattern).split(".");
    if (!matchesPattern(patternSegments, actualSegments)) {
      continue;
    }
    const score = patternSegments.filter((segment) => segment !== "*").length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = hint;
    }
  }

  return bestMatch;
}

function matchesPattern(patternSegments: string[], actualSegments: string[]): boolean {
  if (patternSegments.length !== actualSegments.length) {
    return false;
  }
  for (let index = 0; index < patternSegments.length; index += 1) {
    const pattern = patternSegments[index];
    const actual = actualSegments[index];
    if (pattern !== "*" && pattern !== actual) {
      return false;
    }
  }
  return true;
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(".");
}
