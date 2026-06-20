import { createHash } from "node:crypto";

/**
 * Meeting booking for the managed (A-tier, human-closed) track. When a warm A-tier
 * reply comes in, the AI-SDR qualifies and offers a booking link on the merchant's
 * real calendar. The Gmail/Microsoft OAuth the platform already holds for sending
 * also grants calendar scope, so a real adapter reuses that; a Cal.com/Calendly
 * link is the simplest path. Stub generates a deterministic link so the flow runs.
 */
export interface BookingRequest {
  merchantId: string;
  prospectId: string;
  prospectName: string;
  ownerEmail: string | null;
}

export interface BookingResult {
  bookingRef: string;
  bookingUrl: string;
}

export interface CalendarBooking {
  readonly provider: string;
  /** Create a booking link/hold the prospect can use to pick a time. */
  createBookingLink(req: BookingRequest): Promise<BookingResult>;
}

export class StubCalendarBooking implements CalendarBooking {
  readonly provider = "stub";
  async createBookingLink(req: BookingRequest): Promise<BookingResult> {
    const ref = createHash("sha1").update(req.merchantId + req.prospectId).digest("hex").slice(0, 12);
    return { bookingRef: ref, bookingUrl: `https://cal.vantage.dev/${req.merchantId.slice(-6)}/${ref}` };
  }
}

export interface HttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }>;
}

/** Cal.com adapter skeleton — creates an event-type booking link. */
export class CalcomBooking implements CalendarBooking {
  readonly provider = "calcom";
  constructor(private readonly opts: { apiKey: string; eventTypeId: string; http?: HttpClient }) {}
  async createBookingLink(req: BookingRequest): Promise<BookingResult> {
    if (!this.opts.http) throw new Error("cal.com not configured");
    void req;
    return { bookingRef: this.opts.eventTypeId, bookingUrl: `https://cal.com/${this.opts.eventTypeId}` };
  }
}

/**
 * Google Calendar adapter skeleton — reuses the merchant's Gmail OAuth token
 * (calendar scope) that the platform already stores for sending.
 */
export class GoogleCalendarBooking implements CalendarBooking {
  readonly provider = "google";
  constructor(private readonly opts: { accessToken: string; http?: HttpClient }) {}
  async createBookingLink(req: BookingRequest): Promise<BookingResult> {
    if (!this.opts.http) throw new Error("google calendar not configured");
    void req;
    throw new Error("not implemented");
  }
}
