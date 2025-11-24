import { generateTransactionId, Transaction, TxIn, TxOut } from "./transaction.ts";

const COINBASE_AMOUNT: number = 100;

export const getCoinbaseTransaction = (address: string, blockIndex: number): Transaction => {
    const txIn: TxIn = new TxIn('', blockIndex, '', '');
    const txOut: TxOut = new TxOut(address, COINBASE_AMOUNT);
    return new Transaction([txIn], [txOut]);
};

export const validateCoinbaseTx = (transaction: Transaction, blockIndex: number): boolean => {
    if (generateTransactionId(transaction.txIns, transaction.txOuts) !== transaction.id) {
        console.log('invalid coinbase tx id: ' + transaction.id);
        return false;
    }

    if (transaction.txIns.length !== 1) {
        console.log('one txIn must be specified in the coinbase transaction');
        return false;
    }

    if (transaction.txIns[0]?.txOutIndex !== blockIndex) {
        console.log('the txIn index in coinbase tx must be the block height');
        return false;
    }

    if (transaction.txOuts.length !== 1) {
        console.log('invalid number of txOuts in coinbase transaction');
        return false;
    }

    if (transaction.txOuts[0]?.amount != COINBASE_AMOUNT) {
        console.log('invalid coinbase amount in coinbase transaction');
        return false;
    }

    return true;
};