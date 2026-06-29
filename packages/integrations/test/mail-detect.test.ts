import { describe, it, expect } from "vitest";
import { detectMailProvider } from "../src/index.js";

const mx = (hosts: string[]) => async () => hosts.map((exchange) => ({ exchange }));

describe("detectMailProvider", () => {
  it("routes free Gmail to the app-password path (no MX lookup)", async () => {
    const d = await detectMailProvider("creator@gmail.com");
    expect(d.kind).toBe("google");
    expect(d.method).toBe("google_app_password");
    expect(d.smtp).toEqual({ host: "smtp.gmail.com", port: 587, secure: false });
  });

  it("routes free Outlook to Microsoft OAuth", async () => {
    const d = await detectMailProvider("creator@outlook.com");
    expect(d).toMatchObject({ kind: "microsoft", method: "microsoft_oauth" });
  });

  it("detects a custom domain on Google Workspace via MX → Google", async () => {
    const d = await detectMailProvider("jane@herbrand.com", { resolveMx: mx(["aspmx.l.google.com", "alt1.aspmx.l.google.com"]) });
    expect(d.kind).toBe("google");
  });

  it("detects a custom domain on Microsoft 365 via MX → Microsoft", async () => {
    const d = await detectMailProvider("jane@herbrand.com", { resolveMx: mx(["herbrand-com.mail.protection.outlook.com"]) });
    expect(d.kind).toBe("microsoft");
  });

  it("falls back to pre-filled SMTP for self-hosted email", async () => {
    const d = await detectMailProvider("jane@herbrand.com", { resolveMx: mx(["mail.herbrand.com"]) });
    expect(d.kind).toBe("smtp");
    expect(d.smtp).toEqual({ host: "mail.herbrand.com", port: 587, secure: false });
    expect(d.imap).toEqual({ host: "mail.herbrand.com", port: 993 });
  });

  it("uses a known preset (Zoho) without an MX lookup", async () => {
    const d = await detectMailProvider("jane@zoho.com");
    expect(d.smtp).toEqual({ host: "smtp.zoho.com", port: 465, secure: true });
  });

  it("falls back to SMTP when the MX lookup fails", async () => {
    const d = await detectMailProvider("jane@herbrand.com", { resolveMx: async () => { throw new Error("no dns"); } });
    expect(d.kind).toBe("smtp");
  });
});
