/**
 * Send-time optimization (Section 8.4). Outreach lands better in the recipient's own
 * working hours (mid-week, business daytime) than at 3am their time. We don't know each
 * creator's exact timezone, but we DO know their country (from enrichment), which gives a
 * good-enough representative offset for a heuristic local-time gate. Unknown geo → never
 * blocks (falls back to the campaign's UTC send window). Pure + testable.
 */

// Representative UTC offset (hours) per country — multi-zone countries use a central value.
const COUNTRY_OFFSET: Record<string, number> = {
  US: -6, CA: -5, MX: -6, BR: -3, AR: -3,
  GB: 0, IE: 0, PT: 0,
  DE: 1, FR: 1, ES: 1, IT: 1, NL: 1, BE: 1, AT: 1, CH: 1, SE: 1, NO: 1, DK: 1, PL: 1,
  FI: 2, GR: 2, RO: 2, ZA: 2,
  AE: 4, IN: 5.5, SG: 8, MY: 8, PH: 8, HK: 8, CN: 8,
  JP: 9, KR: 9, AU: 10, NZ: 12,
};

export interface LocalSendWindow {
  startHour: number; // local hour (inclusive)
  endHour: number; // local hour (exclusive)
  weekdaysOnly: boolean;
}

// Mid-week business hours convert best for email (the research's 25-35% lift band).
export const DEFAULT_LOCAL_WINDOW: LocalSendWindow = { startHour: 8, endHour: 17, weekdaysOnly: true };

function offsetFor(country: string | null | undefined): number | null {
  if (!country) return null;
  const o = COUNTRY_OFFSET[country.toUpperCase()];
  return o == null ? null : o;
}

/** The recipient's local time (hour 0..24 + weekday 0=Sun..6=Sat), or null if geo unknown. */
export function localTimeForCountry(country: string | null | undefined, atUtc: Date): { hour: number; weekday: number } | null {
  const off = offsetFor(country);
  if (off == null) return null;
  const localMs = atUtc.getTime() + off * 3_600_000;
  const d = new Date(localMs);
  return { hour: d.getUTCHours() + d.getUTCMinutes() / 60, weekday: d.getUTCDay() };
}

/** Whether NOW is a good local time to email this recipient. Unknown geo → true (don't block). */
export function isGoodLocalSendTime(country: string | null | undefined, atUtc: Date, win: LocalSendWindow = DEFAULT_LOCAL_WINDOW): boolean {
  const t = localTimeForCountry(country, atUtc);
  if (!t) return true;
  if (win.weekdaysOnly && (t.weekday === 0 || t.weekday === 6)) return false;
  return t.hour >= win.startHour && t.hour < win.endHour;
}
