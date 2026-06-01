const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function startOfUtcDay(date: Date): Date {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

export function parseSeedBaseDate(value: string | undefined, now = new Date()): Date {
  if (!value) {
    return startOfUtcDay(now);
  }

  if (!ISO_DATE_RE.test(value)) {
    throw new Error("SEED_BASE_DATE must use YYYY-MM-DD format");
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("SEED_BASE_DATE must be a valid calendar date");
  }

  return parsed;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

