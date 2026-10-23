// Product Service (Node.js + PostgreSQL)
// REST: catalogue and categories for the gateway.  gRPC: ReserveStock for Order Service.
import express from 'express';
import pg from 'pg';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import client from 'prom-client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { log, requireRole, registerWithConsul } from './platform.js';

const HTTP_PORT = Number(process.env.PORT || 3001);
const GRPC_PORT = Number(process.env.GRPC_PORT || 50051);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ---------- Prometheus metrics ----------
client.collectDefaultMetrics();
const httpRequests = new client.Counter({ name: 'http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'status'] });
const reservations = new client.Counter({ name: 'stock_reservations_total', help: 'gRPC stock reservations', labelNames: ['result'] });

async function initialise() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category_id INT REFERENCES categories(id),
      price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
      stock INT NOT NULL CHECK (stock >= 0)
    );
    CREATE TABLE IF NOT EXISTS stock_reservations (
      order_id TEXT NOT NULL, product_id INT NOT NULL REFERENCES products(id), quantity INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (order_id, product_id)
    );`);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  if (!rows[0].n) {
    await pool.query("INSERT INTO categories(name) VALUES ('Electronics'), ('Books') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO products(name, category_id, price, stock) VALUES
      ('Wireless keyboard', 1, 1499, 25), ('Noise-cancelling headset', 1, 3999, 10), ('Microservices Patterns (book)', 2, 799, 5)`);
  }
}

// ---------- REST API ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.on('finish', () => httpRequests.inc({ method: req.method, route: req.route?.path || 'unmatched', status: res.statusCode }));
  next();
});
const asyncRoute = fn => (req, res) => fn(req, res).catch(error => {
  log.error({ err: error.message, requestId: req.get('x-request-id') }, 'request failed');
  res.status(500).json({ error: 'Internal error' });
});

app.get('/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'UP', service: 'product-service' }); }
  catch { res.status(503).json({ status: 'DOWN' }); }
});
app.get('/metrics', async (_, res) => res.type(client.register.contentType).send(await client.register.metrics()));

const PRODUCT_SQL = `SELECT p.id, p.name, p.price::float AS price, p.stock, c.name AS category
                     FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

app.get('/products', requireRole('CUSTOMER', 'ADMIN'), asyncRoute(async (req, res) => {
  const filter = req.query.category ? ' WHERE c.name = $1' : '';
  const { rows } = await pool.query(`${PRODUCT_SQL}${filter} ORDER BY p.id`, req.query.category ? [req.query.category] : []);
  res.json(rows);
}));
app.get('/products/:id', requireRole('CUSTOMER', 'ADMIN'), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`${PRODUCT_SQL} WHERE p.id = $1`, [Number(req.params.id) || 0]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Product not found' });
}));
app.post('/products', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { name, price, stock, category } = req.body;
  if (!name || !(Number(price) >= 0) || !Number.isInteger(stock) || stock < 0)
    return res.status(400).json({ error: 'name, price >= 0 and integer stock >= 0 are required' });
  const categoryId = category
    ? (await pool.query('INSERT INTO categories(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id', [category])).rows[0].id
    : null;
  const { rows } = await pool.query('INSERT INTO products(name, category_id, price, stock) VALUES ($1,$2,$3,$4) RETURNING id', [name, categoryId, price, stock]);
  log.info({ productId: rows[0].id, requestId: req.get('x-request-id') }, 'product.created');
  res.status(201).json((await pool.query(`${PRODUCT_SQL} WHERE p.id = $1`, [rows[0].id])).rows[0]);
}));
app.patch('/products/:id/stock', requireRole('ADMIN'), asyncRoute(async (req, res) => {
  const { rows } = await pool.query('UPDATE products SET stock = $1 WHERE id = $2 RETURNING id, stock', [req.body.stock, Number(req.params.id) || 0]);
  rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Product not found' });
}));
app.get('/categories', requireRole('CUSTOMER', 'ADMIN'), asyncRoute(async (_, res) => {
  res.json((await pool.query('SELECT id, name FROM categories ORDER BY id')).rows);
}));

// ---------- gRPC: ReserveStock (ACID transaction in PostgreSQL) ----------
async function reserveStock(orderId, items) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const done = await db.query('SELECT 1 FROM stock_reservations WHERE order_id = $1 LIMIT 1', [orderId]);
    const lines = [];
    for (const item of items) {
      // Row lock: two concurrent orders cannot both take the last unit.
      const { rows } = await db.query('SELECT id, name, price::float AS price, stock FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
      const product = rows[0];
      if (!product) throw new Error(`Product ${item.product_id} does not exist`);
      if (!done.rowCount) {
        if (product.stock < item.quantity) throw new Error(`Insufficient stock for "${product.name}" (available ${product.stock})`);
        await db.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, product.id]);
        await db.query('INSERT INTO stock_reservations(order_id, product_id, quantity) VALUES ($1,$2,$3)', [orderId, product.id, item.quantity]);
      }
      lines.push({ product_id: product.id, name: product.name, unit_price: product.price, quantity: item.quantity });
    }
    await db.query('COMMIT');   // all lines reserved, or none
    return { success: true, message: done.rowCount ? 'Already reserved' : 'Stock reserved', lines };
  } catch (error) {
    await db.query('ROLLBACK');
    return { success: false, message: error.message, lines: [] };
  } finally { db.release(); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const definition = protoLoader.loadSync(path.join(here, '../proto/product.proto'), { keepCase: true, longs: Number });
const proto = grpc.loadPackageDefinition(definition).product;
const grpcServer = new grpc.Server();
grpcServer.addService(proto.ProductStock.service, {
  ReserveStock: async (call, callback) => {
    const requestId = call.metadata.get('x-request-id')[0];
    const reply = await reserveStock(call.request.order_id, call.request.items);
    reservations.inc({ result: reply.success ? 'reserved' : 'rejected' });
    log.info({ orderId: call.request.order_id, success: reply.success, message: reply.message, requestId }, 'grpc.ReserveStock');
    callback(null, reply);
  }
});

initialise().then(() => {
  app.listen(HTTP_PORT, () => log.info({ port: HTTP_PORT }, 'http started'));
  grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), error => {
    if (error) throw error;
    log.info({ port: GRPC_PORT }, 'grpc started');
  });
  registerWithConsul({ name: 'product-service', port: HTTP_PORT, meta: { grpc_port: String(GRPC_PORT) } });
}).catch(error => { log.error({ err: error.message }, 'startup failed'); process.exit(1); });
