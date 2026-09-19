import { Component } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';

/** Keeps one broken page from blanking the whole site. Resets itself when you navigate (resetKey changes). */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error, info) {
    console.error('Page crashed:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="container page">
        <div className="card empty" role="alert">
          <div className="ico"><Icon name="alert" /></div>
          <h3>This page hit a problem</h3>
          <p>Something went wrong while showing it. The rest of the site still works.</p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button className="btn primary" onClick={() => window.location.reload()}>Reload the page</button>
            <Link to="/" className="btn">Back to the overview</Link>
          </div>
        </div>
      </div>
    );
  }
}
