import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Icon from './components/Icon.jsx';
import MunicipalitySwitcher from './components/MunicipalitySwitcher.jsx';
import RefreshButton, { OperatorSignIn } from './components/RefreshButton.jsx';
import SearchBox from './components/SearchBox.jsx';
import { EmptyState } from './components/ui.jsx';
import { useTheme } from './lib/hooks.js';
import { useUtility } from './lib/municipality.jsx';
import About from './views/About.jsx';
import Activity from './views/Activity.jsx';
import Insights from './views/Insights.jsx';
import Network from './views/Network.jsx';
import MapPage from './views/MapPage.jsx';
import NodeDetail from './views/NodeDetail.jsx';
import OutageDetail from './views/OutageDetail.jsx';
import Outages from './views/Outages.jsx';
import Overview from './views/Overview.jsx';
import Planned from './views/Planned.jsx';
import Suburb from './views/Suburb.jsx';

// Five destinations people actually use. "Planned" is a tab inside Outages; "What changed" and "How it works" live in the footer.
const NAV = [
  ['/', 'Overview', 'home', true],
  ['/outages', 'Outages', 'list'],
  ['/map', 'Map', 'map'],
  ['/insights', 'Insights', 'chart'],
  ['/network', 'Network', 'network'],
];

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function SearchOverlay({ onClose }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', esc);
      document.body.style.overflow = '';
    };
  }, [onClose]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="overlay-card">
        <SearchBox autoFocus inline placeholder="Search suburbs, outages or equipment" onDone={onClose} />
        <p className="small faint" style={{ margin: '10px 8px 2px' }}>Press <span className="kbd">Esc</span> to close</p>
      </div>
    </div>
  );
}

export default function Root() {
  const { dark, toggle } = useTheme();
  const { accounts } = useUtility();
  const [searching, setSearching] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onKey = (e) => {
      const typing = /input|textarea|select/i.test(document.activeElement?.tagName ?? '');
      if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        setSearching(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    setSearching(false);
  }, [pathname]);

  return (
    <>
      <a href="#main" className="skip">Skip to content</a>
      <ScrollToTop />
      <header className="site-header">
        <div className="container header-row">
          <Link to="/" className="brand" aria-label="GridWatch home">
            <span className="wordmark">GridWatch<i aria-hidden="true" /></span>
          </Link>
          <nav className="nav" aria-label="Main">
            {NAV.map(([to, label, , end]) => <NavLink key={to} to={to} end={end}>{label}</NavLink>)}
          </nav>
          <div className="header-actions">
            <MunicipalitySwitcher />
            <RefreshButton compact />
            <button className="icon-btn" onClick={() => setSearching(true)} aria-label="Search">
              <Icon name="search" /><span className="label">Search</span><span className="kbd">/</span>
            </button>
            <button className="icon-btn" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
              <Icon name={dark ? 'sun' : 'moon'} />
            </button>
          </div>
        </div>
      </header>

      <main id="main">
        <ErrorBoundary resetKey={pathname}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/outages" element={<Outages />} />
          <Route path="/outages/:id" element={<OutageDetail />} />
          <Route path="/planned" element={<Planned />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/suburb/:id" element={<Suburb />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/network" element={<Network />} />
          <Route path="/network/:id" element={<NodeDetail />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<div className="container page"><EmptyState icon="search" title="Page not found" action={<Link to="/" className="btn primary">Back to the overview</Link>}>That page doesn't exist.</EmptyState></div>} />
        </Routes>
        </ErrorBoundary>
      </main>

      <footer className="site-footer">
        <div className="container row">
          <p>GridWatch is an independent project. It reads each city's own public outage posts on X and may lag behind or contain mistakes. It is not affiliated with City Power, the City of Tshwane, or any other municipality or utility it covers.</p>
          <div className="row" style={{ gap: 18 }}>
            <Link to="/planned" className="link">Planned maintenance</Link>
            <Link to="/activity" className="link">What changed</Link>
            <Link to="/about" className="link">How it works</Link>
            {accounts.map((a) => <a key={a} className="link" href={`https://x.com/${a}`} target="_blank" rel="noreferrer">@{a} <Icon name="external" /></a>)}
            <OperatorSignIn />
          </div>
        </div>
      </footer>

      <nav className="mobile-nav" aria-label="Main">
        {NAV.map(([to, label, icon, end]) => (
          <NavLink key={to} to={to} end={end}><Icon name={icon} />{label}</NavLink>
        ))}
      </nav>

      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </>
  );
}
