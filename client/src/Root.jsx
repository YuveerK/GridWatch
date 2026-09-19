import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import Icon from './components/Icon.jsx';
import SearchBox from './components/SearchBox.jsx';
import { EmptyState } from './components/ui.jsx';
import { useTheme } from './lib/hooks.js';
import About from './views/About.jsx';
import Network from './views/Network.jsx';
import NodeDetail from './views/NodeDetail.jsx';
import OutageDetail from './views/OutageDetail.jsx';
import Outages from './views/Outages.jsx';
import Overview from './views/Overview.jsx';
import Planned from './views/Planned.jsx';
import Suburb from './views/Suburb.jsx';

const NAV = [
  ['/', 'Overview', 'home', true],
  ['/outages', 'Outages', 'list'],
  ['/planned', 'Planned', 'calendar'],
  ['/network', 'Network', 'network'],
  ['/about', 'About', 'info'],
];

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => window.scrollTo(0, 0), [pathname]);
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
  useEffect(() => setSearching(false), [pathname]);

  return (
    <>
      <a href="#main" className="skip">Skip to content</a>
      <ScrollToTop />
      <header className="site-header">
        <div className="container header-row">
          <Link to="/" className="brand" aria-label="GridWatch home">
            <span className="brand-mark"><Icon name="bolt" /></span>
            <span>GridWatch<small>Johannesburg</small></span>
          </Link>
          <nav className="nav" aria-label="Main">
            {NAV.map(([to, label, , end]) => <NavLink key={to} to={to} end={end}>{label}</NavLink>)}
          </nav>
          <div className="header-actions">
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
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/outages" element={<Outages />} />
          <Route path="/outages/:id" element={<OutageDetail />} />
          <Route path="/planned" element={<Planned />} />
          <Route path="/suburb/:id" element={<Suburb />} />
          <Route path="/network" element={<Network />} />
          <Route path="/network/:id" element={<NodeDetail />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<div className="container page"><EmptyState icon="search" title="Page not found" action={<Link to="/" className="btn primary">Back to the overview</Link>}>That page doesn't exist.</EmptyState></div>} />
        </Routes>
      </main>

      <footer className="site-footer">
        <div className="container row">
          <p>GridWatch is an independent project. It reads City Power's public posts on X (@CityPowerJhb) and may lag behind or contain mistakes. It is not affiliated with City Power.</p>
          <div className="row" style={{ gap: 18 }}>
            <Link to="/about" className="link">How it works</Link>
            <a className="link" href="https://x.com/CityPowerJhb" target="_blank" rel="noreferrer">@CityPowerJhb <Icon name="external" /></a>
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
