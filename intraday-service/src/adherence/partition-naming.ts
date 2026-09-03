/** Pure date/name computation for `AdherencePartitionSchedulerService` - kept separate so it's testable without a real Postgres. */

export interface PartitionBounds {
  name: string;
  /** ISO date (`YYYY-MM-DD`), UTC. */
  start: string;
  end: string;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** `adherence_event_YYYY_MM_DD` covering `[date, date + 1 day)` - matches the migration's own bootstrap-loop naming. */
export function partitionBounds(date: Date): PartitionBounds {
  const start = formatDate(date);
  const end = formatDate(addDays(date, 1));
  return { name: `adherence_event_${start.replace(/-/g, '_')}`, start, end };
}

/**
 * The name of the oldest partition that should still be *kept* -
 * `AdherencePartitionSchedulerService` drops any partition whose name
 * sorts before this one. String comparison is safe here specifically
 * because `YYYY_MM_DD` is fixed-width and zero-padded, so lexicographic
 * order matches chronological order.
 */
export function retentionCutoffPartitionName(referenceDate: Date, retentionDays: number): string {
  return partitionBounds(addDays(referenceDate, -retentionDays)).name;
}
