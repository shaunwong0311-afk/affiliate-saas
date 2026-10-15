import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "./auth";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Last line of defence: anything the per-screen boundary in <App> does not catch
        (the shell itself, the auth provider, a public page) still gets a way back
        instead of an empty document. */}
    <ErrorBoundary variant="root">
      <AuthProvider>
        <App />
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
