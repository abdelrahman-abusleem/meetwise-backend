const DAY_MS = 86400000;

export function draftExpiry(createdAt: Date, activityAt: Date): Date {
  return new Date(
    Math.min(activityAt.getTime() + DAY_MS, createdAt.getTime() + 7 * DAY_MS),
  );
}
