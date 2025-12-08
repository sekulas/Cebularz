import express from 'express';
import {PING_INTERVAL_MS, RESTART_DEBOUNCE_MS, TX_PER_BLOCK} from './const.js';
import {Block, createGenesisBlock, isValidNewBlock, validateChain} from './blockchain.js';
import {Worker} from 'node:worker_threads';
import log from "loglevel";
import { getCoinbaseTransaction } from '../transactions/coinbase.ts';
import { processTransactions, Transaction, UnspentTxOut, validateTransaction } from '../transactions/transaction.ts';

export interface NodeConfig {
  port: number;
  bootstrap?: string[];
  miner?: boolean; // czy ten węzeł kopie bloki
  difficulty?: number; // ilość wiodących zer w hash (hex)
  miningAddress: string; // adres do nagrody za kopanie
}

export class CebularzNode {
  private app = express();
  private port: number;
  private peers: Set<string> = new Set();
  private pingTimer?: NodeJS.Timeout;
  private bootstrap: string[] = [];
  private miner: boolean = false;
  private difficulty: number = 2;
  private miningAddress: string;

  private chain: Block[] = [];

  // Mining worker state
  private miningWorker: Worker | null = null;
  private cancelSAB?: SharedArrayBuffer;
  private miningInProgress = false;
  private miningRestartPending = false;
  private restartDebounceTimer: NodeJS.Timeout | null = null;

  private unspentTxOuts: UnspentTxOut[] = [];
  private transactionPool: Transaction[] = [];


  constructor(cfg: NodeConfig) {
    this.port = cfg.port;
    this.bootstrap = cfg.bootstrap ?? [];
    this.miner = !!cfg.miner;
    if (typeof cfg.difficulty === 'number' && cfg.difficulty >= 0 && cfg.difficulty <= 64) this.difficulty = cfg.difficulty;
    this.miningAddress = cfg.miningAddress
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
      
      this.handleReceivedBlock(block);

      log.info(`[node:${this.port}] accepted block height=${block.height} hash=${block.hash.slice(0, 16)} from ${sender || 'unknown'}...`);
      
      const newLatest = this.getLatestBlock();

      if(newLatest.height === block.height) {
        if (!alreadyVisited) {
          this.broadcastBlock(block, sender, previousPeers).then();
        }
        if (this.miner) this.requestMiningRestart();
        res.json({ok: true, height: block.height});
      }
      else {
        res.status(400).json({ok: false, error: 'block validation failed'});
      }
    });

    this.app.post('/transactions', (req, res) => {
      const tx: Transaction | undefined = req.body;
      if (!tx || typeof tx !== 'object' || !tx.id) {
        return res.status(400).json({error: 'transaction required'});
      }
      const added = this.addToTransactionPool(tx);
      if (!added) {
        return res.status(400).json({error: 'transaction rejected (invalid, duplicate, or double-spend)', txId: tx.id});
      }
      res.json({ok: true, txId: tx.id})
    })

    this.app.get('/unspent/:address', (req, res) => {
      const address = req.params.address;
      
      // Zbierz UTXO już użyte przez transakcje w mempool
      const usedInMempool = new Set<string>();
      for (const poolTx of this.transactionPool) {
        for (const txIn of poolTx.txIns) {
          usedInMempool.add(`${txIn.txOutId}:${txIn.txOutIndex}`);
        }
      }
      
      // Zwróć tylko UTXO które NIE są użyte przez transakcje w mempool
      const availableUTxOs = this.unspentTxOuts.filter(u => {
        if (u.address !== address) return false;
        const key = `${u.txOutId}:${u.txOutIndex}`;
        return !usedInMempool.has(key);
      });
      
      res.json(availableUTxOs);
    })

    this.app.get('/balance/:address', (req, res) => {
      const address = req.params.address;
      const uTxOs = this.unspentTxOuts.filter(u => u.address === address);
      const balance = uTxOs.reduce((a, b) => a + b.amount, 0);
      res.json({address, balance});
    });
  }

  private addToTransactionPool(tx: Transaction): boolean {
    if (!validateTransaction(tx, this.unspentTxOuts)) {
        log.warn(`Trying to add invalid tx to pool: ${tx.id}`);
        return false;
    }
    if (this.transactionPool.find(t => t.id === tx.id)) {
      log.warn(`Tx already in pool: ${tx.id}`);
      return false;
    }
    
    // Sprawdź czy UTXO nie są już użyte w innych transakcjach w mempool (double-spending)
    const usedUTxOs = new Set<string>();
    for (const poolTx of this.transactionPool) {
      for (const txIn of poolTx.txIns) {
        usedUTxOs.add(`${txIn.txOutId}:${txIn.txOutIndex}`);
      }
    }
    
    for (const txIn of tx.txIns) {
      const key = `${txIn.txOutId}:${txIn.txOutIndex}`;
      if (usedUTxOs.has(key)) {
        log.warn(`Tx ${tx.id} tries to double-spend UTXO already in mempool: ${key}`);
        return false;
      }
    }
    
    log.info(`Added tx to pool: ${tx.id}`);
    this.transactionPool.push(tx);

    if (this.miner) this.requestMiningRestart();
    return true;
  }

  private updateTransactionPool(minedTxs: Transaction[]) {
    const minedIds = new Set(minedTxs.map(t => t.id));
    this.transactionPool = this.transactionPool.filter(t => !minedIds.has(t.id));
  }

  private handleReceivedBlock(block: Block) {
    const latest = this.getLatestBlock();
    if (block.height <= latest.height) return; // Stary blok

    const result = this.processBlock(block, latest, this.unspentTxOuts, this.difficulty);
    if (result.ok && result.newTxOs) {
        this.chain.push(block);
        this.unspentTxOuts = result.newTxOs;

        // Remove mined transactions from pool
        this.updateTransactionPool(block.data.transactions);
        log.info(`Block accepted height=${block.height}. UTXO set size: ${this.unspentTxOuts.length}`);
        if (this.miner) this.requestMiningRestart();
    } else {
        log.warn(`Block rejected: ${result.reason}`);
    }
  }

  private processBlock = (block: Block, prevBlock: Block, unspentTxOuts: UnspentTxOut[], difficulty: number): { ok: boolean, newTxOs?: UnspentTxOut[], reason?: string } => {
    const basicValidation = isValidNewBlock(block, prevBlock, difficulty);
    if (!basicValidation) return { ok: false, reason: 'invalid structure' };

    const newUTxOs = processTransactions(block.data.transactions, unspentTxOuts, block.height);
    if (newUTxOs === null) {
        return { ok: false, reason: 'invalid transactions in block' };
    }

    return { ok: true, newTxOs: newUTxOs };
};

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
        let tempUTxO: UnspentTxOut[] = [];
        for (let i = 0; i < data.chain.length; i++) {
          const block = data.chain[i];
          if (!block) continue;
          const newUTxO = processTransactions(block.data.transactions, tempUTxO, block.height);
          if (newUTxO === null) {
            log.warn(`[node:${this.port}] sync failed at block ${i}: invalid transactions`);
            return;
          }
          tempUTxO = newUTxO;
        }
        this.chain = data.chain;
        this.unspentTxOuts = tempUTxO;
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
    const chainPeers = Array.isArray(previousPeers) ? [...previousPeers] : [];

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
      log.debug(`[node:${this.port}] mining worker message received: ${JSON.stringify(msg)}`);
      if (msg && msg.ok && msg.block) {
        const block: Block = msg.block;

        this.handleReceivedBlock(block);

        log.info(`[node:${this.port}] mined block height=${block.height} hash=${block.hash.slice(0, 16)}... attempts=${msg.attempts} ms=${msg.ms}`);
        this.broadcastBlock(block, undefined, []).then();
        
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

    const coinbaseTx = getCoinbaseTransaction(this.miningAddress, latest.height + 1);
    const txsToMine = [coinbaseTx, ...this.transactionPool.slice(0, TX_PER_BLOCK)]

    this.cancelSAB = new SharedArrayBuffer(4);
    const view = new Int32Array(this.cancelSAB);
    Atomics.store(view, 0, 0);
    const payload = {
      prevHash: latest.hash,
      prevHeight: latest.height,
      miner: `http://localhost:${this.port}`,
      transactions: txsToMine,
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

    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
    }

    log.debug(`[node:${this.port}] scheduling mining restart in ${RESTART_DEBOUNCE_MS}ms`);

    this.restartDebounceTimer = setTimeout(() => {
      this.performMiningRestart();
      this.restartDebounceTimer = null;
    }, RESTART_DEBOUNCE_MS);

  }

  private performMiningRestart() {
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
export function startNode(port: number, miningAddress: string, bootstrap?: string | string[], miner?: boolean, difficulty?: number) {
  const boots = typeof bootstrap === 'string'
      ? [bootstrap]
      : Array.isArray(bootstrap)
          ? bootstrap.filter(b => b && b.length)
          : undefined;

  const cfg: NodeConfig = {port, miningAddress};
  if (boots && boots.length) cfg.bootstrap = boots;
  if (miner) cfg.miner = true;
  if (typeof difficulty === 'number') cfg.difficulty = difficulty;

  const node = new CebularzNode(cfg);
  node.start();
  return node;
}
