import { createHash } from "crypto";
import { BASE64, HASH_ID_ALGO, HEX } from "../wallet/const.ts";
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'crypto';
import { validateCoinbaseTx } from "./coinbase.ts";
import _ from "lodash";

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

    constructor(txIns: TxIn[], txOuts: TxOut[]) {
        this.txIns = txIns;
        this.txOuts = txOuts;
        this.id = generateTransactionId(txIns, txOuts);
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

export const generateTransactionId = (txIns: TxIn[], txOuts: TxOut[]): string => {
    const txInContent: string = txIns
        .map((txIn) => txIn.txOutId + txIn.txOutIndex)
        .reduce((acc, val) => acc + val, '');
        
    const txOutContent: string = txOuts
        .map((txOut) => txOut.address + txOut.amount)
        .reduce((acc, val) => acc + val, '');

    return createHash(HASH_ID_ALGO).update(txInContent + txOutContent).digest(HEX);
}

export const signTxIn = (transaction: Transaction, txInIndex: number, privateKey: string, aUnspentTxOuts: UnspentTxOut[]): string => {
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

export const findUnspentTxOut = (transactionId: string, index: number, aUnspentTxOuts: UnspentTxOut[]): UnspentTxOut | undefined => {
    return aUnspentTxOuts.find((uTxO) => uTxO.txOutId === transactionId && uTxO.txOutIndex === index);
}  


export const updateUnspentTxOuts = (newTransactions: Transaction[], current: UnspentTxOut[]): UnspentTxOut[] => {
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

export const validateTransaction = (transaction: Transaction, aUnspentTxOuts: UnspentTxOut[]): boolean => {
    if (generateTransactionId(transaction.txIns, transaction.txOuts) !== transaction.id) {
        console.log('invalid tx id: ' + transaction.id);
        return false;
    }

    const hasValidTxIns: boolean = transaction.txIns
        .map((txIn) => validateTxIn(txIn, transaction, aUnspentTxOuts))
        .reduce((a, b) => a && b, true);

    if (!hasValidTxIns) {
        console.log('some of the txIns are invalid in tx: ' + transaction.id);
        return false;
    }

    const totalTxInValues: number = transaction.txIns
        .map((txIn) => getTxInAmount(txIn, aUnspentTxOuts))
        .reduce((acc, val) => (acc + val), 0);
        
    const totalTxOutValues: number = transaction.txOuts
        .map((txOut) => txOut.amount)
        .reduce((acc, val) => (acc + val), 0);

    if (totalTxOutValues !== totalTxInValues) {
        console.log('totalTxOutValues !== totalTxInValues in tx: ' + transaction.id);
        return false;
    }

    return true;
};

export const validateTxIn = (txIn: TxIn, transaction: Transaction, aUnspentTxOuts: UnspentTxOut[]): boolean => {
    const referencedUTxOut: UnspentTxOut | undefined =
        aUnspentTxOuts.find((uTxO) => uTxO.txOutId === txIn.txOutId);

    if (referencedUTxOut == undefined) {
        console.log('referenced txOut not found: ' + JSON.stringify(txIn));
        return false;
    }
    
    const address = referencedUTxOut.address;
    const derivedAddress = createHash(HASH_ID_ALGO).update(txIn.publicKey).digest(HEX);
    
    if (derivedAddress !== address) {
        console.log('public key does not match address');
        return false;
    }

    const msg = Buffer.from(transaction.id);
    const signature = Buffer.from(txIn.signature, BASE64);
    const publicKey = createPublicKey(txIn.publicKey);
    
    return edVerify(null, msg, publicKey, signature);
};

export const getTxInAmount = (txIn: TxIn, uTxOuts: UnspentTxOut[]): number => {
    const utxo = findUnspentTxOut(txIn.txOutId, txIn.txOutIndex, uTxOuts);
    if (!utxo) {
        throw new Error('Referenced UTXO not found');
    }
    return utxo.amount;
};

const hasDuplicates = (txIns: TxIn[]): boolean => {
    const groups = _.countBy(txIns, (txIn: TxIn) => txIn.txOutId + txIn.txOutIndex);
    return _(groups)
        .map((value, key) => {
            if (value > 1) {
                console.log('duplicate txIn: ' + key);
                return true;
            } else {
                return false;
            }
        })
        .includes(true);
};


const validateBlockTransactions = (txs: Transaction[], uTxOs: UnspentTxOut[], blockIndex: number): boolean => {
    const coinbaseTx = txs[0];
    if (!coinbaseTx || !validateCoinbaseTx(coinbaseTx, blockIndex)) {
        console.log('invalid coinbase transaction: ' + JSON.stringify(coinbaseTx));
        return false;
    }

    const txIns: TxIn[] = _(txs)
        .map((tx) => tx.txIns)
        .flatten()
        .value();

    if (hasDuplicates(txIns)) {
        return false;
    }

    // All but coinbase
    const normalTransactions: Transaction[] = txs.slice(1);
    return normalTransactions.map((tx) => validateTransaction(tx, uTxOs))
        .reduce((a, b) => (a && b), true);

};

export const processTransactions = (txs: Transaction[], uTxOs: UnspentTxOut[], blockIndex: number): UnspentTxOut[] | null => {
    if (!validateBlockTransactions(txs, uTxOs, blockIndex)) {
        console.log('invalid block transactions');
        return null;
    }

    // Update - remove spent UTXOs and add new UTXOs
    return updateUnspentTxOuts(txs, uTxOs);
};