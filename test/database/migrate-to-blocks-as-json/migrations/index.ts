import * as migration_20261101_084328 from './20261101_084328';
import * as migration_20261101_084332_blocks_as_json from './20261101_084332_blocks_as_json';

export const migrations = [
  {
    up: migration_20261101_084328.up,
    down: migration_20261101_084328.down,
    name: '20261101_084328',
  },
  {
    up: migration_20261101_084332_blocks_as_json.up,
    down: migration_20261101_084332_blocks_as_json.down,
    name: '20261101_084332_blocks_as_json'
  },
];
