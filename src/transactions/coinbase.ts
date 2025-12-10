import { generateTransactionId, Transaction, TxIn, TxOut } from "./transaction.ts";
import log from "loglevel";

const COINBASE_AMOUNT: number = 100;

export const getCoinbaseTransaction = (address: string, blockIndex: number): Transaction => {
    const txIn: TxIn = new TxIn('', blockIndex, '', '');
    const txOut: TxOut = new TxOut(address, COINBASE_AMOUNT);
    return new Transaction([txIn], [txOut], Date.now());
};

export const validateCoinbaseTx = (transaction: Transaction, blockIndex: number): boolean => {
    if (generateTransactionId(transaction) !== transaction.id) {
        log.debug('invalid coinbase tx id: ' + transaction.id);
        return false;
    }

    if (transaction.txIns.length !== 1) {
        log.debug('one txIn must be specified in the coinbase transaction');
        return false;
    }

    if (transaction.txIns[0]?.txOutIndex !== blockIndex) {
        log.debug('the txIn index in coinbase tx must be the block height');
        return false;
    }

    if (transaction.txOuts.length !== 1) {
        log.debug('invalid number of txOuts in coinbase transaction');
        return false;
    }

    if (transaction.txOuts[0]?.amount != COINBASE_AMOUNT) {
        log.debug('invalid coinbase amount in coinbase transaction');
        return false;
    }

    return true;
};