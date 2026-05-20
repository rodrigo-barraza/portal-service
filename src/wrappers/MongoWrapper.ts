// ─── MongoDB Connection Wrapper ─────────────────────────────

import { MongoClient, Db } from "mongodb";
import logger from "../utils/logger.ts";

const clients: Record<string, MongoClient> = {};
const dbs: Record<string, Db> = {};

export default class MongoWrapper {
    static async createClient(dbName: string, uri: string): Promise<void> {
    if (clients[dbName]) return;

    const client = new MongoClient(uri);
    await client.connect();
    clients[dbName] = client;
    dbs[dbName] = client.db(dbName);
    logger.success(`MongoDB connected → ${dbName}`);
  }

    static getDb(dbName: string): Db | null {
    return dbs[dbName] || null;
  }

    static async closeAll(): Promise<void> {
    for (const [name, client] of Object.entries(clients)) {
      await client.close();
      logger.info(`MongoDB disconnected → ${name}`);
    }
  }
}
