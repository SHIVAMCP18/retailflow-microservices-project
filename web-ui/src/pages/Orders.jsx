import React, { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import Icon from '../Icon.jsx';

// Each step is filled in when the matching event reaches the order's read model.
const STEPS = [
  { event: 'order.created', title: 'Order received', detail: 'We have your order and reserved the items.' },
  { event: 'invoice.created', title: 'Invoice issued', detail: 'Your invoice is ready to pay.' },
  { event: 'payment.completed', title: 'Payment received', detail: 'Thanks, your payment went through.' },
  { event: 'order.paid', title: 'Order confirmed', detail: 'Your order is confirmed and will ship soon.' }
];

export default function Orders({ user, selected, go, notify }) {
  const [orders, setOrders] = useState(null);
  useEffect(() => { api('GET', '/orders').then(setOrders).catch(e => { notify(e.message, 'error'); setOrders([]); }); }, [selected]);

  if (selected) return <OrderDetail id={selected} go={go} notify={notify} user={user} />;

  return (
    <div>
      <header className="page-head">
        <div><h1>{user.role === 'ADMIN' ? 'All orders' : 'Your orders'}</h1>
          <p className="muted">{orders ? `${orders.length} order${orders.length === 1 ? '' : 's'}` : 'Loading…'}</p></div>
      </header>
      {orders && orders.length === 0 && <div className="card empty">You haven't ordered anything yet. <a href="#/shop">Browse the shop</a></div>}
      <div className="list">
        {(orders || []).map(o => (
          <button key={o.orderId} className="card list-row" onClick={() => go('orders', o.orderId)}>
            <div><strong>#{o.orderId.slice(0, 8)}</strong><small className="muted">{new Date(o.createdAt).toLocaleString()}</small></div>
            <div className="muted">{o.items.length} item{o.items.length === 1 ? '' : 's'}{user.role === 'ADMIN' ? ` · ${o.customerName}` : ''}</div>
            <strong>{money(o.total, o.currency)}</strong>
            <StatusPill status={o.status} />
          </button>
        ))}
      </div>
    </div>
  );
}

function OrderDetail({ id, go, notify }) {
  const placed = JSON.parse(sessionStorage.getItem(`rf_order_${id}`) || 'null');
  const [order, setOrder] = useState(null);
  const [waiting, setWaiting] = useState(true);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const view = await api('GET', `/orders/${id}`, null, { quiet: true });
        if (!stop) { setOrder(view); setWaiting(false); }
        if (view.status === 'PAID') return;
      } catch (error) {
        if (error.status !== 404) { notify(error.message, 'error'); return; }
      }
      if (!stop) setTimeout(poll, 1200);
    };
    poll();
    return () => { stop = true; };
  }, [id]);

  async function pay(method) {
    setPaying(true);
    try {
      await api('POST', `/billing/invoices/${order.invoiceId}/pay`, { method });
      notify('Payment successful');
      setOrder({ ...order });
    } catch (error) { notify(error.message, 'error'); }
    finally { setPaying(false); }
  }

  const view = order || (placed && { ...placed, history: [], invoiceId: null, paymentStatus: null });
  const done = new Set((order?.history || []).map(h => h.event));
  const at = event => order?.history?.find(h => h.event === event)?.at;

  return (
    <div>
      <header className="page-head">
        <div><button className="link back" onClick={() => go('orders')}><Icon name="arrowLeft" size={16} /> All orders</button>
          <h1>Order #{id.slice(0, 8)}</h1></div>
        {view && <StatusPill status={view.status} />}
      </header>

      {waiting && (
        <div className="card notice"><span className="spinner" /> Processing your order…</div>
      )}

      <div className="detail">
        <div className="card">
          <h2>Progress</h2>
          <ol className="timeline">
            {STEPS.map(step => (
              <li key={step.event} className={done.has(step.event) ? 'done' : ''}>
                <span className="dot">{done.has(step.event) && <Icon name="check" size={15} />}</span>
                <div>
                  <strong>{step.title}</strong>
                  {at(step.event) && <small className="muted"> · {new Date(at(step.event)).toLocaleTimeString()}</small>}
                  <p className="muted small" title={`Event: ${step.event}`}>{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          {order?.invoiceId && order.paymentStatus !== 'PAID' && (
            <div className="pay-box">
              <div><strong>Invoice {order.invoiceId}</strong><small className="muted">Choose how you'd like to pay</small></div>
              <div className="row">
                {['UPI', 'CARD', 'NETBANKING'].map(m => <button key={m} className="primary" disabled={paying} onClick={() => pay(m)}>{m === 'NETBANKING' ? 'Net banking' : m === 'CARD' ? 'Card' : 'UPI'}</button>)}
              </div>
            </div>
          )}
        </div>

        {view && (
          <div className="card">
            <h2>Items</h2>
            {view.items.map(item => (
              <div key={item.productId} className="row between item-line">
                <span>{item.name} <span className="muted">x{item.quantity}</span></span><span>{money(item.unitPrice * item.quantity)}</span>
              </div>
            ))}
            <div className="row between total"><span>Total</span><strong>{money(view.total, view.currency)}</strong></div>
            <dl className="meta">
              <dt>Customer</dt><dd>{view.customerName}</dd>
              <dt>Invoice</dt><dd>{view.invoiceId || 'Pending'}</dd>
              <dt>Payment</dt><dd>{view.paymentStatus === 'PAID' ? 'Paid' : view.paymentStatus === 'UNPAID' ? 'Awaiting payment' : 'Pending'}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

export function StatusPill({ status }) {
  const labels = { PENDING_PAYMENT: 'Awaiting payment', PAID: 'Paid', UNPAID: 'Unpaid', CANCELLED: 'Cancelled' };
  return <span className={`pill ${String(status).toLowerCase()}`}>{labels[status] || status}</span>;
}
