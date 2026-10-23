// Thin client for the Kong gateway. Every call goes through Kong (same origin),
// carries the JWT and an X-Request-ID, and is recorded in the live API log.

export const SERVICES = {
  '/auth': { name: 'Customer', tech: 'Python · MongoDB' },
  '/customers': { name: 'Customer', tech: 'Python · MongoDB' },
  '/products': { name: 'Product', tech: 'Node.js · PostgreSQL' },
  '/categories': { name: 'Product', tech: 'Node.js · PostgreSQL' },
  '/orders': { name: 'Order', tech: 'Java · MySQL' },
  '/billing': { name: 'Billing', tech: 'Go · SQLite' },
  '/notifications': { name: 'Notification', tech: 'C# · Redis' }
};

export function serviceFor(path) {
  const key = Object.keys(SERVICES).find(prefix => path.startsWith(prefix));
  return key ? SERVICES[key] : { name: 'Gateway', tech: 'Kong' };
}

let token = sessionStorage.getItem('rf_token');
const listeners = new Set();
export const apiLog = [];

export function onApiLog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setToken(value) {
  token = value;
  value ? sessionStorage.setItem('rf_token', value) : sessionStorage.removeItem('rf_token');
}

export function currentUser() {
  if (!token) return null;
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (claims.exp * 1000 < Date.now()) { setToken(null); return null; }
    return { id: claims.sub, name: claims.name, email: claims.email, role: claims.role };
  } catch { return null; }
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body, { quiet = false } = {}) {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  const response = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!quiet) {
    apiLog.unshift({ id: requestId, method, path, status: response.status, ms: Math.round(performance.now() - started), service: serviceFor(path), at: new Date() });
    apiLog.length = Math.min(apiLog.length, 50);
    listeners.forEach(listener => listener([...apiLog]));
  }
  if (!response.ok) {
    const message = data?.error || data?.detail?.[0]?.msg || data?.detail || data?.message || `Request failed (${response.status})`;
    throw new ApiError(response.status, typeof message === 'string' ? message : JSON.stringify(message));
  }
  return data;
}

export const money = (amount, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount || 0));
