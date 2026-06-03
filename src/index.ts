#!/usr/bin/env node

import { createCLI } from './cli.js';

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`Unhandled Promise Rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught Exception: ${error.stack ?? error.message}\n`);
  process.exit(1);
});

// Create and run CLI
const program = createCLI();
program.parse();
