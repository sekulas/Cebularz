#!/usr/bin/env node
import { Command } from 'commander';
import inquirer from 'inquirer';
import { Wallet } from './wallet.js';
import { BASE64 } from './const.js';
import { assertStrongPassword, estimatePasswordStrength } from './password-strength.js';
import log from "loglevel";
import { signTxIn, Transaction, TxIn, UnspentTxOut } from '../transactions/transaction.ts';
import { createTxOuts, findTxOutsForAmount } from '../transactions/making-tx.ts';

log.setLevel("info");

const program = new Command();
program
  .name('wallet')
  .description('Cebularz Wallet CLI (Etap 1)')
  .version('0.1.0');

program
  .command('init')
  .argument('<file>', 'wallet file path')
  .action(async (file) => {
    if (await Wallet.exists(file)) {
      log.error('File already exists.');
      process.exit(1);
    }
    const { masterPassword } = await inquirer.prompt([
      { type: 'password', name: 'masterPassword', message: 'Set master password', mask: '*' }
    ]);
    let strength = estimatePasswordStrength(masterPassword);
    try {
      assertStrongPassword(masterPassword);
    } catch (e) {
      log.error((e as Error).message);
      log.error('Warning: Chosen master password is weak.');
      const { cont } = await inquirer.prompt([
        { type: 'confirm', name: 'cont', message: 'Continue anyway with weak password?', default: false }
      ]);
      if (!cont) {
        log.info('Aborted. Wallet not created.');
        process.exit(2);
      }
    }
    const wallet = await Wallet.create(file);
    wallet.initializeMaster(masterPassword);
    await wallet.save();
    log.info('Wallet created:', file);
    log.info(`Master password entropy≈${strength.entropyBits} bits`);
  });

program
  .command('add-identity')
  .argument('<file>', 'wallet file path')
  .option('-l, --label <label>', 'label', 'identity')
  .action(async (file, opts) => {
    const wallet = await Wallet.open(file);
    const { masterPassword } = await inquirer.prompt([
      { type: 'password', name: 'masterPassword', message: 'Master password', mask: '*' }
    ]);
    try {
      const id = wallet.addIdentity(opts.label, masterPassword).id;
      await wallet.save();
      log.info('Added identity id=', id);
    } catch (e) {
      log.error('Failed to add identity:', (e as Error).message);
      process.exit(1);
    }
  });

program
  .command('list')
  .argument('<file>', 'wallet file path')
  .action(async (file) => {
    const wallet = await Wallet.open(file);
    wallet.listIdentities().forEach(i => {
      log.info(`${i.id}  ${i.label}`);
    });
  });

program
  .command('sign-message')
  .argument('<file>', 'wallet file path')
  .argument('<id>', 'identity id')
  .requiredOption('-m, --message <message>', 'message to sign')
  .action(async (file, id, opts) => {
    const wallet = await Wallet.open(file);
    const { masterPassword } = await inquirer.prompt([
      { type: 'password', name: 'masterPassword', message: 'Master password', mask: '*' }
    ]);
    try {
      const signatureB64 = wallet.signMessage(id, masterPassword, opts.message);
      log.info(`signature(${BASE64})=`, signatureB64);
    } catch (e) {
      log.error('Signing failed:', (e as Error).message);
      process.exit(1);
    }
  });

program
  .command('verify-message')
  .argument('<file>', 'wallet file path')
  .argument('<id>', 'identity id')
  .requiredOption('-m, --message <message>', 'original message')
  .requiredOption('-s, --signature <signatureB64>', 'signature in base64')
  .action(async (file, id, opts) => {
    const wallet = await Wallet.open(file);
    try {
      const ok = wallet.verifyMessage(id, opts.message, opts.signature);
      log.info(ok ? 'VALID' : 'INVALID');
      process.exit(ok ? 0 : 2);
    } catch (e) {
      log.error('Verification failed:', (e as Error).message);
      process.exit(1);
    }
  });

program
  .command('balance')
  .argument('<nodeUrl>', 'URL of the Cebularz node, e.g. http://localhost:3000')
  .argument('<address>', 'address to check balance for')
  .action(async (nodeUrl, address) => {
    try {
      const res = await fetch(`${nodeUrl}/balance/${address}`);
      if (!res.ok) {
        log.error('Failed to fetch balance:', res.statusText);
        process.exit(1);
      }
      const data = await res.json();
      log.info(`Balance for address ${address}: ${data.balance}`);
    } catch (e) {
      log.error('Error fetching balance:', (e as Error).message);
      process.exit(1);
    }
  });

program
  .command('utxos')
  .argument('<nodeUrl>', 'URL of the Cebularz node, e.g. http://localhost:3000')
  .argument('<address>', 'address to list UTXOs for')
  .action(async (nodeUrl, address) => {
    try {
      const res = await fetch(`${nodeUrl}/unspent/${address}`);
      if (!res.ok) {
        log.error('Failed to fetch UTXOs:', res.statusText);
        process.exit(1);
      }
      const data: UnspentTxOut[] = await res.json();
      if (data.length === 0) {
        log.info(`No UTXOs found for address ${address}.`);
      } else {
        log.info(`UTXOs for address ${address}:`);
        log.info(data);
      }
    } catch (e) {
      log.error('Error fetching UTXOs:', (e as Error).message);
      process.exit(1);
    }
  });

program
  .command('send')
  .argument('<file>', 'wallet file path')
  .argument('<id>', 'sender identity id (address)')
  .argument('<receiverAddress>', 'receiver address')
  .argument('<amount>', 'amount to send')
  .argument('<nodeUrl>', 'URL of the node')
  .action(async (file, id, receiverAddress, amountStr, nodeUrl) => {
    const amount = parseInt(amountStr);
    
    const wallet = await Wallet.open(file);

    const { masterPassword } = await inquirer.prompt([
      { type: "password", name: 'masterPassword', message: 'Master password', mask: '*'}
    ])

    try {
      const privateKey = wallet.decryptPrivateKey(id, masterPassword)
      const publicKey = wallet.getPublicKey(id);

      if (publicKey == undefined) {
        throw new Error('not found pub key for given id');
      }

      const myAddress = id;
      const utxoRes = await fetch(`${nodeUrl}/unspent/${myAddress}`);
      const myUTxOs: UnspentTxOut[] = utxoRes.data;

      const {leftover, includedUTxOs} = findTxOutsForAmount(amount, myUTxOs)

      const unsignedTxIns: TxIn[] = includedUTxOs.map(u => {
        return new TxIn(u.txOutId, u.txOutIndex, '', publicKey)
      })

      const txOuts = createTxOuts(receiverAddress, amount, leftover, myAddress)
      const tx = new Transaction(unsignedTxIns, txOuts)

      tx.txIns = tx.txIns.map((txIn, index) => {
        txIn.signature = signTxIn(tx, index, privateKey, myUTxOs);
        return txIn;
      })

      log.info('Sending transaction ID:', tx.id);
      const sendRes = await fetch(`${nodeUrl}/transactions`, {
        method: 'POST', 
        body: JSON.stringify(tx)
      })
      log.info('Success!', sendRes.body);
    } catch (e) {
      log.error('Transaction failed:', e);
    }
  });

program.parseAsync(process.argv);