import { readdir, readFile } from 'node:fs/promises';
import { pool } from './pool.js';

const dir = new URL('./migrations/', import.meta.url);

export async function migrate(log = console.log): Promise<void> {
  await pool.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await pool.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, dir), 'utf8');
    const requires = sql.match(/^-- @requires (\w+)/m)?.[1];
    if (requires) {
      const { rowCount } = await pool.query('select 1 from pg_available_extensions where name = $1', [requires]);
      if (!rowCount) {
        log(`skip ${file} (extension ${requires} not available)`);
        continue;
      }
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      log(`applied ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
