// D1-style adapter over node:sqlite, used by the local preview server and the tests.
// Applies the same migrations as Cloudflare D1 (worker/migrations/*.sql).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

class Statement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) {
    return new Statement(this.db, this.sql, bindings);
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.bindings) || null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.bindings) };
  }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

export class Database {
  constructor(filename = ":memory:") {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)");
    for (const file of fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort()) {
      if (this.db.prepare("SELECT 1 FROM local_migrations WHERE name = ?").get(file)) continue;
      this.db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      this.db.prepare("INSERT INTO local_migrations (name) VALUES (?)").run(file);
    }
  }
  exec(sql) {
    this.db.exec(sql);
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
