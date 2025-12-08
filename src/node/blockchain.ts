import { createHash } from 'crypto';
import { Transaction } from '../transactions/transaction.ts';

export interface BlockData {
  miner: string; // url minera
  transactions: Transaction[];
}

export interface Block {
  height: number; // 0 = genesis
  timestamp: number; // ms
  prevHash: string;
  data: BlockData;
  nonce: number; // proof-of-work nonce
  difficulty: number; // ilość wiodących zer w hashu (hex)
  hash: string; // sha256(header+data)
}

function sha256Hex(parts: (string|number)[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(String(p));
  return h.digest('hex');
}

export function hashBlockPayload(payload: Omit<Block, 'hash'>): string {
  return sha256Hex([
    payload.height,
    payload.timestamp,
    payload.prevHash,
    JSON.stringify(payload.data),
    payload.nonce,
    payload.difficulty
  ]);
}

export function meetsDifficulty(hashHex: string, difficulty: number): boolean {
  if (difficulty <= 0) return true;
  if (difficulty > 64) return false; // sha256 hex len = 64
  const target = '0'.repeat(difficulty);
  return hashHex.startsWith(target);
}

export function createGenesisBlock(): Block {
  const payload: Omit<Block, 'hash'> = {
    height: 0,
    timestamp: 0,
    prevHash: '0'.repeat(64),
    data: { miner: 'genesis', transactions: [] },
    nonce: 0,
    difficulty: 0
  };
  const hash = hashBlockPayload(payload);
  return { ...payload, hash };
}

export function isValidNewBlock(block: Block, prev: Block, expectedDifficulty?: number): { ok: true } | { ok: false; reason: string } {
  if (block.height !== prev.height + 1) return { ok: false, reason: `height mismatch (expected ${prev.height + 1}, got ${block.height})` };
  if (block.prevHash !== prev.hash) return { ok: false, reason: 'prevHash mismatch' };
  if (expectedDifficulty !== undefined && block.difficulty !== expectedDifficulty) return { ok: false, reason: 'difficulty mismatch' };
  const expected = hashBlockPayload({ height: block.height, timestamp: block.timestamp, prevHash: block.prevHash, data: block.data, nonce: block.nonce, difficulty: block.difficulty });
  if (expected !== block.hash) return { ok: false, reason: 'hash mismatch' };
  if (!meetsDifficulty(block.hash, block.difficulty)) return { ok: false, reason: 'does not meet difficulty' };
  if (block.timestamp - Date.now() > 60_000) return { ok: false, reason: 'timestamp too far in future' };
  if (block.timestamp < prev.timestamp) return { ok: false, reason: 'timestamp earlier than previous block' };
  return { ok: true };
}

export function validateChain(chain: Block[], expectedDifficulty?: number): { ok: true } | { ok: false; reason: string } {
  if (!chain.length) return { ok: false, reason: 'empty chain' };
  const genesis = createGenesisBlock();
  const first = chain[0];
  if (JSON.stringify(first) !== JSON.stringify(genesis)) return { ok: false, reason: 'invalid genesis' };
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1];
    const cur = chain[i];
    const v = isValidNewBlock(cur, prev, expectedDifficulty);
    if (!v.ok) return { ok: false, reason: `block ${i} invalid: ${v.reason}` };
  }
  return { ok: true };
}
