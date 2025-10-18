#!/usr/bin/env node
import { Command } from 'commander';
import inquirer from 'inquirer';
import { Wallet } from './wallet.js';

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
      console.error('File already exists.');
      process.exit(1);
    }
    const wallet = await Wallet.create(file);
    console.log('Wallet created:', file);
    console.log('CreatedAt:', wallet['data'].createdAt);
  });

program
  .command('add-identity')
  .argument('<file>', 'wallet file path')
  .option('-l, --label <label>', 'label', 'identity')
  .action(async (file, opts) => {
    const wallet = await Wallet.open(file);
    const { password } = await inquirer.prompt([
      { type: 'password', name: 'password', message: 'Password to encrypt private key', mask: '*' }
    ]);
    const id = wallet.addIdentity(opts.label, password).id;
    await wallet.save();
    console.log('Added identity id=', id);
  });

program
  .command('list')
  .argument('<file>', 'wallet file path')
  .action(async (file) => {
    const wallet = await Wallet.open(file);
    wallet.listIdentities().forEach(i => {
      console.log(`${i.id}  ${i.label}`);
    });
  });

program
  .command('sign-message')
  .argument('<file>', 'wallet file path')
  .argument('<id>', 'identity id')
  .requiredOption('-m, --message <message>', 'message to sign')
  .action(async (file, id, opts) => {
    const wallet = await Wallet.open(file);
    const { password } = await inquirer.prompt([
      { type: 'password', name: 'password', message: 'Password', mask: '*' }
    ]);
    try {
      const signatureB64 = wallet.signMessage(id, password, opts.message);
      console.log('signature(base64)=', signatureB64);
    } catch (e) {
      console.error('Signing failed:', (e as Error).message);
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
      console.log(ok ? 'VALID' : 'INVALID');
      process.exit(ok ? 0 : 2);
    } catch (e) {
      console.error('Verification failed:', (e as Error).message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);