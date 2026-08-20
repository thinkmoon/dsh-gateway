#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`dsh-gateway: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
