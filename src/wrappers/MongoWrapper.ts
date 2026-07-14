// ─── MongoDB Connection Wrapper ─────────────────────────────
// Delegates to @rodrigo-barraza/utilities-library/service/mongo.
// Preserves the MongoWrapper.createClient / getDb interface
// that portal-service consumers expect.
// ─────────────────────────────────────────────────────────────

import { connectDatabase, getDatabase, disconnectDatabase } from "@rodrigo-barraza/utilities-library/service/mongo";
import type { Db } from "mongodb";
import logger from "../utils/logger.ts";

export default class MongoWrapper {
  static async createClient(dbName: string, uri: string): Promise<void> {
    await connectDatabase(uri, { dbName, name: dbName, logger });
  }

  static getDb(dbName: string): Db | null {
    try {
      return getDatabase(dbName);
    } catch {
      return null;
    }
  }

  static async closeAll(): Promise<void> {
    await disconnectDatabase();
  }
}
