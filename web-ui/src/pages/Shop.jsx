import React, { useEffect, useMemo, useState } from 'react';
import { api, money } from '../api.js';
import Icon from '../Icon.jsx';

// A coloured tile with the product's initials stands in for a product photo.
const TONES = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e'];
function ProductArt({ product }) {
  const initials = product.name.split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const tone = TONES[product.id % TONES.length];
  return <div className="product-art" style={{ '--tone': tone }}><span>{initials}</span></div>;
}

export default function Shop({ cart, setCart, notify, go }) {
  const [products, setProducts] = useState(null);
  const [category, setCategory] = useState('All');
  const [placing, setPlacing] = useState(false);

  const load = () => api('GET', '/products').then(setProducts).catch(e => { notify(e.message, 'error'); setProducts([]); });
  useEffect(() => { load(); }, []);

  const categories = useMemo(() => ['All', ...new Set((products || []).map(p => p.category).filter(Boolean))], [products]);
  const shown = (products || []).filter(p => category === 'All' || p.category === category);
  const total = cart.reduce((sum, l) => sum + l.product.price * l.quantity, 0);

  function add(product) {
    const line = cart.find(l => l.product.id === product.id);
    if ((line ? line.quantity : 0) >= product.stock) return notify(`Sorry, only ${product.stock} left in stock`, 'error');
    setCart(line ? cart.map(l => l === line ? { ...l, quantity: l.quantity + 1 } : l) : [...cart, { product, quantity: 1 }]);
  }
  const change = (line, delta) => setCart(cart.map(l => l === line ? { ...l, quantity: l.quantity + delta } : l).filter(l => l.quantity > 0));

  async function checkout() {
    setPlacing(true);
    try {
      const order = await api('POST', '/orders', { items: cart.map(l => ({ productId: l.product.id, quantity: l.quantity })) });
      sessionStorage.setItem(`rf_order_${order.orderId}`, JSON.stringify(order));
      setCart([]);
      notify('Order placed');
      go('orders', order.orderId);
    } catch (error) {
      notify(error.message, 'error');
      if (error.status === 409) load();
    } finally { setPlacing(false); }
  }

  return (
    <div className="shop">
      <div>
        <header className="page-head">
          <div><h1>Shop</h1><p className="muted">{products ? `${shown.length} product${shown.length === 1 ? '' : 's'}` : 'Loading…'}</p></div>
          <div className="chips">
            {categories.map(c => <button key={c} className={c === category ? 'chip active' : 'chip'} onClick={() => setCategory(c)}>{c}</button>)}
          </div>
        </header>
        {!products && <div className="grid">{[1, 2, 3].map(i => <div key={i} className="card skeleton" />)}</div>}
        <div className="grid">
          {shown.map(p => (
            <div key={p.id} className="card product">
              <ProductArt product={p} />
              <span className="tag">{p.category || 'General'}</span>
              <h3>{p.name}</h3>
              <div className="row between">
                <strong className="price">{money(p.price)}</strong>
                <span className={p.stock > 0 ? (p.stock < 5 ? 'stock low' : 'stock') : 'stock out'}>
                  {p.stock > 0 ? (p.stock < 5 ? `Only ${p.stock} left` : 'In stock') : 'Out of stock'}
                </span>
              </div>
              <button className="primary" disabled={p.stock < 1} onClick={() => add(p)}>Add to cart</button>
            </div>
          ))}
        </div>
      </div>

      <aside className="card cart">
        <h2>Your cart</h2>
        {cart.length === 0 && <p className="muted">Nothing here yet.</p>}
        {cart.map(line => (
          <div key={line.product.id} className="cart-line">
            <div><strong>{line.product.name}</strong><small className="muted">{money(line.product.price)}</small></div>
            <div className="qty">
              <button aria-label="Remove one" onClick={() => change(line, -1)}><Icon name="minus" size={14} /></button><span>{line.quantity}</span>
              <button aria-label="Add one" onClick={() => line.quantity < line.product.stock ? change(line, 1) : notify('No more stock', 'error')}><Icon name="plus" size={14} /></button>
            </div>
          </div>
        ))}
        {cart.length > 0 && (<>
          <div className="row between total"><span>Total</span><strong>{money(total)}</strong></div>
          <button className="primary wide" disabled={placing} onClick={checkout}>{placing ? 'Placing order…' : 'Place order'}</button>
          <p className="muted small">You'll get an invoice right after ordering.</p>
        </>)}
      </aside>
    </div>
  );
}
