import { useEffect, type ReactNode } from "react";
import { useHashRoute, matchRoute, navigate } from "./router";
import { useAuth } from "./auth";
import { Spinner } from "./ui";
import { ErrorBoundary } from "./ErrorBoundary";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Recruitment } from "./pages/Recruitment";
import { Automation } from "./pages/Automation";
import { NicheMap } from "./pages/NicheMap";
import { Campaigns } from "./pages/Campaigns";
import { Handoffs } from "./pages/Handoffs";
import { DmQueue } from "./pages/DmQueue";
import { Deliverability } from "./pages/Deliverability";
import { Activation } from "./pages/Activation";
import { Join } from "./pages/Join";
import { Programs } from "./pages/Programs";
import { Affiliates } from "./pages/Affiliates";
import { AffiliateDetail } from "./pages/AffiliateDetail";
import { Conversions } from "./pages/Conversions";
import { Ledger } from "./pages/Ledger";
import { Payouts } from "./pages/Payouts";
import { Reporting } from "./pages/Reporting";
import { Integrations } from "./pages/Integrations";
import { Onboarding } from "./pages/Onboarding";
import { Billing } from "./pages/Billing";
import { Developer } from "./pages/Developer";
import { Settings } from "./pages/Settings";
import { PortalDashboard } from "./portal/PortalDashboard";
import { PortalLinks } from "./portal/PortalLinks";
import { PortalCodes } from "./portal/PortalCodes";
import { PortalStatement } from "./portal/PortalStatement";
import { PortalPayouts } from "./portal/PortalPayouts";
import { PortalSettings } from "./portal/PortalSettings";
import { PortalVerify } from "./portal/PortalVerify";

interface NavItem {
  label: string;
  ico: string;
  path: string;
}

const MERCHANT_NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Operate",
    items: [
      { label: "Dashboard", ico: "▦", path: "/dashboard" },
      { label: "Recruitment", ico: "⌖", path: "/recruitment" },
      { label: "Niche Map", ico: "🜨", path: "/niche-map" },
      { label: "Automation", ico: "⚡", path: "/automation" },
      { label: "Affiliates", ico: "⦿", path: "/affiliates" },
      { label: "Reporting", ico: "▥", path: "/reporting" },
    ],
  },
  {
    section: "Outreach",
    items: [
      { label: "Campaigns", ico: "✎", path: "/campaigns" },
      { label: "Handoffs", ico: "⇥", path: "/handoffs" },
      { label: "DM Queue", ico: "✉", path: "/dm-queue" },
      { label: "Deliverability", ico: "◊", path: "/deliverability" },
      { label: "Activation", ico: "↗", path: "/activation" },
    ],
  },
  {
    section: "Money",
    items: [
      { label: "Conversions", ico: "⇄", path: "/conversions" },
      { label: "Ledger", ico: "▤", path: "/ledger" },
      { label: "Payouts", ico: "◇", path: "/payouts" },
    ],
  },
  {
    section: "Setup",
    items: [
      { label: "Programs & Offers", ico: "◆", path: "/programs" },
      { label: "Integrations", ico: "⊞", path: "/integrations" },
      { label: "Launch Checklist", ico: "✦", path: "/onboarding" },
      { label: "Billing", ico: "❖", path: "/billing" },
      { label: "Developer", ico: "‹›", path: "/developer" },
      { label: "Settings", ico: "⚙", path: "/settings" },
    ],
  },
];

const PORTAL_NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "My Account",
    items: [
      { label: "Dashboard", ico: "▦", path: "/portal" },
      { label: "Links", ico: "⇲", path: "/portal/links" },
      { label: "Codes", ico: "◈", path: "/portal/codes" },
      { label: "Statement", ico: "▤", path: "/portal/statement" },
      { label: "Payouts", ico: "◇", path: "/portal/payouts" },
      { label: "Settings", ico: "⚙", path: "/portal/settings" },
    ],
  },
];

type Route = { pattern: string; render: (params: Record<string, string>) => JSX.Element };

// Two disjoint route tables: a merchant user only ever matches merchant screens and an
// affiliate only portal screens, so neither can land on a page whose API calls are
// guaranteed to be refused for their kind of session.
const MERCHANT_ROUTES: Route[] = [
  { pattern: "/dashboard", render: () => <Dashboard /> },
  { pattern: "/recruitment", render: () => <Recruitment /> },
  { pattern: "/niche-map", render: () => <NicheMap /> },
  { pattern: "/automation", render: () => <Automation /> },
  { pattern: "/campaigns", render: () => <Campaigns /> },
  { pattern: "/handoffs", render: () => <Handoffs /> },
  { pattern: "/dm-queue", render: () => <DmQueue /> },
  { pattern: "/deliverability", render: () => <Deliverability /> },
  { pattern: "/activation", render: () => <Activation /> },
  { pattern: "/affiliates", render: () => <Affiliates /> },
  { pattern: "/affiliates/:id", render: (p) => <AffiliateDetail relationshipId={p.id!} /> },
  { pattern: "/conversions", render: () => <Conversions /> },
  { pattern: "/ledger", render: () => <Ledger /> },
  { pattern: "/payouts", render: () => <Payouts /> },
  { pattern: "/reporting", render: () => <Reporting /> },
  { pattern: "/programs", render: () => <Programs /> },
  { pattern: "/integrations", render: () => <Integrations /> },
  { pattern: "/onboarding", render: () => <Onboarding /> },
  { pattern: "/billing", render: () => <Billing /> },
  { pattern: "/developer", render: () => <Developer /> },
  { pattern: "/settings", render: () => <Settings /> },
];

const PORTAL_ROUTES: Route[] = [
  { pattern: "/portal", render: () => <PortalDashboard /> },
  { pattern: "/portal/links", render: () => <PortalLinks /> },
  { pattern: "/portal/codes", render: () => <PortalCodes /> },
  { pattern: "/portal/statement", render: () => <PortalStatement /> },
  { pattern: "/portal/payouts", render: () => <PortalPayouts /> },
  { pattern: "/portal/settings", render: () => <PortalSettings /> },
];

function Sidebar({ path, isAffiliate }: { path: string; isAffiliate: boolean }) {
  const nav = isAffiliate ? PORTAL_NAV : MERCHANT_NAV;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">V</div>
        <div className="brand-name">
          Vantage
          <small>{isAffiliate ? "affiliate portal" : "recruitment os"}</small>
        </div>
      </div>
      {nav.map((group) => (
        <div key={group.section}>
          <div className="nav-section">{group.section}</div>
          {group.items.map((item) => {
            const active = path === item.path || (item.path !== "/portal" && path.startsWith(item.path + "/"));
            return (
              <div key={item.path} className={`nav-link${active ? " active" : ""}`} onClick={() => navigate(item.path)}>
                <span className="ico">{item.ico}</span>
                {item.label}
              </div>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

function Topbar() {
  const { me, logout, isAffiliate, activeRole } = useAuth();
  const name = isAffiliate ? me?.affiliate?.name : me?.user?.name;
  return (
    <div className="topbar">
      <div />
      <div className="topbar-actions">
        <div className="merchant-pill">
          <span className="dot" />
          {isAffiliate ? "Affiliate" : activeRole ?? "member"} · {name ?? "you"}
        </div>
        <button className="btn ghost sm" onClick={logout}>
          Sign out
        </button>
      </div>
    </div>
  );
}

/** A centred card outside the app shell, for states where there is no shell to show. */
function Standalone({ title, children, actions }: { title: string; children: ReactNode; actions: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mark">V</div>
          <div className="brand-name">
            Vantage
            <small>recruitment os</small>
          </div>
        </div>
        <h3 style={{ fontSize: 17, textAlign: "center" }}>{title}</h3>
        <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.55, textAlign: "center", margin: "10px 0 22px" }}>
          {children}
        </div>
        <div className="row gap-8" style={{ justifyContent: "center" }}>
          {actions}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { path } = useHashRoute();
  const { me, loading, sessionError, retrySession, logout, isAffiliate, activeMerchant } = useAuth();

  // PUBLIC routes render outside the authenticated shell (no session required): the
  // self-serve signup link the reply router hands out, and the emailed portal sign-in
  // link (`#/portal/verify?token=…`), which by definition arrives with no session.
  const joinMatch = matchRoute("/join/:merchantId", path);
  const isVerify = path === "/portal/verify";
  const isPublic = joinMatch !== null || isVerify;
  const inPortal = path === "/portal" || path.startsWith("/portal/");

  // Resolve the screen for a signed-in principal — and where to send anyone standing on
  // a path that is not theirs ("/", "/login", an unknown path, the other principal's area).
  let screen: JSX.Element | null = null;
  let redirectTo: string | null = null;
  if (!isPublic && !loading) {
    if (me) {
      for (const route of isAffiliate ? PORTAL_ROUTES : MERCHANT_ROUTES) {
        const params = matchRoute(route.pattern, path);
        if (params) {
          screen = route.render(params);
          break;
        }
      }
      if (!screen) {
        redirectTo = isAffiliate ? "/portal" : "/dashboard";
        screen = isAffiliate ? <PortalDashboard /> : <Dashboard />;
      }
    } else if (!sessionError && path !== "/login") {
      redirectTo = "/login";
    }
  }

  // Redirects REPLACE the history entry: pushing one made Back return to the path that
  // redirects, which immediately bounced forward again.
  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true });
  }, [redirectTo]);

  if (joinMatch) return <Join merchantId={joinMatch.merchantId!} />;
  if (isVerify) return <PortalVerify />;

  if (loading) return <Spinner label="initializing vantage…" />;

  if (!me) {
    if (sessionError) {
      return (
        <Standalone
          title="Can't reach Vantage right now"
          actions={
            <>
              <button className="btn primary" onClick={retrySession}>
                ↻ Try again
              </button>
              <button className="btn ghost" onClick={logout}>
                Sign out
              </button>
            </>
          }
        >
          You're still signed in — we just couldn't load your account. This is usually a brief connection problem.
          <div className="faint mono" style={{ fontSize: 11.5, marginTop: 10 }}>{sessionError}</div>
        </Standalone>
      );
    }
    // Someone following a portal link while signed out is an affiliate, not a merchant.
    return <Login initialMode={inPortal ? "affiliate" : "login"} />;
  }

  if (me.kind === "user" && !activeMerchant) {
    return (
      <Standalone
        title="No workspace on this account"
        actions={
          <button className="btn primary" onClick={logout}>
            Sign out
          </button>
        }
      >
        You're signed in{me.user?.email ? <> as <span className="mono">{me.user.email}</span></> : null}, but this account isn't an
        active member of any workspace. Ask a workspace owner or admin to invite or reactivate you.
      </Standalone>
    );
  }

  return (
    <div className="app">
      <Sidebar path={path} isAffiliate={isAffiliate} />
      <div className="main">
        <Topbar />
        <div className="content">
          {/* One bad screen must not take the shell with it; navigating away clears the error. */}
          <ErrorBoundary variant="page" resetKey={path}>
            {screen}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
