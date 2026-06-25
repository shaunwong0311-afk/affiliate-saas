import { useHashRoute, matchRoute, navigate } from "./router";
import { useAuth } from "./auth";
import { Spinner } from "./ui";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Recruitment } from "./pages/Recruitment";
import { Automation } from "./pages/Automation";
import { NicheMap } from "./pages/NicheMap";
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

const ROUTES: { pattern: string; render: (params: Record<string, string>) => JSX.Element }[] = [
  { pattern: "/dashboard", render: () => <Dashboard /> },
  { pattern: "/recruitment", render: () => <Recruitment /> },
  { pattern: "/niche-map", render: () => <NicheMap /> },
  { pattern: "/automation", render: () => <Automation /> },
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
  const { me, logout, isAffiliate } = useAuth();
  const name = isAffiliate ? me?.affiliate?.name : me?.user?.name;
  return (
    <div className="topbar">
      <div />
      <div className="topbar-actions">
        <div className="merchant-pill">
          <span className="dot" />
          {isAffiliate ? "Affiliate" : me?.merchants?.[0]?.role ?? "member"} · {name ?? "you"}
        </div>
        <button className="btn ghost sm" onClick={logout}>
          Sign out
        </button>
      </div>
    </div>
  );
}

export function App() {
  const { path, navigate: go } = useHashRoute();
  const { me, loading, isAffiliate } = useAuth();

  if (loading) return <Spinner label="initializing vantage…" />;
  if (!me) {
    if (path !== "/login") setTimeout(() => go("/login"), 0);
    return <Login />;
  }

  // Default landing per principal kind.
  if (path === "/" || path === "/login") {
    setTimeout(() => go(isAffiliate ? "/portal" : "/dashboard"), 0);
  }

  let body: JSX.Element | null = null;
  for (const route of ROUTES) {
    const params = matchRoute(route.pattern, path);
    if (params) {
      body = route.render(params);
      break;
    }
  }
  if (!body) {
    body = isAffiliate ? <PortalDashboard /> : <Dashboard />;
  }

  return (
    <div className="app">
      <Sidebar path={path} isAffiliate={isAffiliate} />
      <div className="main">
        <Topbar />
        <div className="content">{body}</div>
      </div>
    </div>
  );
}
