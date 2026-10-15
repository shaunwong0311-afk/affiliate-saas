import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, errorMessage, errorStatus, setToken, setMerchant, getMerchant, hasToken } from "./api";

export interface Membership {
  merchantId: string;
  role: string;
}

/** `GET /auth/me`. Everything past `kind` depends on the principal and may be absent. */
interface Me {
  kind: "user" | "affiliate" | "apikey";
  /** null when the account behind a still-valid token no longer exists. */
  user?: { id: string; name?: string | null; email?: string | null } | null;
  affiliate?: { id: string; name?: string | null; primaryEmail?: string | null } | null;
  merchants?: Membership[];
  scopes?: string[];
}

/** What happened when an affiliate asked to sign in with their email. */
export type AffiliateLoginResult =
  /** The API handed back a dev token (non-production) and the session is live. */
  | "signed_in"
  /** Production path: a one-time link was emailed (or the address is unknown — the API never says which). */
  | "link_sent";

/** Same ranks the API enforces (`auth/rbac.ts`). Used only to explain a control up front —
 *  the server stays the authority and a 403 is still handled wherever it can occur. */
const ROLE_RANK: Record<string, number> = { viewer: 1, analyst: 2, manager: 3, admin: 4, owner: 5 };

export function roleAtLeast(role: string | null | undefined, minimum: "manager" | "admin" | "owner"): boolean {
  return (ROLE_RANK[role ?? ""] ?? 0) >= ROLE_RANK[minimum]!;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  /** Set when a stored session could not be checked (API unreachable). The token is kept. */
  sessionError: string | null;
  retrySession(): void;
  activeMerchant: string | null;
  /** The signed-in user's role on the active merchant, when known. */
  activeRole: string | null;
  isAffiliate: boolean;
  login(email: string, password: string): Promise<void>;
  signup(input: { email: string; password: string; name: string; merchantName: string; niche?: string }): Promise<void>;
  affiliateLogin(email: string): Promise<AffiliateLoginResult>;
  /** Exchange an emailed magic-link token for a portal session. */
  completeAffiliateLogin(magicToken: string): Promise<void>;
  /** Accept an emailed team invitation: with a password for a new account, or as the signed-in account. */
  acceptInvite(inviteToken: string, password?: string): Promise<void>;
  selectMerchant(id: string): void;
  logout(): void;
}

const Ctx = createContext<AuthCtx | null>(null);

/**
 * Magic-link tokens are single-use, so the exchange must be sent exactly once per token
 * even when the calling effect runs twice (React StrictMode in dev, a fast re-mount).
 * Every caller for the same token shares one attempt.
 */
const magicLogins = new Map<string, Promise<void>>();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  // Only "loading" when there is a stored session to check — a signed-out visitor (and the
  // public join / sign-in-link pages) should not sit behind a spinner first.
  const [loading, setLoading] = useState(() => hasToken());
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [activeMerchant, setActive] = useState<string | null>(getMerchant());
  // Latest-wins guard: an older /auth/me answer must not overwrite a newer session.
  const refreshSeq = useRef(0);

  /**
   * Load the principal for the stored token. Resolves to null when there is no session.
   * A token the server rejects is discarded; a token that merely could not be checked
   * (offline, API down) is KEPT and `sessionError` is set, so a network blip — or a failed
   * profile load right after a one-time link was spent — does not sign the person out.
   */
  async function refresh(): Promise<Me | null> {
    const seq = ++refreshSeq.current;
    const current = () => refreshSeq.current === seq;
    if (!hasToken()) {
      if (current()) {
        setMe(null);
        setSessionError(null);
        setLoading(false);
      }
      return null;
    }
    try {
      const data = await api.get<Me | null>("/auth/me");
      if (!current()) return data ?? null;
      if (!data || typeof data.kind !== "string") throw new ApiError("The server did not describe this session.", 502, "bad_response");
      setMe(data);
      setSessionError(null);
      const memberships = data.kind === "user" ? data.merchants ?? [] : [];
      if (memberships.length) {
        const stored = getMerchant();
        const chosen = stored && memberships.some((m) => m.merchantId === stored) ? stored : memberships[0]!.merchantId;
        setMerchant(chosen);
        setActive(chosen);
      } else {
        // An affiliate (or a user with no workspace) has no merchant scope — do not keep
        // sending a stale x-merchant-id from an earlier session.
        setMerchant(null);
        setActive(null);
      }
      return data;
    } catch (e) {
      if (!current()) return null;
      const status = errorStatus(e);
      setMe(null);
      if (status === 401 || status === 403) {
        setToken(null);
        setSessionError(null);
      } else {
        setSessionError(errorMessage(e, "Could not check your session."));
      }
      return null;
    } finally {
      if (current()) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function retrySession() {
    setLoading(true);
    void refresh();
  }

  async function login(email: string, password: string) {
    const res = await api.post<{ token: string; merchants?: Membership[] }>("/auth/login", { email, password });
    setToken(res.token);
    const first = res.merchants?.[0];
    setMerchant(first?.merchantId ?? null);
    setActive(first?.merchantId ?? null);
    await refresh();
  }

  async function signup(input: { email: string; password: string; name: string; merchantName: string; niche?: string }) {
    const res = await api.post<{ token: string; merchant?: { id: string } }>("/auth/signup", input);
    setToken(res.token);
    setMerchant(res.merchant?.id ?? null);
    setActive(res.merchant?.id ?? null);
    await refresh();
  }

  async function acceptInvite(inviteToken: string, password?: string) {
    const res = await api.post<{ token: string; merchants?: Membership[] }>("/auth/accept-invite", password ? { token: inviteToken, password } : { token: inviteToken });
    // The invitation is spent from here on.
    setToken(res.token);
    const first = res.merchants?.[0];
    setMerchant(first?.merchantId ?? null);
    setActive(first?.merchantId ?? null);
    await refresh();
  }

  function completeAffiliateLogin(magicToken: string): Promise<void> {
    const shared = magicLogins.get(magicToken);
    if (shared) return shared;
    const attempt = (async () => {
      const verified = await api.post<{ token?: unknown } | null>("/auth/affiliate/verify", { token: magicToken });
      const session = verified?.token;
      if (typeof session !== "string" || !session) {
        throw new ApiError("The server did not start a session. Request a new sign-in link.", 502, "bad_response");
      }
      // From here the one-time link is spent — never ask the visitor to click it again.
      setToken(session);
      setMerchant(null);
      setActive(null);
      const profile = await refresh();
      // No profile but the token survived = the session is fine and only the profile load
      // failed; the app shell shows a retry. No token = the server refused its own session.
      if (!profile && !hasToken()) throw new ApiError("That sign-in could not be completed. Request a new link.", 401, "session_rejected");
    })();
    magicLogins.set(magicToken, attempt);
    // A failed attempt may be retried (the link might not have been spent); a successful
    // one stays cached so a second caller does not burn the token again.
    attempt.catch(() => {
      if (magicLogins.get(magicToken) === attempt) magicLogins.delete(magicToken);
    });
    return attempt;
  }

  async function affiliateLogin(email: string): Promise<AffiliateLoginResult> {
    // Secure flow: request a magic link delivered to the affiliate's inbox. Outside
    // production the API also returns the token so the demo completes without a mailbox.
    const res = await api.post<{ sent?: boolean; devToken?: unknown } | null>("/auth/affiliate/request-link", { email });
    const devToken = res?.devToken;
    if (typeof devToken !== "string" || !devToken) return "link_sent";
    await completeAffiliateLogin(devToken);
    return "signed_in";
  }

  function selectMerchant(id: string) {
    setMerchant(id);
    setActive(id);
    window.location.reload();
  }

  function logout() {
    refreshSeq.current++; // drop any /auth/me still in flight
    magicLogins.clear();
    setToken(null);
    setMerchant(null);
    setMe(null);
    setActive(null);
    setSessionError(null);
    setLoading(false);
    window.location.hash = "#/login";
  }

  const activeRole = me?.kind === "user" ? me.merchants?.find((m) => m.merchantId === activeMerchant)?.role ?? null : null;

  return (
    <Ctx.Provider
      value={{
        me,
        loading,
        sessionError,
        retrySession,
        activeMerchant,
        activeRole,
        isAffiliate: me?.kind === "affiliate",
        login,
        signup,
        affiliateLogin,
        completeAffiliateLogin,
        acceptInvite,
        selectMerchant,
        logout,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
