#!/usr/bin/env node

import { createCLI } from './cli.js';

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n');
  process.exit(0);
});

// Create and run CLI
const program = createCLI();
program.parse();
