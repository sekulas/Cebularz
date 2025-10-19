#!/usr/bin/env node
import { Command } from 'commander';
import inquirer from 'inquirer';
import { Wallet } from './wallet.js';
import { BASE64 } from './const.js';
import { assertStrongPassword, estimatePasswordStrength } from './password-strength.js';

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
    const { masterPassword } = await inquirer.prompt([
      { type: 'password', name: 'masterPassword', message: 'Set master password', mask: '*' }
    ]);
    let strength = estimatePasswordStrength(masterPassword);
    try {
      assertStrongPassword(masterPassword);
    } catch (e) {
      console.error((e as Error).message);
      console.error('Warning: Chosen master password is weak.');
      const { cont } = await inquirer.prompt([
        { type: 'confirm', name: 'cont', message: 'Continue anyway with weak password?', default: false }
      ]);
      if (!cont) {
        console.log('Aborted. Wallet not created.');
        process.exit(2);
      }
      strength = estimatePasswordStrength(masterPassword);
    }
    const wallet = await Wallet.create(file);
    wallet.initializeMaster(masterPassword);
    await wallet.save();
    console.log('Wallet created:', file);
    console.log(`Master password entropy≈${strength.entropyBits} bits`);
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
      console.log('Added identity id=', id);
    } catch (e) {
      console.error('Failed to add identity:', (e as Error).message);
      process.exit(1);
    }
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
    const { masterPassword } = await inquirer.prompt([
      { type: 'password', name: 'masterPassword', message: 'Master password', mask: '*' }
    ]);
    try {
      const signatureB64 = wallet.signMessage(id, masterPassword, opts.message);
      console.log(`signature(${BASE64})=`, signatureB64);
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