// Cross-cutting concerns: JSON logging, JWT authorisation, Consul registration.
import fs from 'node:fs';
import os from 'node:os';
import jwt from 'jsonwebtoken';
import pino from 'pino';

export const log = pino({ base: { service: 'product-service' }, timestamp: pino.stdTimeFunctions.isoTime });

const publicKey = fs.readFileSync(process.env.JWT_PUBLIC_KEY_FILE || '/run/secrets/jwt_public_key');

// Kong already rejected requests without a valid token. Each service checks the
// signature again (zero trust) and enforces the role required by the endpoint.
export const requireRole = (...roles) => (req, res, next) => {
  try {
    const token = (req.get('authorization') || '').replace(/^Bearer /, '');
    req.user = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: 'retailflow-customer-service' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: `Requires role ${roles.join(' or ')}` });
    next();
  } catch { res.status(401).json({ error: 'Invalid or missing token' }); }
};

function ownAddress() {
  if (process.env.POD_IP) return process.env.POD_IP;
  for (const nets of Object.values(os.networkInterfaces()))
    for (const net of nets || []) if (net.family === 'IPv4' && !net.internal) return net.address;
  return os.hostname();
}

// Self-registration: the service tells Consul where it is and how to health-check it.
// Re-registering every 30 s is idempotent and survives a Consul restart.
export function registerWithConsul({ name, port, meta = {} }) {
  const consul = process.env.CONSUL_HTTP_ADDR || 'http://consul:8500';
  const address = ownAddress();
  const id = `${name}-${os.hostname()}`;
  const body = {
    ID: id, Name: name, Address: address, Port: port, Tags: ['nodejs'], Meta: { metrics_path: '/metrics', ...meta },
    Check: { HTTP: `http://${address}:${port}/health`, Interval: '10s', Timeout: '3s', DeregisterCriticalServiceAfter: '1m' }
  };
  const register = () => fetch(`${consul}/v1/agent/service/register`, { method: 'PUT', body: JSON.stringify(body) })
    .then(r => r.ok || log.warn({ status: r.status }, 'consul registration rejected'))
    .catch(error => log.warn({ err: error.message }, 'consul unavailable, will retry'));
  register();
  setInterval(register, 30000).unref();
  const deregister = () => fetch(`${consul}/v1/agent/service/deregister/${id}`, { method: 'PUT' }).finally(() => process.exit(0));
  process.once('SIGTERM', deregister);
  process.once('SIGINT', deregister);
}
