#!/usr/bin/env node

import { createCLI } from './cli.js';

// Create and run CLI
const program = createCLI();
program.parse();
