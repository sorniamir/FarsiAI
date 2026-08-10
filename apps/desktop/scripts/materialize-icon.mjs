import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(here, '..', 'icon-source');
const output = join(here, '..', 'public', 'app-icon.png');
const expectedSha256 = 'c3fcc1d2032c55adccf70cfc7b2acc8728b65cdb431f5b0aff6a065af5bfc5f9';

const parts = (await readdir(sourceDir))
  .filter((name) => /^app-icon64\.b64\.part\d+$/.test(name))
  .sort((a, b) => Number(a.split('part')[1]) - Number(b.split('part')[1]));

if (parts.length !== 5) {
  throw new Error(`Expected 5 validated icon source parts, found ${parts.length}.`);
}

let encoded = '';
for (const part of parts) encoded += (await readFile(join(sourceDir, part), 'utf8')).trim();

const png = Buffer.from(encoded, 'base64');
const signature = png.subarray(0, 8).toString('hex');
if (signature !== '89504e470d0a1a0a') {
  throw new Error('Validated icon source did not decode to a PNG.');
}

const actualSha256 = createHash('sha256').update(png).digest('hex');
if (actualSha256 !== expectedSha256) {
  throw new Error(`Exact icon checksum mismatch: ${actualSha256}`);
}

await writeFile(output, png);
console.log(`Exact transparent FarsiAI icon materialized (${png.length} bytes, sha256 ${actualSha256}).`);
