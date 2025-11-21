import { createHash } from "crypto";
import { BASE64, HASH_ID_ALGO, HEX } from "../wallet/const.js";
import { createPrivateKey, sign as edSign, verify as edVerify } from 'crypto';

export class TxIn {
    public txOutId: string;
    public txOutIndex: number;
    public signature: string;
    public publicKey: string;

    constructor(txOutId: string, txOutIndex: number, signature: string, publicKey: string) {
        this.txOutId = txOutId;
        this.txOutIndex = txOutIndex;
        this.signature = signature;
        this.publicKey = publicKey;
    }
}

export class TxOut {
    public address: string;
    public amount: number;

    constructor(address: string, amount: number) {
        this.address = address;
        this.amount = amount;
    }
}

export class Transaction {
    public id: string
    public txIns: TxIn[]
    public txOuts: TxOut[]

    constructor(id: string, txIns: TxIn[], txOuts: TxOut[]) {
        this.id = id;
        this.txIns = txIns;
        this.txOuts = txOuts;
    }
}

export class UnspentTxOut {
    public readonly txOutId: string;
    public readonly txOutIndex: number
    public readonly address: string;
    public readonly amount: number;

    constructor(txOutId: string, txOutIndex: number, address: string, amount: number) {
        this.txOutId = txOutId;
        this.txOutIndex = txOutIndex;
        this.address = address;
        this.amount = amount;
    }
}

const getTransactionId = (transaction: Transaction): string => {
    const txInContent: string = transaction.txIns
        .map((txIn) => txIn.txOutId + txIn.txOutIndex)
        .reduce((acc, val) => acc + val, '');

    const txOutContent: string = transaction.txOuts
        .map((txOut) => txOut.address + txOut.amount)
        .reduce((acc, val) => acc + val, '');

    return createHash(HASH_ID_ALGO).update(txInContent + txOutContent).digest('hex');
}

const signTxIn = (transaction: Transaction, txInIndex: number, privateKey: string, aUnspentTxOuts: UnspentTxOut[]): string => {
    const txIn: TxIn | undefined = transaction.txIns[txInIndex];
    if (!txIn) {
        throw new Error('TxIn not found at index ' + txInIndex);
    }

    const referencedUnspentTxOut: UnspentTxOut | undefined = findUnspentTxOut(txIn.txOutId, txIn.txOutIndex, aUnspentTxOuts);
    if (!referencedUnspentTxOut) throw new Error('Referenced UTXO not found');

    const derivedAddress = createHash(HASH_ID_ALGO).update(txIn.publicKey).digest(HEX);
    if (derivedAddress !== referencedUnspentTxOut.address) throw new Error('Public key does not match UTXO owner');

    const msg = Buffer.from(transaction.id);
    const keyObj = createPrivateKey(privateKey);
    return edSign(null, msg, keyObj).toString(BASE64);
}

const findUnspentTxOut = (transactionId: string, index: number, aUnspentTxOuts: UnspentTxOut[]): UnspentTxOut | undefined => {
    return aUnspentTxOuts.find((uTxO) => uTxO.txOutId === transactionId && uTxO.txOutIndex === index);
}  


const updateUnspentTxOuts = (newTransactions: Transaction[], current: UnspentTxOut[]): UnspentTxOut[] => {
    const consumedKeys = new Set<string>();
    for (const tx of newTransactions) {
        for (const i of tx.txIns) {
            consumedKeys.add(`${i.txOutId}:${i.txOutIndex}`);
        }
    }
    
    const created: UnspentTxOut[] = [];
    for (const tx of newTransactions) {
        tx.txOuts.forEach((o, idx) => {
            created.push(new UnspentTxOut(tx.id, idx, o.address, o.amount));
        });
    }

  const result = current.filter(u => !consumedKeys.has(`${u.txOutId}:${u.txOutIndex}`));
  return result.concat(created);
}

export const isValidTransactionStructure = (raw: unknown): raw is Transaction => {
  if (!raw || typeof raw !== 'object') return false;
  const t = raw as any;
  if (typeof t.id !== 'string') return false;
  if (!Array.isArray(t.txIns) || !Array.isArray(t.txOuts)) return false;
  if (!t.txIns.every((i: any) =>
    i && typeof i.txOutId === 'string' &&
    typeof i.txOutIndex === 'number' &&
    typeof i.signature === 'string' &&
    typeof i.publicKey === 'string'
  )) return false;
  if (!t.txOuts.every((o: any) =>
    o && typeof o.address === 'string' &&
    typeof o.amount === 'number' &&
    Number.isFinite(o.amount) &&
    o.amount >= 0
  )) return false;
  return true;
};