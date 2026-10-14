'use strict';
// Consistent online backup of the database (safe while the server is running).
//   node scripts/backup.js                 -> ./backups/app-YYYY-MM-DD.db
//   node scripts/backup.js /path/to/out.db
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const src = process.env.DATABASE_PATH || './data/app.db';
const out = process.argv[2] || `./backups/app-${new Date().toISOString().slice(0, 10)}.db`;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
if (fs.existsSync(out)) fs.unlinkSync(out);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${path.resolve(out).replace(/'/g, "''")}'`);
db.close();
console.log(`Backup written to ${out}`);
