import React, { useState } from 'react';
import { api, currentUser, setToken } from '../api.js';

export default function Login({ onLogin, notify }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const set = key => e => setForm({ ...form, [key]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'register') {
        await api('POST', '/auth/register', { name: form.name, email: form.email, password: form.password, phone: form.phone || null });
        notify('Welcome to RetailFlow! Check your inbox for a welcome email.');
      }
      const { token } = await api('POST', '/auth/login', { email: form.email, password: form.password });
      setToken(token);
      onLogin(currentUser());
    } catch (error) {
      notify(error.message, 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="login-page">
      <div className="login-hero">
        <div className="brand big"><span className="logo">R</span> RetailFlow</div>
        <h1>Desk gear and books, delivered.</h1>
        <p>Order in a couple of clicks, pay when the invoice arrives and follow your order until it's confirmed.</p>
        <div className="hero-points">
          <div><strong>Live order tracking</strong><span>See each step as it happens</span></div>
          <div><strong>Pay your way</strong><span>UPI, card or net banking</span></div>
          <div><strong>Instant updates</strong><span>Email and in-app notifications</span></div>
        </div>
      </div>
      <form className="card login-card" onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Create account</button>
        </div>
        {mode === 'register' && (<>
          <label>Full name<input required minLength={2} value={form.name} onChange={set('name')} placeholder="Asha Shah" /></label>
          <label>Phone <span className="muted">(optional)</span><input value={form.phone} onChange={set('phone')} placeholder="+91 98765 43210" /></label>
        </>)}
        <label>Email<input required type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" /></label>
        <label>Password<input required type="password" minLength={mode === 'register' ? 8 : 1} value={form.password} onChange={set('password')} placeholder={mode === 'register' ? 'At least 8 characters' : ''} /></label>
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <p className="hint">
          Store admin? Use <button type="button" className="link" onClick={() => { setMode('login'); setForm({ ...form, email: 'admin@example.com', password: 'Admin@12345' }); }}>admin@example.com</button>
        </p>
      </form>
    </div>
  );
}
