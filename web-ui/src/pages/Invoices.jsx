import React, { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { StatusPill } from './Orders.jsx';
import Icon from '../Icon.jsx';

export default function Invoices({ user, notify, go }) {
  const [invoices, setInvoices] = useState(null);
  const load = () => api('GET', '/billing/invoices').then(setInvoices).catch(e => { notify(e.message, 'error'); setInvoices([]); });
  useEffect(() => { load(); }, []);

  async function pay(invoice) {
    try {
      await api('POST', `/billing/invoices/${invoice.invoiceId}/pay`, { method: 'UPI' });
      notify('Payment successful');
      load();
    } catch (error) { notify(error.message, 'error'); }
  }

  return (
    <div>
      <header className="page-head">
        <div><h1>Invoices</h1><p className="muted">One invoice per order</p></div>
        <button className="ghost row" onClick={load}><Icon name="refresh" size={16} /> Refresh</button>
      </header>
      {invoices && invoices.length === 0 && <div className="card empty">No invoices yet.</div>}
      <div className="card table-card">
        <table className="table">
          <thead><tr><th>Invoice</th><th>Order</th>{user.role === 'ADMIN' && <th>Customer</th>}<th>Amount</th><th>Status</th><th>Paid</th><th /></tr></thead>
          <tbody>
            {(invoices || []).map(i => (
              <tr key={i.invoiceId}>
                <td className="mono">{i.invoiceId}</td>
                <td><button className="link" onClick={() => go('orders', i.orderId)}>#{i.orderId.slice(0, 8)}</button></td>
                {user.role === 'ADMIN' && <td>{i.customerEmail}</td>}
                <td>{money(i.amount, i.currency)}</td>
                <td><StatusPill status={i.status} /></td>
                <td className="muted">{i.paidAt ? `${new Date(i.paidAt).toLocaleString()} via ${i.paymentMethod}` : ''}</td>
                <td>{i.status === 'UNPAID' && <button className="primary small" onClick={() => pay(i)}>Pay</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
