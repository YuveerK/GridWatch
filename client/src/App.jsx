import { Link, NavLink, Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import Infrastructure from './pages/Infrastructure.jsx';
import NodeDetail from './pages/NodeDetail.jsx';
import OutageDetail from './pages/OutageDetail.jsx';
import Suburb from './pages/Suburb.jsx';

export default function App() {
  return (
    <>
      <header className="topbar">
        <div className="wrap topbar-inner">
          <Link to="/" className="brand">
            <span aria-hidden="true">⚡</span> GridWatch
          </Link>
          <nav>
            <NavLink to="/" end>Outages</NavLink>
            <NavLink to="/infrastructure">Infrastructure</NavLink>
          </nav>
        </div>
      </header>
      <main className="wrap">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/outages/:id" element={<OutageDetail />} />
          <Route path="/suburb/:id" element={<Suburb />} />
          <Route path="/infrastructure" element={<Infrastructure />} />
          <Route path="/infrastructure/:id" element={<NodeDetail />} />
          <Route path="*" element={<p className="empty">Page not found.</p>} />
        </Routes>
      </main>
      <footer className="wrap footer">
        Unofficial. Built from City Power's public posts on X (@CityPowerJhb); details may lag or be wrong.
      </footer>
    </>
  );
}
