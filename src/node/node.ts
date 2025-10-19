import express from 'express';
import { PING_INTERVAL_MS } from './const.js';

export interface NodeConfig {
  port: number;
  bootstrap?: string[];
}

export class CebularzNode {
  private app = express();
  private port: number;
  private peers: Set<string> = new Set();
  private pingTimer?: NodeJS.Timeout;

  private bootstrap: string[] = [];

  constructor(cfg: NodeConfig) {
    this.port = cfg.port;
    this.bootstrap = cfg.bootstrap ?? [];
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.use(express.json());

    this.app.post('/register', (req, res) => {
      const { url } = req.body || {};
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url required' });
      }
      const requester = url;
      const responder = `http://localhost:${this.port}`;
      this.peers.add(requester);
      res.json({ ok: true, requester, responder, peers: [...this.peers] });
    });

    this.app.get('/ping', (req, res) => {
      const from = (req.query.from as string) || 'unknown';
      console.log(`[node:${this.port}] responding to ping from ${from}`);
      res.json({ ok: true, pong: true });
    });

    this.app.get('/peers', (_, res) => {
      res.json({ peers: [...this.peers] });
    });
  }

  private addPeer(url: string) {
    this.peers.add(url);
  }

  private async registerAt(peerUrl: string) {
    try {
      const myUrl = `http://localhost:${this.port}`;
      const resp = await fetch(`${peerUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: myUrl })
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      
      const data = await resp.json() as { peers?: string[]; responder?: string; requester?: string };
      
      if (data.peers) {
        for (const p of data.peers) {
          if (p !== myUrl) this.peers.add(p);
        }
      }

      this.addPeer(peerUrl);

      const responder = data.responder || peerUrl;
      console.log(`[node:${this.port}] register request accepted by ${responder}`);
    } catch (e) {
      console.error(`[node:${this.port}] Failed registering at ${peerUrl}:`, (e as Error).message);
    }
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`[node:${this.port}] listening`);

      if (this.bootstrap.length) {
        for (const peer of this.bootstrap) {
          this.registerAt(peer);
        }
      }

      this.pingPeers();
      this.pingTimer = setInterval(() => this.pingPeers(), PING_INTERVAL_MS);
    });
  }

private async pingPeers() {
  for (const url of this.peers) {
    let peerPort: number;
    try {
      const parsed = new URL(url);
      peerPort = parseInt(parsed.port, 10);
    } catch {
      peerPort = NaN;
    }
    console.log(`[node:${this.port}] ping -> ${peerPort}`);
    try {
      const resp = await fetch(`${url}/ping?from=${this.port}`);
      if (resp.ok) {
        console.log(`[node:${this.port}] pong <- ${peerPort}`);
      }
    } catch (e) {
      console.warn(`[node:${this.port}] ping fail ${peerPort}: ${(e as Error).message}`);
    }
  }
}
}

// Helper factory for CLI
export function startNode(port: number, bootstrap?: string | string[]) {
  const boots = typeof bootstrap === 'string'
    ? [bootstrap]
    : Array.isArray(bootstrap)
      ? bootstrap.filter(b => b && b.length)
      : undefined;

  const cfg: NodeConfig = { port };
  if (boots && boots.length) {
    cfg.bootstrap = boots;
  }

  const node = new CebularzNode(cfg);
  node.start();
  return node;
}
