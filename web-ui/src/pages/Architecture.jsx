import React from 'react';
import Icon from '../Icon.jsx';

const SERVICES = [
  { name: 'Customer', lang: 'Python, FastAPI', db: 'MongoDB', role: 'Accounts and sign-in (issues JWTs)' },
  { name: 'Product', lang: 'Node.js, Express', db: 'PostgreSQL', role: 'Catalogue and stock, gRPC server' },
  { name: 'Order', lang: 'Java, Spring Boot', db: 'MySQL', role: 'Orders, outbox, order read model' },
  { name: 'Billing', lang: 'Go', db: 'SQLite', role: 'Invoices and payments' },
  { name: 'Notification', lang: 'C#, ASP.NET Core', db: 'Redis', role: 'Email, SMS and in-app messages' }
];

const TOOLS = [
  { name: 'Consul', url: 'http://localhost:8500', what: 'Registered services and health checks' },
  { name: 'RabbitMQ', url: 'http://localhost:15672', what: 'Event exchange, queues, dead-letter queues' },
  { name: 'Grafana', url: 'http://localhost:3000', what: 'Metrics dashboard and logs' },
  { name: 'Prometheus', url: 'http://localhost:9090/targets', what: 'Scrape targets and alert rules' },
  { name: 'Mailpit', url: 'http://localhost:8025', what: 'Test inbox for outgoing email' }
];

const PATTERNS = [
  ['API gateway', 'Kong handles HTTPS, checks the JWT, rate-limits requests and tags each one with a request ID.'],
  ['Service discovery', 'Every service registers itself in Consul. Kong and the Order service find instances there.'],
  ['Synchronous calls', 'REST from Order to Customer, gRPC from Order to Product to reserve stock.'],
  ['Asynchronous events', 'A RabbitMQ topic exchange carries order, invoice and payment events, with retries and dead-letter queues.'],
  ['Outbox and CDC', 'An order and its event are saved in one MySQL transaction. Debezium reads the binlog and publishes the event.'],
  ['CQRS', 'Orders are written to one set of tables and read from a separate view that is built from events.'],
  ['ACID and BASE', 'Each service commits its own data atomically. Across services the data becomes consistent through events.'],
  ['Circuit breakers', 'Resilience4j protects the Order service’s outgoing calls and Polly protects email sending.'],
  ['Security', 'HTTPS, RS256 tokens, role checks in every service, separate database users and network policies.'],
  ['Kubernetes', 'Manifests in k8s/ with StatefulSets, a sidecar pod, probes, autoscaling, secrets and network policies.']
];

export default function Architecture() {
  return (
    <div>
      <header className="page-head">
        <div><h1>System</h1><p className="muted">How the store is put together</p></div>
      </header>

      <div className="card arch">
        <div className="node client">Browser</div>
        <div className="link-line"><span>HTTPS with JWT</span></div>
        <div className="arch-row"><div className="node gateway">Kong API gateway</div><div className="node side">Consul</div></div>
        <div className="link-line"><span>REST</span></div>
        <div className="arch-row services">
          {SERVICES.map(s => (
            <div key={s.name} className="node service">
              <strong>{s.name}</strong><small>{s.lang}</small>
              <span className="db">{s.db}</span><p className="muted small">{s.role}</p>
            </div>
          ))}
        </div>
        <div className="link-line"><span>Events (via Debezium and service outboxes)</span></div>
        <div className="node broker">RabbitMQ topic exchange</div>
        <div className="link-line"><span>Metrics and logs</span></div>
        <div className="node side">Prometheus, Grafana, Loki</div>
      </div>

      <h2 className="section">Patterns</h2>
      <div className="patterns">
        {PATTERNS.map(([title, text]) => <div key={title} className="card pattern"><strong>{title}</strong><p className="muted small">{text}</p></div>)}
      </div>

      <h2 className="section">Dashboards</h2>
      <div className="patterns">
        {TOOLS.map(t => (
          <a key={t.name} className="card pattern tool" href={t.url} target="_blank" rel="noreferrer">
            <strong className="row">{t.name} <Icon name="external" size={14} /></strong><p className="muted small">{t.what}</p><code>{t.url}</code>
          </a>
        ))}
      </div>
    </div>
  );
}
