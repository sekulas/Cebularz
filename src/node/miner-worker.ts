// Worker kopiący blok (Proof-of-Work) – nie blokuje głównego event loop serwera.
// Komunikacja: parentPort.postMessage({ ok: true, block, attempts, ms }) gdy sukces
//               parentPort.postMessage({ canceled: true, attempts, ms }) gdy anulowano
//               parentPort.postMessage({ ok: false, error }) przy błędzie
// Wejście: parentPort.on('message', { cmd: 'mine', payload: { prevHash, prevHeight, miner, difficulty }, cancelSAB? })
// cancelSAB: SharedArrayBuffer Int32[1]; jeśli Atomics.load(view,0) === 1 -> przerwij kopanie.

import { parentPort } from 'node:worker_threads';
import {hashBlockPayload, type Block, type BlockData} from './blockchain.ts';

interface MinePayload {
  prevHash: string;
  prevHeight: number;
  miner: string; // identyfikator/url węzła kopiącego
  difficulty: number; // liczba wiodących zer hex
  transactions: []; //dodać typ jak zaimplementujemy transakcje
}

interface MineCmd {
  cmd: 'mine';
  payload: MinePayload;
  cancelSAB?: SharedArrayBuffer;
}

function meetsDifficulty(hash: string, difficulty: number): boolean {
  if (difficulty <= 0) return true;
  if (difficulty > 64) return false; // długość hex sha256
  return hash.startsWith('0'.repeat(difficulty));
}

function mineBlock(payload: MinePayload, cancelView?: Int32Array): { block?: Block; attempts: number; ms: number; canceled?: boolean; error?: string } {
  const start = Date.now();
  const { prevHash, prevHeight, miner, transactions, difficulty } = payload;
  if (!prevHash || prevHash.length !== 64) return { attempts: 0, ms: 0, error: 'Invalid prevHash' };
  if (difficulty < 0 || difficulty > 64) return { attempts: 0, ms: 0, error: 'Invalid difficulty' };

  // Konstruujemy stałe pola kandydata bloku (timestamp zamrożony na start kopania)
  const height = prevHeight + 1;
  const timestamp = Date.now();
  const data :BlockData = { miner, transactions };
  const prevHashFixed = prevHash;

  let nonce = 0;
  let attempts = 0;

  // Pętla PoW – iterujemy nonce aż hash spełni trudność albo anulowano.
  while (true) {
    const candidateWithoutHash = { height, timestamp, prevHash: prevHashFixed, data, nonce, difficulty } as Omit<Block, 'hash'>;
    const hash = hashBlockPayload(candidateWithoutHash);
    attempts++;
    if (meetsDifficulty(hash, difficulty)) {
      const block: Block = { ...candidateWithoutHash, hash };
      return { block, attempts, ms: Date.now() - start };
    }
    nonce++;

    // Co 4096 prób sprawdzamy anulowanie aby zredukować narzut Atomics.
    if ((attempts & 0xFFF) === 0) {
      if (cancelView && Atomics.load(cancelView, 0) === 1) {
        return { attempts, ms: Date.now() - start, canceled: true };
      }
    }

    // Opcjonalne lekkie „ustąpienie” event loopa workera przy bardzo dużej liczbie prób
    if ((attempts & 0x3FFFF) === 0) {
      // Pozwala innym zdarzeniom wejść – minimalna pauza
      // (Brak await – worker pozostaje synchroniczny, ale dajemy szansę GC / I/O) – no-op
    }
  }
}

parentPort?.on('message', (msg: MineCmd) => {
  if (!msg || msg.cmd !== 'mine') return;
  try {
    const cancelView = msg.cancelSAB ? new Int32Array(msg.cancelSAB) : undefined;
    const { block, attempts, ms, canceled, error } = mineBlock(msg.payload, cancelView);
    if (error) {
      parentPort?.postMessage({ ok: false, error });
      return;
    }
    if (canceled) {
      parentPort?.postMessage({ canceled: true, attempts, ms });
      return;
    }
    parentPort?.postMessage({ ok: true, block, attempts, ms });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: (e as Error).message || String(e) });
  }
});

// Sygnalizuj gotowość (opcjonalne – może pomóc w debugowaniu)
parentPort?.postMessage({ ready: true });
