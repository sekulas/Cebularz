#!/usr/bin/env node
import { Command } from 'commander';
import { startNode } from './node.js';

const program = new Command();
program
  .name('node')
  .description('Cebularz Node CLI (Etap 1)')
  .version('0.1.0');

program
  .option('-p, --port <port>', 'listening port')
  .option('-b, --bootstrap <urls>', 'comma separated bootstrap peer URLs (http://localhost:4000,http://localhost:4001)')
  .action(opts => {
    const port = parseInt(opts.port, 10);
    let bootstrap: string[] | undefined;
    if (opts.bootstrap) {
      bootstrap = String(opts.bootstrap)
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
    }
    startNode(port, bootstrap);
  });

program.parseAsync(process.argv);
