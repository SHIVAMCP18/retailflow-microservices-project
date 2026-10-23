import React, { useEffect, useState } from 'react';
import { apiLog, onApiLog } from './api.js';

// Live list of the REST calls the website made through Kong, with the service
// that answered and the X-Request-ID you can search for in Grafana logs.
export default function ApiLog() {
  const [entries, setEntries] = useState([...apiLog]);
  const [open, setOpen] = useState(false);
  useEffect(() => onApiLog(setEntries), []);

  return (
    <section className={`apilog ${open ? 'open' : ''}`}>
      <button className="apilog-toggle" onClick={() => setOpen(!open)}>
        <span className="pulse" /> Request log <span className="muted">· {entries.length} calls through the gateway</span><span className="chev">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="apilog-body">
          {entries.length === 0 && <p className="muted">Nothing yet.</p>}
          <table>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td className="mono">{e.at.toLocaleTimeString()}</td>
                  <td><span className={`method ${e.method}`}>{e.method}</span></td>
                  <td className="mono">{e.path}</td>
                  <td><span className={`status s${String(e.status)[0]}`}>{e.status}</span></td>
                  <td>{e.ms} ms</td>
                  <td><strong>{e.service.name}</strong> <span className="muted">{e.service.tech}</span></td>
                  <td className="mono muted" title="X-Request-ID - search it in Grafana logs">{e.id.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
