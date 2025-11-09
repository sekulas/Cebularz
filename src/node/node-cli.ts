#!/usr/bin/env node
import { Command } from 'commander';
import { startNode } from './node.js';
import log from "loglevel";

log.setLevel("info");

const program = new Command();
program
  .name('node')
  .description('Cebularz Node CLI (PoW, ciągłe kopanie)')
  .version('0.4.0');

program
  .option('-p, --port <port>', 'listening port')
  .option('-b, --bootstrap <urls>', 'comma separated bootstrap peer URLs (http://localhost:4000,http://localhost:4001)')
  .option('-m, --miner', 'enable miner mode')
  .option('-d, --difficulty <n>', 'hex difficulty (leading zeroes)', '2')
  .action(opts => {
    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      log.error('Error: Invalid port specified. Please provide a port number between 1 and 65535 using the -p or --port option.');
      process.exit(1);
    }
    let bootstrap: string[] | undefined;
    if (opts.bootstrap) {
      bootstrap = String(opts.bootstrap)
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
    }
    const miner: boolean = !!opts.miner;
    const difficulty = parseInt(opts.difficulty, 10);
    if (isNaN(difficulty) || difficulty < 0 || difficulty > 8) {
      log.error('Error: Invalid difficulty (0..8)');
      process.exit(1);
    }
    startNode(port, bootstrap, miner, difficulty);
  });

program.parseAsync(process.argv);
