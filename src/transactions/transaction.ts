import { createHash } from "crypto";
import { BASE64, HASH_ID_ALGO } from "../wallet/const.js";
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
    
    const dataToSign: string = transaction.id;

    const referencedUnspentTxOut: UnspentTxOut = findUnspentTxOut(txIn.txOutId, txIn.txOutIndex, aUnspentTxOuts);
    const referencedAddress: string = referencedUnspentTxOut.address;

    const keyObj = createPrivateKey(privateKey);
    const signature: string = edSign(null, Buffer.from(dataToSign), keyObj).toString(BASE64);
    return signature;
}