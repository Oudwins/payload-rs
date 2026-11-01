import * as migration_20261101_161934 from './20261101_161934';
import * as migration_20261101_162003_blocks_as_json from './20261101_162003_blocks_as_json';

export const migrations = [
  {
    up: migration_20261101_161934.up,
    down: migration_20261101_161934.down,
    name: '20261101_161934',
  },
  {
    up: migration_20261101_162003_blocks_as_json.up,
    down: migration_20261101_162003_blocks_as_json.down,
    name: '20261101_162003_blocks_as_json'
  },
];
