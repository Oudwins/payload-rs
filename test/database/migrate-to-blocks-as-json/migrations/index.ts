import * as migration_20261101_105844 from './20261101_105844';
import * as migration_20261101_105848_blocks_as_json from './20261101_105848_blocks_as_json';

export const migrations = [
  {
    up: migration_20261101_105844.up,
    down: migration_20261101_105844.down,
    name: '20261101_105844',
  },
  {
    up: migration_20261101_105848_blocks_as_json.up,
    down: migration_20261101_105848_blocks_as_json.down,
    name: '20261101_105848_blocks_as_json'
  },
];
