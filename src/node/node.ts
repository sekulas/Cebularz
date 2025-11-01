import express from 'express';
import { PING_INTERVAL_MS, MINING_INTERVAL_MS } from './const.js';
import { Blockchain, type Block } from './blockchain.js';

export interface NodeConfig {
  port: number;
  bootstrap?: string[];
  miner?: boolean; // single-miner mode
}

export class CebularzNode {
  private app = express();
  private port: number;
  private peers: Set<string> = new Set();
  private pingTimer?: NodeJS.Timeout;
  private miningTimer?: NodeJS.Timeout;

  private bootstrap: string[] = [];

  // blockchain state
  private chain = new Blockchain();

  private get myUrl() {
    return `http://localhost:${this.port}`;
  }

  private miner: boolean = false;

  constructor(cfg: NodeConfig) {
    this.port = cfg.port;
    this.bootstrap = cfg.bootstrap ?? [];
    this.miner = !!cfg.miner;
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
      const responder = this.myUrl;
      if (requester !== responder) {
        this.peers.add(requester);
      }
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

    // blockchain endpoints
    this.app.get('/blocks', (_, res) => {
      res.json({ blocks: this.chain.getBlocks() });
    });

    this.app.get('/state', (_, res) => {
      res.json(this.chain.getState());
    });

    this.app.post('/block', async (req, res) => {
      const { block, sender } = req.body || {} as { block?: Block; sender?: string };
      if (!block || typeof block !== 'object') {
        return res.status(400).json({ ok: false, error: 'block required' });
      }
      const accepted = this.chain.tryAppend(block);
      if (accepted) {
        console.log(`[node:${this.port}] accepted new block #${block.index} from ${sender ?? 'unknown'}`);
        // Optionally forward to other peers (gossip), excluding sender
        this.broadcastBlock(block, sender);
        return res.json({ ok: true, appended: true });
      }
      // If the incoming block height is ahead, try to sync full chain from sender
      const last = this.chain.getLastBlock();
      if (block.index > last.index + 1 && sender) {
        console.log(`[node:${this.port}] behind (have ${last.index}, seen ${block.index}); syncing from ${sender}`);
        const replaced = await this.syncFrom(sender).catch(() => false);
        return res.json({ ok: replaced === true, appended: false, synced: replaced === true });
      }
      return res.status(400).json({ ok: false, error: 'block rejected' });
    });
  }

  private async registerAt(peerUrl: string) {
    try {
      const myUrl = this.myUrl;
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

      this.peers.add(peerUrl);

      const responder = data.responder || peerUrl;
      console.log(`[node:${this.port}] register request accepted by ${responder}`);

      // initial sync from responder
      await this.syncFrom(responder).catch((e) => {
        console.warn(`[node:${this.port}] initial sync failed from ${responder}:`, (e as Error).message);
      });
    } catch (e) {
      console.error(`[node:${this.port}] Failed registering at ${peerUrl}:`, (e as Error).message);
    }
  }

  private async syncFrom(peerUrl: string): Promise<boolean> {
    const resp = await fetch(`${peerUrl}/blocks`);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json() as { blocks?: Block[] };
    if (!data.blocks) throw new Error('no blocks in response');
    const replaced = this.chain.replaceChain(data.blocks);
    if (replaced) {
      console.log(`[node:${this.port}] chain replaced from ${peerUrl}; height=${this.chain.getLastBlock().index}`);
    }
    return replaced;
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
        const controller = new AbortController();
        setTimeout(()=> {
          console.log(`[node:${this.port}] aborting ping -> ${peerPort}`);
          controller.abort();
        }, 2000)

        const resp = await fetch(`${url}/ping?from=${this.port}`, {signal: controller.signal});
        if (resp.ok) {
          console.log(`[node:${this.port}] pong <- ${peerPort}`);
        }
      } catch (e) {
        console.warn(`[node:${this.port}] ping fail ${peerPort}: ${(e as Error).message}`);
      }
    }
  }

  private async broadcastBlock(block: Block, exclude?: string) {
    for (const url of this.peers) {
      if (exclude && url === exclude) continue;
      try {
        await fetch(`${url}/block`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ block, sender: this.myUrl })
        });
      } catch (e) {
        console.warn(`[node:${this.port}] broadcast to ${url} failed:`, (e as Error).message);
      }
    }
  }

  private startMiningLoop() {
    if (!this.miner) return;
    if (this.miningTimer) clearInterval(this.miningTimer);
    console.log(`[node:${this.port}] miner enabled; mining every ~${MINING_INTERVAL_MS}ms`);
    this.miningTimer = setInterval(async () => {
      try {
        const data = { miner: this.port, note: 'empty block' };
        const before = Date.now();
        const block = this.chain.mineNextBlock(data);
        const took = Date.now() - before;
        console.log(`[node:${this.port}] mined block #${block.index} in ${took}ms: ${block.hash.slice(0, 10)}...`);
        await this.broadcastBlock(block);
      } catch (e) {
        console.error(`[node:${this.port}] mining error:`, (e as Error).message);
      }
    }, MINING_INTERVAL_MS);
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

      // start mining if enabled
      const miningPromise = new Promise(()=>this.startMiningLoop());

      miningPromise.then(()=>{console.log(`[node:${this.port}] mining finished successfully`)});

    });
  }
}

// Helper factory for CLI
export function startNode(port: number, bootstrap?: string | string[], miner?: boolean) {
  const boots = typeof bootstrap === 'string'
    ? [bootstrap]
    : Array.isArray(bootstrap)
      ? bootstrap.filter(b => b && b.length)
      : undefined;

  const cfg: NodeConfig = { port };
  if (boots && boots.length) cfg.bootstrap = boots;
  if (miner) cfg.miner = true;

  const node = new CebularzNode(cfg);
  node.start();
  return node;
}
