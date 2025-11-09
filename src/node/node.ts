import express from 'express';
import {PING_INTERVAL_MS} from './const.js';
import {Block, createGenesisBlock, isValidNewBlock, validateChain} from './blockchain.js';
import {Worker} from 'node:worker_threads';
import log from "loglevel";

export interface NodeConfig {
  port: number;
  bootstrap?: string[];
  miner?: boolean; // czy ten węzeł kopie bloki
  difficulty?: number; // ilość wiodących zer w hash (hex)
}

export class CebularzNode {
  private app = express();
  private port: number;
  private peers: Set<string> = new Set();
  private pingTimer?: NodeJS.Timeout;
  private bootstrap: string[] = [];
  private miner: boolean = false;
  private difficulty: number = 2;


  private chain: Block[] = [];

  // Mining worker state
  private miningWorker: Worker | null = null;
  private cancelSAB?: SharedArrayBuffer;
  private miningInProgress = false;
  private miningRestartPending = false;

  constructor(cfg: NodeConfig) {
    this.port = cfg.port;
    this.bootstrap = cfg.bootstrap ?? [];
    this.miner = !!cfg.miner;
    if (typeof cfg.difficulty === 'number' && cfg.difficulty >= 0 && cfg.difficulty <= 64) this.difficulty = cfg.difficulty;
    this.setupRoutes();
    this.initializeChain();
  }

  private initializeChain() {
    if (!this.chain.length) {
      this.chain.push(createGenesisBlock());
    }
  }

  private setupRoutes() {
    this.app.use(express.json());

    // Rejestracja peera
    this.app.post('/register', (req, res) => {
      const {url} = req.body || {};
      if (!url || typeof url !== 'string') {
        return res.status(400).json({error: 'url required'});
      }
      const requester = url;
      const responder = `http://localhost:${this.port}`;
      log.info(`[node:${this.port}] registering peer ${requester}`);
      this.peers.add(requester);
      res.json({ok: true, requester, responder, peers: [...this.peers]});
    });

    // Ping
    this.app.get('/ping', (req, res) => {
      const from = (req.query.from as string) || 'unknown';
      log.trace(`[node:${this.port}] responding to ping from ${from}`);
      res.json({ok: true, pong: true});
    });

    // Lista peerów
    this.app.get('/peers', (_, res) => {
      res.json({peers: [...this.peers]});
    });

    // Zwróć cały łańcuch (prosto – brak paginacji)
    this.app.get('/blocks', (_, res) => {
      res.json({chain: this.chain});
    });

    // Zwróć najnowszy blok
    this.app.get('/blocks/latest', (_, res) => {
      res.json({
        latest: this.getLatestBlock(),
        height: this.getLatestBlock().height,
        difficulty: this.difficulty
      });
    });

    // Przyjmij nowy blok od peera
    this.app.post('/blocks/new', (req, res) => {
      const block: Block | undefined = req.body?.block;
      const sender: string | undefined = req.body?.sender;
      const previousPeersRaw: unknown = req.body?.previousPeers;
      const previousPeers: string[] = Array.isArray(previousPeersRaw)
          ? previousPeersRaw.filter(p => typeof p === 'string')
          : [];
      if (!block || typeof block !== 'object') {

        return res.status(400).json({ok: false, error: 'block required'});
      }
      const latest = this.getLatestBlock();

      const myUrl = `http://localhost:${this.port}`;
      const alreadyVisited = previousPeers.includes(myUrl);
      log.debug(`[node:${this.port}] received new block from ${sender || 'unknown'}`);
      log.debug(`[node:${this.port}] ...prevPeersLen=${previousPeers.length} visited=${alreadyVisited}`);

      if (alreadyVisited) {
        log.debug(`[node:${this.port}] not rebroadcasting (already in previousPeers)`);
        return res.json({
          ok: true,
          height: latest.height,
          ignored: true,
          reason: 'already visited'
        });
      }

      if (block.height <= latest.height) {
        // Stary lub równy – ignorujemy
        log.debug(`[node:${this.port}] received block has height ${block.height}, and latest is ${latest.height}. Ignoring!`);
        return res.json({ok: true, ignored: true, reason: 'height not newer'});
      }
      if (block.height !== latest.height + 1) {
        // Luka – spróbuj zsynchronizować pełen łańcuch od nadawcy
        if (sender) {
          log.warn(`[node:${this.port}] gap detected (latest=${latest.height}, incoming=${block.height}) -> triggering full sync from ${sender}`);
          this.syncFromPeer(sender).catch(e => log.error(`[node:${this.port}] full sync error:`, (e as Error).message));
        }
        return res.status(202).json({
          ok: false,
          gap: true,
          expected: latest.height + 1,
          got: block.height
        });
      }
      const v = isValidNewBlock(block, latest, this.difficulty);
      if (!v.ok) {
        return res.status(400).json({ok: false, error: v.reason});
      }
      this.chain.push(block);
      log.info(`[node:${this.port}] accepted block height=${block.height} hash=${block.hash.slice(0, 16)} from ${sender || 'unknown'}...`);
      // propagacja dalej jeśli nie byliśmy jeszcze na liście previousPeers
      if (!alreadyVisited) {
        this.broadcastBlock(block, sender, previousPeers).then();
      } else {
        log.debug(`[node:${this.port}] not rebroadcasting (already in previousPeers)`);
      }
      if (this.miner) this.requestMiningRestart();
      res.json({ok: true, height: block.height});
    });
  }

  private getLatestBlock(): Block {
    const latest = this.chain[this.chain.length - 1];
    if (!latest) throw new Error('chain empty');
    return latest;
  }

  private async registerAt(peerUrl: string) {
    try {
      const myUrl = `http://localhost:${this.port}`;
      log.debug(`[node:${this.port}] sending request to ${peerUrl} to register`);
      const resp = await fetch(`${peerUrl}/register`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: myUrl})
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);

      const data = await resp.json() as {
        peers?: string[];
        responder?: string;
        requester?: string
      };

      if (data.peers) {
        for (const p of data.peers) {
          if (p !== myUrl) this.peers.add(p);
        }
      }

      this.peers.add(peerUrl);

      const responder = data.responder || peerUrl;
      log.debug(`[node:${this.port}] register request accepted by ${responder}`);

      // Po rejestracji spróbuj zsynchronizować łańcuch (jeśli peer ma dłuższy)
      await this.syncFromPeer(peerUrl);
    } catch (e) {
      log.error(`[node:${this.port}] Failed registering at ${peerUrl}:`, (e as Error).message);
    }
  }

  private async syncFromPeer(peerUrl: string) {
    try {
      const resp = await fetch(`${peerUrl}/blocks`);
      if (!resp.ok) throw new Error(`blocks status ${resp.status}`);
      const data = await resp.json() as { chain?: Block[] };
      if (!data.chain || !Array.isArray(data.chain)) throw new Error('no chain');
      const v = validateChain(data.chain, this.difficulty);
      if (!v.ok) throw new Error(`remote chain invalid: ${v.reason}`);
      // FIXME: change in future - comparison based on accumulated difficulty, but not length
      if (data.chain.length > this.chain.length) {
        this.chain = data.chain;
        log.info(`[node:${this.port}] chain synced from ${peerUrl} height=${this.getLatestBlock().height}`);
        if (this.miner) this.requestMiningRestart();
      } else {
        log.info(`[node:${this.port}] remote chain not longer (local=${this.chain.length}, remote=${data.chain.length})`);
      }
    } catch (e) {
      log.error(`[node:${this.port}] syncFromPeer failed ${peerUrl}:`, (e as Error).message);
    }
  }

  private async broadcastBlock(block: Block, excludeSender?: string, previousPeers?: string[]) {
    const myUrl = `http://localhost:${this.port}`;
    const chainPeers = Array.isArray(previousPeers) ? previousPeers : [];

    chainPeers.push(myUrl);
    for (const peer of this.peers) {
      if (excludeSender && peer === excludeSender) continue; // unikaj natychmiastowej pętli zwrotnej
      if (chainPeers.includes(peer)) {
        // Już byliśmy – zatrzymaj propagację
        log.debug(`[node:${this.port}] broadcast loop prevention: peer ${peer} already in previousPeers; stopping`);
        continue;
      }
      try {
        await fetch(`${peer}/blocks/new`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({block, sender: myUrl, previousPeers: chainPeers})
        });
        log.debug(`[node:${this.port}] broadcasted block height=${block.height} to ${peer} prevPeersLen=${chainPeers.length}`);
      } catch (e) {
        log.error(`[node:${this.port}] broadcast to ${peer} failed:`, (e as Error).message);
      }
    }
  }

  // ===== Mining via Worker =====
  private initMiningWorker() {
    if (this.miningWorker) return;
    const workerPath = new URL('./miner-worker.ts', import.meta.url);
    this.miningWorker = new Worker(workerPath, {execArgv: ['--import', 'tsx']});
    this.miningWorker.on('message', (msg: any) => {
      if (msg && msg.ok && msg.block) {
        const block: Block = msg.block;
        const latest = this.getLatestBlock();
        const v = isValidNewBlock(block, latest, this.difficulty);
        if (!v.ok) {
          log.warn(`[node:${this.port}] mined block invalid: ${v.reason}`);
        } else {
          this.chain.push(block);
          log.info(`[node:${this.port}] mined block height=${block.height} hash=${block.hash.slice(0, 16)}... attempts=${msg.attempts} ms=${msg.ms}`);
          this.broadcastBlock(block, undefined, []).then();
        }
        this.miningInProgress = false;
        if (this.miningRestartPending) {
          this.miningRestartPending = false;
          this.startMiningJob();
        } else {
          this.startMiningJob();
        }
      } else if (msg && msg.canceled) {
        log.info(`[node:${this.port}] mining job canceled (attempts=${msg.attempts} ms=${msg.ms})`);
        this.miningInProgress = false;
        if (this.miningRestartPending) {
          this.miningRestartPending = false;
          this.startMiningJob();
        }
      } else if (msg && msg.ok === false) {
        log.error(`[node:${this.port}] mining worker error: ${msg.error}`);
        this.miningInProgress = false;
        setTimeout(() => this.startMiningJob(), 1000);
      }
    });
    this.miningWorker.on('error', err => {
      log.error(`[node:${this.port}] mining worker crashed:`, err);
      this.miningWorker = null;
      this.miningInProgress = false;
      setTimeout(() => {
        this.initMiningWorker();
        this.startMiningJob();
      }, 1000);
    });
    this.miningWorker.on('exit', code => {
      log.warn(`[node:${this.port}] mining worker exited code=${code}`);
      this.miningWorker = null;
      this.miningInProgress = false;
      if (this.miner) setTimeout(() => {
        this.initMiningWorker();
        this.startMiningJob();
      }, 1000);
    });
  }

  private startMiningJob() {
    if (!this.miner) return;
    if (!this.miningWorker) this.initMiningWorker();
    if (this.miningInProgress) return;
    const latest = this.getLatestBlock();
    this.cancelSAB = new SharedArrayBuffer(4);
    const view = new Int32Array(this.cancelSAB);
    Atomics.store(view, 0, 0);
    const payload = {
      prevHash: latest.hash,
      prevHeight: latest.height,
      miner: `http://localhost:${this.port}`,
      difficulty: this.difficulty
    };
    try {
      this.miningWorker!.postMessage({cmd: 'mine', payload, cancelSAB: this.cancelSAB});
      this.miningInProgress = true;
      log.debug(`[node:${this.port}] mining job started (prevHeight=${latest.height}, difficulty=${this.difficulty})`);
    } catch (e) {
      log.error(`[node:${this.port}] failed to start mining job:`, (e as Error).message);
      this.miningInProgress = false;
    }
  }

  private requestMiningRestart() {
    if (!this.miner) return;
    if (this.miningInProgress && this.cancelSAB) {
      Atomics.store(new Int32Array(this.cancelSAB), 0, 1);
      this.miningRestartPending = true;
      log.debug(`[node:${this.port}] requested mining restart`);
    } else if (!this.miningInProgress) {
      this.startMiningJob();
    }
  }

  start() {
    this.app.listen(this.port, () => {
      log.info(`[node:${this.port}] listening`);

      if (this.bootstrap.length) {
        for (const peer of this.bootstrap) {
          this.registerAt(peer);
        }
      }

      this.pingPeers();
      this.pingTimer = setInterval(() => this.pingPeers(), PING_INTERVAL_MS);

      if (this.miner) {
        log.debug(`[node:${this.port}] miner enabled (difficulty=${this.difficulty})`);
        this.initMiningWorker();
        this.startMiningJob();
      }
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
      log.trace(`[node:${this.port}] ping -> ${peerPort}`);
      try {
        const resp = await fetch(`${url}/ping?from=${this.port}`);
        if (resp.ok) {
          log.trace(`[node:${this.port}] pong <- ${peerPort}`);
        }
      } catch (e) {
        log.warn(`[node:${this.port}] ping fail ${peerPort}: ${(e as Error).message}`);
      }
    }
  }
}

// Helper factory for CLI
export function startNode(port: number, bootstrap?: string | string[], miner?: boolean, difficulty?: number) {
  const boots = typeof bootstrap === 'string'
      ? [bootstrap]
      : Array.isArray(bootstrap)
          ? bootstrap.filter(b => b && b.length)
          : undefined;

  const cfg: NodeConfig = {port};
  if (boots && boots.length) cfg.bootstrap = boots;
  if (miner) cfg.miner = true;
  if (typeof difficulty === 'number') cfg.difficulty = difficulty;

  const node = new CebularzNode(cfg);
  node.start();
  return node;
}
