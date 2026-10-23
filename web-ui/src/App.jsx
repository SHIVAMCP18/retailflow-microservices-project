import React, { useCallback, useEffect, useState } from 'react';
import { api, currentUser, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Shop from './pages/Shop.jsx';
import Orders from './pages/Orders.jsx';
import Invoices from './pages/Invoices.jsx';
import Notifications from './pages/Notifications.jsx';
import Admin from './pages/Admin.jsx';
import Architecture from './pages/Architecture.jsx';
import ApiLog from './ApiLog.jsx';
import Icon from './Icon.jsx';

const PAGES = [
  { id: 'shop', label: 'Shop', icon: 'shop' },
  { id: 'orders', label: 'Orders', icon: 'orders' },
  { id: 'invoices', label: 'Invoices', icon: 'invoice' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'admin', label: 'Admin', icon: 'admin', admin: true },
  { id: 'architecture', label: 'System', icon: 'system' }
];

function useHashPage() {
  const read = () => window.location.hash.replace('#/', '').split('/') || ['shop'];
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [route, (page, param) => { window.location.hash = `#/${page}${param ? `/${param}` : ''}`; }];
}

export default function App() {
  const [user, setUser] = useState(currentUser);
  const [[page = 'shop', param], go] = useHashPage();
  const [toast, setToast] = useState(null);
  const [cart, setCart] = useState([]);
  const [unread, setUnread] = useState(0);

  const notify = useCallback((message, kind = 'ok') => {
    setToast({ message, kind });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const logout = () => { setToken(null); setUser(null); setCart([]); go('shop'); };

  // Poll the Notification Service for the bell badge.
  useEffect(() => {
    if (!user) return;
    let seen = Number(sessionStorage.getItem('rf_seen') || 0);
    const load = () => api('GET', '/notifications', null, { quiet: true })
      .then(list => setUnread(Math.max(0, list.length - seen)))
      .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    if (page === 'notifications') {
      api('GET', '/notifications', null, { quiet: true }).then(list => {
        seen = list.length; sessionStorage.setItem('rf_seen', String(seen)); setUnread(0);
      }).catch(() => {});
    }
    return () => clearInterval(timer);
  }, [user, page]);

  if (!user) return (<><Login onLogin={u => { setUser(u); go('shop'); }} notify={notify} /><Toast toast={toast} /></>);

  const visible = PAGES.filter(p => !p.admin || user.role === 'ADMIN');
  const active = visible.some(p => p.id === page) ? page : 'shop';

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><span className="logo">R</span> RetailFlow</div>
        <nav>
          {visible.map(p => (
            <a key={p.id} href={`#/${p.id}`} className={active === p.id ? 'active' : ''}>
              <Icon name={p.icon} /> {p.label}
              {p.id === 'notifications' && unread > 0 && <span className="badge">{unread}</span>}
              {p.id === 'shop' && cart.length > 0 && <span className="badge soft">{cart.reduce((n, l) => n + l.quantity, 0)}</span>}
            </a>
          ))}
        </nav>
        <div className="me">
          <div className="avatar">{user.name?.[0] || '?'}</div>
          <div>
            <strong>{user.name}</strong>
            <small>{user.role === 'ADMIN' ? 'Administrator' : 'Customer'}</small>
          </div>
          <button className="ghost icon-btn" onClick={logout} title="Sign out"><Icon name="logout" /></button>
        </div>
      </aside>

      <main className="content">
        {active === 'shop' && <Shop user={user} cart={cart} setCart={setCart} notify={notify} go={go} />}
        {active === 'orders' && <Orders user={user} selected={param} go={go} notify={notify} />}
        {active === 'invoices' && <Invoices user={user} notify={notify} go={go} />}
        {active === 'notifications' && <Notifications user={user} />}
        {active === 'admin' && <Admin notify={notify} />}
        {active === 'architecture' && <Architecture />}
      </main>

      <ApiLog />
      <Toast toast={toast} />
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return <div className={`toast ${toast.kind}`}>{toast.message}</div>;
}
