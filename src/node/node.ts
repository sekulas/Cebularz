import express from 'express';
import {PING_INTERVAL_MS, RESTART_DEBOUNCE_MS, TX_PER_BLOCK} from './const.js';
import {Block, createGenesisBlock, isValidNewBlock, validateChain} from './blockchain.js';
import {Worker} from 'node:worker_threads';
import log from "loglevel";
import {getCoinbaseTransaction} from '../transactions/coinbase.ts';
import {
  processTransactions,
  Transaction,
  UnspentTxOut,
  validateTransaction
} from '../transactions/transaction.ts';

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

  // required for reorg mgmt
  private blocksByHash: Map<string, Block> = new Map();
  private orphanBlocks: Map<string, Block[]> = new Map();
  private totalDifficultyByHash: Map<string, bigint> = new Map();
  private chainTipHash: string | null = null;

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
    this.miningAddress = cfg.miningAddress;
    this.setupRoutes();
    this.initializeChain();
  }

  private initializeChain() {
    if (!this.chain.length) {
      const genesis = createGenesisBlock();
      this.chain.push(genesis);
      this.blocksByHash.set(genesis.hash, genesis);
      this.totalDifficultyByHash.set(genesis.hash, this.blockDifficultyWeight(genesis));
      this.chainTipHash = genesis.hash;
    }
  }

  private blockDifficultyWeight(block: Block): bigint {
    return BigInt(block.difficulty); //konwersja typów backward compatibility
  }

  // Zwraca aktualny tip głównego łańcucha
  private getLatestBlock(): Block {
    if (this.chainTipHash) {
      const tip = this.blocksByHash.get(this.chainTipHash);
      if (tip) return tip;
    }
    const latest = this.chain[this.chain.length - 1];
    if (!latest) throw new Error('chain empty');
    return latest;
  }

  // Tworzy łańcuch, sekwencję bloków od genesis at idx 0, do zadanego tipa
  private calculateChainFromTip(block: Block): Block[] {
    const chain: Block[] = [];
    let current: Block | null = block;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.hash)) break;
      seen.add(current.hash);
      chain.push(current);
      if (current.height === 0) break;
      current = this.blocksByHash.get(current.prevHash) || null;
    }
    chain.reverse();
    return chain;
  }

  // Wylicza łączną trudność łańcucha kończącego się na tipie, aktualizuje wartości
  private getTotalDifficulty(tipHash: string): bigint {
    const cached = this.totalDifficultyByHash.get(tipHash);
    if (cached !== undefined) return cached;
    const tip = this.blocksByHash.get(tipHash);
    if (!tip) return BigInt(0);
    if (tip.height === 0) {
      const d = this.blockDifficultyWeight(tip);
      this.totalDifficultyByHash.set(tip.hash, d);
      return d;
    }
    const parentTotal = this.getTotalDifficulty(tip.prevHash);
    const total = parentTotal + this.blockDifficultyWeight(tip);
    this.totalDifficultyByHash.set(tip.hash, total); // dlaczego nie w momencie dodawania bloku? raz policzymy i wyciągniemy
    return total;
  }

  private setupRoutes() {
    this.app.use(express.json());

    // Zarządzanie miningiem
    this.app.post('/mining/start', (_, res) => {
      const oldStatus = this.miner && this.miningInProgress ? 'running' : 'stopped';
      this.enableMining();
      const newStatus = this.miner && this.miningInProgress ? 'running' : 'stopped';
      log.info(`[node:${this.port}] mining start requested via REST`);
      res.json({old: oldStatus, new: newStatus});
    });

    this.app.post('/mining/stop', (_, res) => {
      const oldStatus = this.miner && this.miningInProgress ? 'running' : 'stopped';
      this.disableMining();
      const newStatus = this.miner && this.miningInProgress ? 'running' : 'stopped';
      log.info(`[node:${this.port}] mining stop requested via REST`);
      res.json({old: oldStatus, new: newStatus});
    });

    this.app.post('/mining/restart', (_, res) => {
      const oldStatus = this.miner && this.miningInProgress ? 'running' : 'stopped';
      this.performMiningRestart();
      const newStatus = this.miner && this.miningInProgress ? 'running' : 'stopped';
      log.info(`[node:${this.port}] mining restart requested via REST`);
      res.json({old: oldStatus, new: newStatus});
    });

    // Rejestracja peera
    this.app.post('/register', (req, res) => {
      let {url, urls} = req.body || {};
      if ((!url && !urls) || (url && typeof url !== 'string') || (urls && (!Array.isArray(urls) || !urls.every((u: any) => typeof u === 'string')))) {
        return res.status(400).json({error: 'url/urls required'});
      }
      urls = urls || [];
      if (url) {
        urls.push(url);
      }

      const responder = `http://localhost:${this.port}`;

      for (const requester of urls) {
        if (!this.peers.has(requester))
          log.info(`[node:${this.port}] registering peer ${requester}`);
        this.peers.add(requester);
      }

      res.json({ok: true, urls, responder, peers: [...this.peers]});
    });

    // Derejestracja peera
    this.app.post('/deregister', (req, res) => {
      let {url, urls} = req.body || {};
      if ((!url && !urls) || (url && typeof url !== 'string') || (urls && (!Array.isArray(urls) || !urls.every((u: any) => typeof u === 'string')))) {
        return res.status(400).json({error: 'url/urls required'});
      }
      urls = urls || [];
      if (url) {
        urls.push(url);
      }

      const responder = `http://localhost:${this.port}`;

      for (const requester of urls) {
        if (this.peers.delete(requester))
          log.info(`[node:${this.port}] deregistering peer ${requester}`);
      }

      res.json({ok: true, urls, responder, peers: [...this.peers]});
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

    // Zwróć blok o konkretnym hashu (lub 404 jeśli brak)
    this.app.get('/blocks/:hash', (req, res) => {
      const {hash} = req.params;
      const block = hash ? this.blocksByHash.get(hash) : undefined;
      if (!block) {
        return res.status(404).json({ok: false, error: 'block not found'});
      }
      res.json({ok: true, block});
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
          ignored: alreadyVisited,
          reason: alreadyVisited ? 'already visited' : null
        });
      }

      this.handleReceivedBlock(block);

      log.info(`[node:${this.port}] accepted block hash=${block.hash.slice(0, 16)} from ${sender || 'unknown'}...`);

      if (!alreadyVisited) {
        this.broadcastBlock(block, sender, previousPeers).then();
      }

      return res.json({ok: true, ignored: false, height: this.getLatestBlock().height});
    });

    this.app.post('/transactions', (req, res) => {
      const tx: Transaction | undefined = req.body;
      if (!tx || typeof tx !== 'object' || !tx.id) {
        return res.status(400).json({error: 'transaction required'});
      }
      const added = this.addToTransactionPool(tx);
      if (!added) {
        return res.status(400).json({
          error: 'transaction rejected (invalid, duplicate, or double-spend)',
          txId: tx.id
        });
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

  // Wspólny helper: sprawdza konflikt transakcji względem aktualnego mempoola
  private isTxConflictingWithMempool(tx: Transaction): boolean {
    // transakcja już jest w mempoolu po ID?
    if (this.transactionPool.some(t => t.id === tx.id)) {
      log.trace(`Tx ${tx.id} already in mempool.`);
      return true;
    }

    // wszystkie UTXO użyte przez transakcje w mempoolu
    const usedInMempool = new Set<string>();
    for (const poolTx of this.transactionPool) {
      for (const txIn of poolTx.txIns) {
        usedInMempool.add(`${txIn.txOutId}:${txIn.txOutIndex}`);
      }
    }

    // nowa transakcja próbuje użyć któregoś z utx0 użytych w mempoolu
    for (const txIn of tx.txIns) {
      const key = `${txIn.txOutId}:${txIn.txOutIndex}`;
      if (usedInMempool.has(key)) {
        log.trace(`Tx ${tx.id} tries to double-spend UTXO already in mempool: ${key}`);
        return true; // double-spend względem mempoola
      }
    }

    return false;
  }

  private addToTransactionPool(tx: Transaction): boolean {
    if (!validateTransaction(tx, this.unspentTxOuts)) {
      log.warn(`Tx already in pool: ${tx.id}`);
      return false;
    }

    // Konflikt z mempoolem (duplikat lub double-spend)
    if (this.isTxConflictingWithMempool(tx)) {
      log.warn(`Tx ${tx.id} tries to double-spend UTXO already in mempool.`);
      return false;
    }

    log.info(`Added tx to pool: ${tx.id}`);
    this.transactionPool.push(tx);

    if (this.miner) this.requestMiningRestart();
    return true;
  }

  private removeTxsFromTransactionPool(minedTxs: Transaction[]) {
    const minedIds = new Set(minedTxs.map(t => t.id));
    this.transactionPool = this.transactionPool.filter(t => !minedIds.has(t.id));
  }

  // obsługa przyjmowanego bloku wraz z forkami, orphanami i reorgiem
  private handleReceivedBlock(block: Block) {
    const latest = this.getLatestBlock();

    if (this.blocksByHash.has(block.hash)) {
      log.debug(`([node:${this.port}] block height=${block.height} hash=${block.hash.slice(0, 16)}... already known);`);
      return; // blok istnieje
    }

    if (block.height <= 0) {
      log.debug(`([node:${this.port}] genesis block received (recvd height ${block.height}) but already have one, ignoring);`)
      return;
    }

    const parent = this.blocksByHash.get(block.prevHash);
    // brak parenta = orphan
    if (!parent) {
      const list = this.orphanBlocks.get(block.prevHash) || [];
      list.push(block);
      this.orphanBlocks.set(block.prevHash, list);
      log.debug(`[node:${this.port}] stored orphan block height=${block.height} hash=${block.hash.slice(0, 16)}... prevHash(waiting for)=${block.prevHash.slice(0, 16)}...`);
      log.debug(`[node:${this.port}] requesting missing parent block hash=${block.prevHash.slice(0, 16)}... from peers`);
      this.tryFetchBlock(block.prevHash).then();
      return;
    }

    //parent jest
    const validation = isValidNewBlock(block, parent, this.difficulty); //czy nie nalezy przejsc na block.difficulty? (ten blok który przyszedł)
    if (!validation.ok) {
      log.warn(`[node:${this.port}] rejected block height=${block.height}: ${validation.reason}`);
      return;
    }


    //co tutaj w sytuacji gdy wpadnie blok łączący orphan z resztą?
    //odp - nic, zostaje dołączony do gałęzi, ewentualnie odpytujemy peery o parenta. W momencie gdy
    // przyjdzie blok tip dla tej gałęzi to będziemy robić reorg
    const candidateChain: Block[] = this.calculateChainFromTip(block);

    const genesis = this.chain[0];  //createGenesisBlock();

    if (!candidateChain[0] || genesis == undefined || candidateChain[0].hash !== genesis.hash) {
      log.warn(`[node:${this.port}] candidate chain has different genesis, rejecting block height=${block.height}`);
      return;
    }

    // walidacja candidate chain od dołu (czy są odpowiednie txouty wykrozsytane, double-spend etc)
    let tempUTxO: UnspentTxOut[] = [];
    for (let i = 0; i < candidateChain.length; i++) {
      const b = candidateChain[i];
      if (!b) continue;
      const newUTxO = processTransactions(b.data.transactions, tempUTxO, b.height);
      if (newUTxO === null) {
        log.warn(`[node:${this.port}] candidate chain invalid at height=${b.height} (transactions - processTransactions)`);
        return;
      }
      tempUTxO = newUTxO;
    }

    this.blocksByHash.set(block.hash, block);

    const candidateTipTotalDifficulty = this.getTotalDifficulty(block.hash);
    const currentTipTotalDifficulty = this.getTotalDifficulty(latest.hash);

    // następuje reorganizacja, bo nowy jest dłuższy
    if (candidateTipTotalDifficulty > currentTipTotalDifficulty) {
      const oldCanonical = this.chain.slice(); // kopia starego kanonicznego łańcucha

      log.info(`[node:${this.port}] performing reorg to new tip height=${block.height}, difficulty=${candidateTipTotalDifficulty} (oldTipHeight=${latest.height}, difficulty=${currentTipTotalDifficulty})`);

      // Ustaw nowy stan UTXO i nowy łańcuch główny
      this.unspentTxOuts = tempUTxO;
      const newCanonical = this.calculateChainFromTip(block); //candidateChain;
      this.chain = newCanonical;
      this.chainTipHash = newCanonical[newCanonical.length - 1]?.hash ?? null;

      // Zbierz transakcje z nowego łańcucha (będą usunięte z mempoola)
      const newChainTxs: Transaction[] = [];
      newCanonical.forEach(blk => newChainTxs.push(...blk.data.transactions));
      this.removeTxsFromTransactionPool(newChainTxs);

      // Dodanie tx z odłączonych bloków z powrotem do mempoola

      // bloki, które były w starym łańcuchu, a nie ma ich w nowym
      const newHashes = new Set(newCanonical.map(b => b.hash));
      const detachedBlocks = oldCanonical.filter(b => !newHashes.has(b.hash));

      const detachedTxs: Transaction[] = [];
      detachedBlocks.forEach(b => detachedTxs.push(...b.data.transactions));

      // Nie chcemy duplikować tx, które i tak są w nowej gałęzi
      const newChainTxIds = new Set(newChainTxs.map(t => t.id));

      for (const tx of detachedTxs) {
        if (!tx || !tx.id) continue;
        if (newChainTxIds.has(tx.id)) continue; // już w nowej gałęzi

        // Sprawdź, czy transakcja jest poprawna względem NOWEGO stanu UTXO
        // weryfikacja double spend
        if (!validateTransaction(tx, this.unspentTxOuts)) {
          log.debug(`[node:${this.port}] dropped tx ${tx.id} from detached block(s): invalid in new canonical state`);
          continue;
        }

        if (this.isTxConflictingWithMempool(tx)) {
          log.debug(`[node:${this.port}] dropped tx ${tx.id} from detached block(s): conflicts with current mempool`);
          continue;
        }

        // Jeśli wszystko OK – wrzucamy z powrotem do mempoola
        this.transactionPool.push(tx);
        log.info(`[node:${this.port}] re-queued tx ${tx.id} from detached block(s) into mempool after reorg`);
      }

      if (this.miner) this.requestMiningRestart();
    } else {
      log.info(`[node:${this.port}] accepted block height=${block.height} on side chain (no reorg)`);
    }

    //sprawdzenie czy jakiś blok nie czeka na procesowany blok - jeśli czeka, to procesujemy każdy czekający blok
    const waiting = this.orphanBlocks.get(block.hash);
    if (waiting && waiting.length) {
      this.orphanBlocks.delete(block.hash);
      for (const orphan of waiting) {
        log.debug(`[node:${this.port}] processing previously orphaned block height=${orphan.height} hash=${orphan.hash.slice(0, 16)}...`);
        this.handleReceivedBlock(orphan);
      }
    }
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

      // Oblicz łączną trudność dla łańcucha z peera
      let remoteTotalDifficulty = BigInt(0);
      for (const b of data.chain) {
        remoteTotalDifficulty += this.blockDifficultyWeight(b);
      }

      const localTip = this.getLatestBlock();
      const localTotalDifficulty = this.getTotalDifficulty(localTip.hash);

      if (remoteTotalDifficulty > localTotalDifficulty) {
        // Przyjmujemy łańcuch z peera jako nowy kanoniczny i aktualizujemy mapy
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

        // Zbuduj blocksByHash i totalDifficultyByHash od nowa
        this.blocksByHash.clear();
        this.totalDifficultyByHash.clear();
        for (const b of this.chain) {
          this.blocksByHash.set(b.hash, b);
        }
        const tip = this.chain[this.chain.length - 1];
        if (tip) {
          this.chainTipHash = tip.hash;
          this.getTotalDifficulty(tip.hash); // wypełni totalDifficultyByHash rekurencyjnie
        }

        log.info(`[node:${this.port}] chain synced from ${peerUrl} height=${this.getLatestBlock().height}`);
        if (this.miner) this.requestMiningRestart();
      } else {
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

  private disposeInvalidTransactionsAtThisMoment(): void {
    this.transactionPool = this.transactionPool.filter(t => {
      if (!validateTransaction(t, this.unspentTxOuts)) {
        log.warn(`[node:${this.port}] disposed invalid transaction from pool: ${t.id}, amt=${t.txOuts.reduce((a, b) => a + "+" + b.amount, "").slice(1)} to=${t.txOuts.map(to => to.address.slice(0, 8)).join(',')}`);
        return false;
      }
      return true;
    });

  }

  private startMiningJob() {
    if (!this.miner) return;
    if (!this.miningWorker) this.initMiningWorker();
    if (this.miningInProgress) return;
    const latest = this.getLatestBlock();

    const coinbaseTx = getCoinbaseTransaction(this.miningAddress, latest.height + 1);

    this.disposeInvalidTransactionsAtThisMoment();

    const txsToMine = [coinbaseTx, ...this.transactionPool.slice(0, TX_PER_BLOCK)]

    log.debug(`[node:${this.port}] starting mining job with ${txsToMine.length} txs (including coinbase)`);

    const msg = txsToMine.reduce((pv, tx, idx) =>
            pv + `\nTX[${idx}] amt=${tx.txOuts.reduce((a, b) => a + "+" + b.amount, "").slice(1)} to=${tx.txOuts.map(to => to.address.slice(0, 8)).join(',')}`,
        `[node:${this.port}] mining txs:`
    );
    log.debug(msg)

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

  // Włączenie miningu (używane przez endpointy)
  private enableMining() {
    if (this.miner && this.miningInProgress) return;
    this.miner = true;
    this.initMiningWorker();
    this.startMiningJob();
  }

  // Wyłączenie miningu (używane przez endpointy)
  private disableMining() {
    if (!this.miner && !this.miningInProgress) return;

    this.miner = false;

    if (this.cancelSAB) {
      Atomics.store(new Int32Array(this.cancelSAB), 0, 1);
    }

    if (this.miningWorker) {
      this.miningWorker.terminate().catch(err => {
        log.error(`[node:${this.port}] error terminating mining worker:`, err);
      });
      this.miningWorker = null;
    }

    this.miningInProgress = false;
    this.miningRestartPending = false;
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

  // pobiera bloki od peerów, o ile nie istnieje lokalnie - jeśli pobierze to wrzuca go do łańcucha
  private async tryFetchBlock(hash: string): Promise<Block | null> {
    if (!hash) return null;

    // Jeśli już mamy ten blok lokalnie, zwróć go od razu
    const local = this.blocksByHash.get(hash);
    if (local) return local;

    const peers = [...this.peers];
    const myUrl = `http://localhost:${this.port}`;

    for (const peer of peers) {
      try {
        const url = new URL(peer);
        const peerLabel = url.port || peer;
        log.debug(`[node:${this.port}] tryFetchBlock(${hash.slice(0, 16)}...) -> ${peerLabel}`);

        const resp = await fetch(`${peer}/blocks/${hash}`);
        if (!resp.ok) {
          log.debug(`[node:${this.port}] peer ${peerLabel} has no block ${hash.slice(0, 16)}..., status=${resp.status}`);
          continue;
        }

        const data = await resp.json() as { block?: Block | null };
        if (!data.block) {
          log.debug(`[node:${this.port}] peer ${peerLabel} returned empty block for ${hash.slice(0, 16)}...`);
          continue;
        }

        const block = data.block;

        // Spróbuj włączyć blok do naszego łańcucha (obsługa orphanów/reorgów jest w środku)
        this.handleReceivedBlock(block);

        const accepted = this.blocksByHash.get(block.hash);
        if (accepted) {
          // log.info(`[node:${this.port}] fetched and accepted block height=${block.height} hash=${block.hash.slice(0, 16)}... from ${peerLabel}`);
          return accepted;
        }

        // log.warn(`[node:${this.port}] fetched block ${block.hash.slice(0, 16)}... from ${peerLabel}, but it was not accepted`);
      } catch (e) {
        log.warn(`[node:${this.port}] tryFetchBlock(${hash.slice(0, 16)}...) from ${peer} failed:`, (e as Error).message);
      }
    }

    // log.debug(`[node:${this.port}] tryFetchBlock(${hash.slice(0, 16)}...) not found at any peer`);
    return null;
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
