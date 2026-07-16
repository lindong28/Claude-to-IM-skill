import { loadConfig } from './config.js';

try {
  loadConfig();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Configuration error'}\n`);
  process.exitCode = 1;
}
