import type { RouteModule } from "./helpers.js";
import { authRoutes } from "./auth.js";
import { programRoutes } from "./programs.js";
import { ingestionRoutes } from "./ingestion.js";
import { affiliateRoutes } from "./affiliates.js";
import { crmRoutes } from "./crm.js";
import { codeRoutes } from "./codes.js";
import { creativeRoutes } from "./creatives.js";
import { conversionRoutes } from "./conversions.js";
import { ledgerRoutes } from "./ledger.js";
import { payoutRoutes } from "./payouts.js";
import { billingRoutes } from "./billing.js";
import { reportingRoutes } from "./reporting.js";
import { recruitmentRoutes } from "./recruitment.js";
import { automationRoutes } from "./automation.js";
import { integrationRoutes } from "./integrations.js";
import { onboardingRoutes } from "./onboarding.js";
import { developerRoutes } from "./developer.js";
import { portalRoutes } from "./portal.js";
import { adminRoutes } from "./admin.js";
import { merchantRoutes } from "./merchants.js";

/** Every route module, registered by the app in order. */
export const allRouteModules: RouteModule[] = [
  authRoutes,
  merchantRoutes,
  programRoutes,
  ingestionRoutes,
  affiliateRoutes,
  crmRoutes,
  codeRoutes,
  creativeRoutes,
  conversionRoutes,
  ledgerRoutes,
  payoutRoutes,
  billingRoutes,
  reportingRoutes,
  recruitmentRoutes,
  automationRoutes,
  integrationRoutes,
  onboardingRoutes,
  developerRoutes,
  portalRoutes,
  adminRoutes,
];
