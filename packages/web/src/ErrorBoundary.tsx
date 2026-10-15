import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * "page" sits inside the app shell (sidebar + topbar stay usable, so the visitor can
   * simply navigate away). "root" is the last line of defence around the whole app.
   */
  variant?: "page" | "root";
  /** When this changes (the route path) a caught error is cleared and the children re-render. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * React unmounts the entire tree when a render throws and nothing catches it — which is
 * how one bad field on one screen turned into a blank app. This catches the error, keeps
 * everything outside the boundary alive, and offers a way back.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error") };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the detail for whoever is debugging; the screen only shows the message.
    console.error("[vantage] a screen failed to render", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return this.props.variant === "root" ? <RootFallback error={error} /> : <PageFallback error={error} onRetry={this.retry} />;
  }
}

function Detail({ error }: { error: Error }) {
  return (
    <details className="crash-detail">
      <summary>Technical detail</summary>
      <code>{error.name && error.name !== "Error" ? `${error.name}: ` : ""}{error.message || "no message"}</code>
    </details>
  );
}

function PageFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="crash" role="alert">
      <div className="crash-tag mono">SCREEN ERROR</div>
      <h2>This screen hit a problem and couldn't be shown.</h2>
      <p>
        Nothing was changed or lost — the rest of the app is still working. Try the screen again, or pick another one from
        the menu.
      </p>
      <div className="row gap-8 wrap">
        <button type="button" className="btn primary" onClick={onRetry}>
          ↻ Try again
        </button>
        <button type="button" className="btn ghost" onClick={() => window.location.reload()}>
          Reload the app
        </button>
      </div>
      <Detail error={error} />
    </div>
  );
}

function RootFallback({ error }: { error: Error }) {
  function signOutAndReload() {
    // If a stored session is what the app chokes on, a plain reload would loop.
    try {
      window.localStorage.removeItem("vantage_token");
      window.localStorage.removeItem("vantage_merchant");
    } catch {
      /* storage unavailable — reload anyway */
    }
    window.location.hash = "#/login";
    window.location.reload();
  }
  return (
    <div className="crash-screen">
      <div className="crash" role="alert" style={{ maxWidth: 520 }}>
        <div className="crash-tag mono">APP ERROR</div>
        <h2>Vantage couldn't start this page.</h2>
        <p>Your data is safe — this is a display problem. Reloading usually clears it. If it keeps happening, sign out and back in.</p>
        <div className="row gap-8 wrap">
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            ↻ Reload
          </button>
          <button type="button" className="btn ghost" onClick={signOutAndReload}>
            Sign out &amp; reload
          </button>
        </div>
        <Detail error={error} />
      </div>
    </div>
  );
}
