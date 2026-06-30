// Shared helpers for bounding list endpoints so a large org (e.g. a clinic with
// years of imported history) can never trigger oversized responses.

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

// Clinic operates in Sri Lanka (UTC+05:30). Operational queues ("today's" work)
// are scoped relative to the clinic-local day, not UTC.
export const CLINIC_UTC_OFFSET_MINUTES = Number(process.env.CLINIC_UTC_OFFSET_MINUTES ?? 330);

export interface Pagination {
  limit: number;
  offset: number;
}

export const resolvePagination = (query: { limit?: number; offset?: number } | undefined): Pagination => {
  const rawLimit = query?.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIST_LIMIT);
  const offset = Math.max(Math.trunc(query?.offset ?? 0), 0);
  return { limit, offset };
};

// Start of the current clinic-local day, returned as a UTC instant.
export const startOfClinicDay = (now: Date = new Date()): Date => {
  const offsetMs = CLINIC_UTC_OFFSET_MINUTES * 60_000;
  const shifted = new Date(now.getTime() + offsetMs);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMs);
};
