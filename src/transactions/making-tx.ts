import { TxOut, UnspentTxOut } from "./transaction.ts";

export const findTxOutsForAmount = (amount: number, myUTxOs: UnspentTxOut[]): { leftover: number, includedUTxOs: UnspentTxOut[] } => {
    let currentAmount = 0;
    const includedUTxOs: UnspentTxOut[] = [];

    for (const uTxO of myUTxOs) {
        includedUTxOs.push(uTxO);
        currentAmount += uTxO.amount;
        if (currentAmount >= amount) {
            const leftover = currentAmount - amount;
            return { leftover, includedUTxOs };
        }
    }

    throw Error('not enough coins to spend');
}

export const createTxOuts = (receiverAddress: string, amount: number, leftover: number, myAddress: string): TxOut[] => {
    const desiredTxOut: TxOut = new TxOut(receiverAddress, amount);
    if (leftover > 0) {
        const leftTxOut: TxOut = new TxOut(myAddress, leftover);
        return [desiredTxOut, leftTxOut];
    } else {
        return [desiredTxOut];
    }
}
