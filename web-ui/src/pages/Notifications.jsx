import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from '../Icon.jsx';

const CHANNELS = { IN_APP: 'In-app', EMAIL: 'Email', SMS: 'SMS' };

export default function Notifications({ user }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    const load = () => api('GET', '/notifications').then(setItems).catch(() => setItems([]));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <header className="page-head">
        <div><h1>Notifications</h1><p className="muted">Emails can be viewed in the <a href="http://localhost:8025" target="_blank" rel="noreferrer">test inbox</a></p></div>
      </header>
      {items && items.length === 0 && <div className="card empty">You're all caught up.</div>}
      <div className="list">
        {(items || []).map(n => (
          <div key={n.id} className="card notification">
            <div className="n-icon"><Icon name="bell" /></div>
            <div className="grow">
              <div className="row between"><strong>{n.subject}</strong><small className="muted">{new Date(n.createdAt).toLocaleString()}</small></div>
              <p>{n.message}</p>
              <div className="row">
                {n.channels.map(c => <span key={c} className="tag">{CHANNELS[c] || c}</span>)}
                {user.role === 'ADMIN' && <small className="muted">Customer {n.customerId.slice(0, 8)}</small>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
