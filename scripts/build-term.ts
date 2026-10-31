/** `npm run term`: TERM.asm → src/programs/TERM.prg. */
import { writeFileSync } from 'node:fs';
import { buildTerm } from './term';

const prg = buildTerm();
writeFileSync(new URL('../src/programs/TERM.prg', import.meta.url), prg);
console.log(`TERM.prg: ${prg.length} bytes`);
