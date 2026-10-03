import { Component, type ComponentType, type ErrorInfo, type FunctionComponent, type ReactNode } from 'react';

// Contains a render error to the component that threw, instead of blanking the app.
export class Boundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boundary">
        <p>
          <b>{this.props.label}</b> hit an error: {this.state.error.message}
        </p>
        <button className="action" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

export function bounded<P extends object>(label: string, C: ComponentType<P>): FunctionComponent<P> {
  const Wrapped = (props: P) => (
    <Boundary label={label}>
      <C {...props} />
    </Boundary>
  );
  Wrapped.displayName = `Bounded(${label})`;
  return Wrapped;
}
