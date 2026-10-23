import React, { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { StatusPill } from './Orders.jsx';

export default function Admin({ notify }) {
  const [tab, setTab] = useState('products');
  return (
    <div>
      <header className="page-head">
        <div><h1>Admin</h1><p className="muted">Manage products, orders and customers</p></div>
        <div className="tabs inline">
          {['products', 'orders', 'customers'].map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
      </header>
      {tab === 'products' && <Products notify={notify} />}
      {tab === 'orders' && <AllOrders notify={notify} />}
      {tab === 'customers' && <Customers notify={notify} />}
    </div>
  );
}

function Products({ notify }) {
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState({ name: '', price: '', stock: '', category: 'Electronics' });
  const load = () => api('GET', '/products').then(setProducts).catch(e => notify(e.message, 'error'));
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    try {
      const p = await api('POST', '/products', { name: form.name, price: Number(form.price), stock: Number(form.stock), category: form.category });
      notify(`${p.name} added`);
      setForm({ ...form, name: '', price: '', stock: '' });
      load();
    } catch (error) { notify(error.message, 'error'); }
  }

  async function restock(p) {
    const stock = Number(prompt(`New stock for "${p.name}"`, p.stock));
    if (!Number.isInteger(stock) || stock < 0) return;
    try { await api('PATCH', `/products/${p.id}/stock`, { stock }); load(); }
    catch (error) { notify(error.message, 'error'); }
  }

  return (
    <div className="admin-grid">
      <form className="card" onSubmit={create}>
        <h2>Add a product</h2>
        <label>Name<input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <div className="row">
          <label>Price (INR)<input required type="number" min="0" step="0.01" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} /></label>
          <label>Stock<input required type="number" min="0" step="1" value={form.stock} onChange={e => setForm({ ...form, stock: e.target.value })} /></label>
        </div>
        <label>Category<input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} list="categories" /></label>
        <datalist id="categories">{[...new Set(products.map(p => p.category))].map(c => <option key={c} value={c} />)}</datalist>
        <button className="primary">Add product</button>
      </form>
      <div className="card table-card">
        <table className="table">
          <thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th /></tr></thead>
          <tbody>
            {products.map(p => (
              <tr key={p.id}>
                <td>{p.id}</td><td>{p.name}</td><td>{p.category}</td><td>{money(p.price)}</td>
                <td><span className={p.stock > 0 ? (p.stock < 5 ? 'stock low' : 'stock') : 'stock out'}>{p.stock}</span></td>
                <td><button className="ghost small" onClick={() => restock(p)}>Edit stock</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AllOrders({ notify }) {
  const [orders, setOrders] = useState([]);
  useEffect(() => { api('GET', '/orders').then(setOrders).catch(e => notify(e.message, 'error')); }, []);
  const revenue = orders.filter(o => o.status === 'PAID').reduce((sum, o) => sum + Number(o.total), 0);
  return (
    <>
      <div className="stats">
        <div className="card stat"><small>Orders</small><strong>{orders.length}</strong></div>
        <div className="card stat"><small>Paid</small><strong>{orders.filter(o => o.status === 'PAID').length}</strong></div>
        <div className="card stat"><small>Awaiting payment</small><strong>{orders.filter(o => o.status !== 'PAID').length}</strong></div>
        <div className="card stat"><small>Revenue</small><strong>{money(revenue)}</strong></div>
      </div>
      <div className="card table-card">
        <table className="table">
          <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Invoice</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.orderId}>
                <td><a href={`#/orders/${o.orderId}`}>#{o.orderId.slice(0, 8)}</a></td>
                <td>{o.customerName}</td><td>{o.items.reduce((n, i) => n + i.quantity, 0)}</td>
                <td>{money(o.total, o.currency)}</td><td className="mono">{o.invoiceId || ''}</td>
                <td><StatusPill status={o.status} /></td><td className="muted">{new Date(o.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Customers({ notify }) {
  const [customers, setCustomers] = useState([]);
  useEffect(() => { api('GET', '/customers').then(setCustomers).catch(e => notify(e.message, 'error')); }, []);
  return (
    <div className="card table-card">
      <table className="table">
        <thead><tr><th>Name</th><th>E-mail</th><th>Phone</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead>
        <tbody>
          {customers.map(c => (
            <tr key={c.id}>
              <td>{c.name}</td><td>{c.email}</td><td>{c.phone || ''}</td>
              <td><span className="tag">{c.role}</span></td><td><StatusPill status={c.status} /></td>
              <td className="muted">{new Date(c.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
