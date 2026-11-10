import { DurableObject } from "cloudflare:workers";

import api from "./index.js";
import { SCHEMA } from "./schema.js";

// Minimal D1-compatible adapter over Durable Object SQLite storage, so index.js stays storage-agnostic.
class Statement {
  constructor(sql, query, bindings = []) {
    this.sql = sql;
    this.query = query;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new Statement(this.sql, this.query, bindings);
  }

  execute() {
    const cursor = this.sql.exec(this.query, ...this.bindings);
    const results = cursor.toArray();
    return { results, changes: cursor.rowsWritten };
  }

  async first() {
    return this.execute().results[0] ?? null;
  }

  async all() {
    return { results: this.execute().results };
  }

  async run() {
    return { success: true, meta: { changes: this.execute().changes } };
  }
}

class Database {
  constructor(storage) {
    this.storage = storage;
  }

  prepare(query) {
    return new Statement(this.storage.sql, query);
  }

  async batch(statements) {
    return this.storage.transactionSync(() => statements.map(statement => {
      const result = statement.execute();
      return { success: true, results: result.results, meta: { changes: result.changes } };
    }));
  }
}

export class AnnotationStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = new Database(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA);
    });
  }

  async fetch(request) {
    return api.fetch(request, { ...this.env, DB: this.db });
  }
}

export default {
  async fetch(request, env) {
    // A single study-wide store keeps all experts' annotations in one SQLite database.
    return env.STORE.getByName(env.STORE_NAME || "cbt-annotation-study-v1").fetch(request);
  }
};
