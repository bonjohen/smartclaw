import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

let singleton: Database.Database | null = null;

/**
 * Initialize a database connection and run all pending migrations.
 * Pass ":memory:" for dbPath to use an in-memory database (tests).
 */
export function initDb(dbPath: string): Database.Database {
  // Ensure parent directory exists for file-based DBs
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

/**
 * Run all SQL migration files that haven't been applied yet.
 * Tracks applied migrations in a _migrations meta table.
 */
export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Read migration files, sorted by name
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all()
      .map((row: any) => row.filename)
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

    // Split on semicolons to execute statements individually
    // (better-sqlite3's exec handles multiple statements, but PRAGMA
    //  journal_mode must be outside a transaction)
    const hasPragma = sql.includes('PRAGMA journal_mode');

    if (hasPragma) {
      // Execute PRAGMA statements outside transaction, then the rest inside
      const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        if (stmt.toUpperCase().startsWith('PRAGMA')) {
          db.exec(stmt);
        } else {
          // Collect non-PRAGMA statements and run in a transaction
          break;
        }
      }
      const nonPragma = statements.filter(s => !s.toUpperCase().startsWith('PRAGMA'));
      if (nonPragma.length > 0) {
        db.transaction(() => {
          for (const stmt of nonPragma) {
            db.exec(stmt);
          }
        })();
      }
    } else {
      db.transaction(() => {
        db.exec(sql);
      })();
    }

    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

/**
 * Get or create the singleton database instance.
 * Call initDb() first in production; this is a convenience accessor.
 */
export function getDb(): Database.Database {
  if (!singleton) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return singleton;
}

/**
 * Set the singleton database instance (called by initDb in production, or directly in tests).
 */
export function setDb(db: Database.Database): void {
  singleton = db;
}

/**
 * Close the singleton database connection.
 */
export function closeDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

// If run directly (npm run migrate), initialize the database
if (process.argv.includes('--migrate')) {
  const { loadConfig } = await import('./config.js');
  const config = loadConfig();
  const db = initDb(config.dbPath);
  setDb(db);
  console.log(`Database initialized at ${config.dbPath}`);
  console.log('Migrations applied successfully.');
  closeDb();
}
