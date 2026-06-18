import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setToken, setMerchant, getMerchant, hasToken } from "./api";

export interface Membership {
  merchantId: string;
  role: string;
}

interface Me {
  kind: "user" | "affiliate" | "apikey";
  user?: { id: string; name: string; email: string };
  affiliate?: { id: string; name: string; primaryEmail?: string };
  merchants?: Membership[];
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  activeMerchant: string | null;
  isAffiliate: boolean;
  login(email: string, password: string): Promise<void>;
  signup(input: { email: string; password: string; name: string; merchantName: string; niche?: string }): Promise<void>;
  affiliateLogin(email: string): Promise<void>;
  selectMerchant(id: string): void;
  logout(): void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeMerchant, setActive] = useState<string | null>(getMerchant());

  async function refresh() {
    if (!hasToken()) {
      setLoading(false);
      return;
    }
    try {
      const data = await api.get<Me>("/auth/me");
      setMe(data);
      if (data.kind === "user" && data.merchants?.length) {
        const current = getMerchant();
        const valid = current && data.merchants.some((m) => m.merchantId === current);
        const chosen = valid ? current! : data.merchants[0]!.merchantId;
        setMerchant(chosen);
        setActive(chosen);
      }
    } catch {
      setToken(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function login(email: string, password: string) {
    const res = await api.post<{ token: string; merchants: Membership[] }>("/auth/login", { email, password });
    setToken(res.token);
    if (res.merchants?.[0]) {
      setMerchant(res.merchants[0].merchantId);
      setActive(res.merchants[0].merchantId);
    }
    await refresh();
  }

  async function signup(input: { email: string; password: string; name: string; merchantName: string; niche?: string }) {
    const res = await api.post<{ token: string; merchant: { id: string } }>("/auth/signup", input);
    setToken(res.token);
    setMerchant(res.merchant.id);
    setActive(res.merchant.id);
    await refresh();
  }

  async function affiliateLogin(email: string) {
    const res = await api.post<{ token: string }>("/auth/affiliate/token", { email });
    setToken(res.token);
    setMerchant(null);
    setActive(null);
    await refresh();
  }

  function selectMerchant(id: string) {
    setMerchant(id);
    setActive(id);
    window.location.reload();
  }

  function logout() {
    setToken(null);
    setMerchant(null);
    setMe(null);
    setActive(null);
    window.location.hash = "#/login";
  }

  return (
    <Ctx.Provider
      value={{
        me,
        loading,
        activeMerchant,
        isAffiliate: me?.kind === "affiliate",
        login,
        signup,
        affiliateLogin,
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
