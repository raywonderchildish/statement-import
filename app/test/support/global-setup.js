// Generates the >10 MiB fixture with the kit's own command if it is not there yet.
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

module.exports = async () => {
  const kit = resolve(__dirname, '../../../mobile-engineer-kit');
  if (!existsSync(join(kit, 'fixtures', 'oversize.csv'))) {
    execFileSync(process.execPath, [join(kit, 'make-oversize.mjs')], { stdio: 'ignore' });
  }
};
