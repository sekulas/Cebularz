#!/usr/bin/env node
import { Command } from 'commander';
import { startNode } from './node.js';

const program = new Command();
program
  .name('node')
  .description('Cebularz Node CLI (Prosty blockchain: 1 górnik)')
  .version('0.2.0');

program
  .option('-p, --port <port>', 'listening port')
  .option('-b, --bootstrap <urls>', 'comma separated bootstrap peer URLs (http://localhost:4000,http://localhost:4001)')
  .option('-m, --miner', 'enable single-miner mode')
  .action(opts => {
    const port = parseInt(opts.port, 10);
    if (
      isNaN(port) ||
      port < 1 ||
      port > 65535
    ) {
      console.error('Error: Invalid port specified. Please provide a port number between 1 and 65535 using the -p or --port option.');
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
    startNode(port, bootstrap, miner);
  });

program.parseAsync(process.argv);
