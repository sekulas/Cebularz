import { createHash } from 'crypto';

export interface Block {
  index: number;
  timestamp: number; // ms
  previousHash: string;
  data: unknown;
  nonce: number;
  difficulty: number;
  hash: string;
}

export interface ChainState {
  length: number;
  lastHash: string;
}

function hashOfFields(index: number, timestamp: number, previousHash: string, data: unknown, nonce: number, difficulty: number): string {
  const payload = `${index}|${timestamp}|${previousHash}|${JSON.stringify(data)}|${nonce}|${difficulty}`;
  return createHash('sha256').update(payload).digest('hex');
}

// Hardcoded genesis parameters
const GENESIS_INDEX = 0;
const GENESIS_TIMESTAMP = 1_730_000_000_000; // fixed epoch ms
const GENESIS_PREV_HASH = '0'.repeat(64);
const GENESIS_DATA = { name: 'Cebularz Genesis', note: 'Harcoded genesis to prevent fake chains' } as const;
const GENESIS_DIFFICULTY = 4; // keep small for dev
const GENESIS_NONCE = 0; // no PoW for genesis
const GENESIS_HASH = hashOfFields(
  GENESIS_INDEX,
  GENESIS_TIMESTAMP,
  GENESIS_PREV_HASH,
  GENESIS_DATA,
  GENESIS_NONCE,
  GENESIS_DIFFICULTY
);

export const GENESIS_BLOCK: Block = Object.freeze({
  index: GENESIS_INDEX,
  timestamp: GENESIS_TIMESTAMP,
  previousHash: GENESIS_PREV_HASH,
  data: GENESIS_DATA,
  nonce: GENESIS_NONCE,
  difficulty: GENESIS_DIFFICULTY,
  hash: GENESIS_HASH,
});

export class Blockchain {
  private chain: Block[] = [GENESIS_BLOCK];

  constructor(initial?: Block[]) {
    if (initial && initial.length) {
      if (!this.replaceChain(initial)) {
        throw new Error('Invalid initial chain');
      }
    }
  }

  getBlocks(): Block[] {
    return this.chain.slice();
  }

  getState(): ChainState {
    const last = this.getLastBlock();
    return { length: this.chain.length, lastHash: last.hash };
  }

  getLastBlock(): Block {
    return this.chain[this.chain.length - 1];
  }

  static calculateHash(index: number, timestamp: number, previousHash: string, data: unknown, nonce: number, difficulty: number): string {
    return hashOfFields(index, timestamp, previousHash, data, nonce, difficulty);
  }

  static isHashValidForDifficulty(hash: string, difficulty: number): boolean {
    const prefix = '0'.repeat(difficulty);
    return hash.startsWith(prefix);
  }

  validateBlock(block: Block, prev?: Block): boolean {
    const previous = prev ?? this.getLastBlock();
    if (block.index !== previous.index + 1) return false;
    if (block.previousHash !== previous.hash) return false;
    const expectedHash = Blockchain.calculateHash(block.index, block.timestamp, block.previousHash, block.data, block.nonce, block.difficulty);
    if (block.hash !== expectedHash) return false;
    if (!Blockchain.isHashValidForDifficulty(block.hash, block.difficulty)) return false;
    return true;
  }

  tryAppend(block: Block): boolean {
    if (!this.validateBlock(block)) return false;
    this.chain.push(block);
    return true;
  }

  replaceChain(newChain: Block[]): boolean {
    if (!Array.isArray(newChain) || newChain.length === 0) return false;
    // Validate genesis equality
    const genesis = newChain[0];
    const equalGenesis = JSON.stringify(genesis) === JSON.stringify(GENESIS_BLOCK);
    if (!equalGenesis) return false;

    // Validate entire chain
    for (let i = 1; i < newChain.length; i++) {
      const prev = newChain[i - 1];
      const cur = newChain[i];
      const expectedHash = Blockchain.calculateHash(cur.index, cur.timestamp, cur.previousHash, cur.data, cur.nonce, cur.difficulty);
      if (cur.hash !== expectedHash) return false;
      if (cur.previousHash !== prev.hash) return false;
      if (!Blockchain.isHashValidForDifficulty(cur.hash, cur.difficulty)) return false;
      if (cur.index !== prev.index + 1) return false;
    }

    if (newChain.length > this.chain.length) {
      this.chain = newChain.slice();
      return true;
    }
    return false;
  }

  mineNextBlock(data: unknown, opts?: { difficulty?: number }): Block {
    const prev = this.getLastBlock();
    const index = prev.index + 1;
    const difficulty = opts?.difficulty ?? prev.difficulty; // keep steady for now
    const previousHash = prev.hash;
    let nonce = 0;
    let timestamp = Date.now();

    while (true) {
      const hash = Blockchain.calculateHash(index, timestamp, previousHash, data, nonce, difficulty);
      if (Blockchain.isHashValidForDifficulty(hash, difficulty)) {
        const block: Block = { index, timestamp, previousHash, data, nonce, difficulty, hash };
        this.chain.push(block);
        return block;
      }
      nonce++;
      // Refresh timestamp occasionally to avoid stale timestamps
      if (nonce % 5000 === 0) {
        timestamp = Date.now();
      }
    }
  }
}

