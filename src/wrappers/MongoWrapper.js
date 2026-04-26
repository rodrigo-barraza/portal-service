// ============================================================
// Portal API — MongoDB Connection Wrapper
// ============================================================
// Same pattern as Prism and Sessions.
// ============================================================

import { MongoClient } from "mongodb";
import logger from "../utils/logger.js";

const clients = {};
const dbs = {};

export default class MongoWrapper {
  /**
   * Create and cache a MongoDB connection.
   * @param {string} dbName
   * @param {string} uri
   */
  static async createClient(dbName, uri) {
    if (clients[dbName]) return;

    const client = new MongoClient(uri);
    await client.connect();
    clients[dbName] = client;
    dbs[dbName] = client.db(dbName);
    logger.success(`MongoDB connected → ${dbName}`);
  }

  /**
   * Get the database instance for a given name.
   * @param {string} dbName
   * @returns {import("mongodb").Db | null}
   */
  static getDb(dbName) {
    return dbs[dbName] || null;
  }

  /**
   * Close all connections.
   */
  static async closeAll() {
    for (const [name, client] of Object.entries(clients)) {
      await client.close();
      logger.info(`MongoDB disconnected → ${name}`);
    }
  }
}
