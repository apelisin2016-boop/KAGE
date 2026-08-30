import { Component, type ErrorInfo, type ReactNode } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

export function AppErrorComponent({ error, reset }: ErrorComponentProps) {
  return (
    <main className="crash-screen">
      <span className="crash-icon" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={2} />
      </span>
      <h1>Сбой партии</h1>
      <p className="crash-msg">{error.message || "Неожиданная ошибка. Можно вернуться и продолжить."}</p>
      <div className="row">
        <button type="button" className="cta" onClick={() => (reset ? reset() : window.location.reload())}>
          Вернуться
        </button>
      </div>
    </main>
  );
}

type GuardProps = { children: ReactNode; onReset: () => void };

type GuardState = { error: Error | null };

export class GameGuard extends Component<GuardProps, GuardState> {
  state: GuardState = { error: null };

  static getDerivedStateFromError(error: Error): GuardState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("KAGE", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="crash-screen">
        <span className="crash-icon" aria-hidden="true">
          <TriangleAlert className="size-10" strokeWidth={2} />
        </span>
        <h1>Сбой партии</h1>
        <p className="crash-msg">{this.state.error.message || "Неожиданная ошибка."}</p>
        <div className="row">
          <button
            type="button"
            className="cta"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset();
            }}
          >
            В меню
          </button>
        </div>
      </main>
    );
  }
}
