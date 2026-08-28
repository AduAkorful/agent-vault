import React from "react";
import { IconAlertOctagon } from "./Icons";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Agent Vault uncaught error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return <>{this.props.fallback}</>;
      return (
        <div className="console-app error-screen">
          <div className="error-content">
            <IconAlertOctagon />
            <h2>Agent Vault Dashboard Error</h2>
            <pre>{this.state.error?.message}</pre>
            <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
              Reload Console
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
