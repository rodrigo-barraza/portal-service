// ─── MongoDB Connection Wrapper ─────────────────────────────
// Delegates to @rodrigo-barraza/service-library/mongo.
// Preserves the MongoWrapper.createClient / getDb interface
// that portal-service consumers expect.
// ─────────────────────────────────────────────────────────────

import { connectDB, getDB, disconnectDB } from "@rodrigo-barraza/service-library/mongo";
import type { Db } from "mongodb";
import logger from "../utils/logger.ts";

export default class MongoWrapper {
  static async createClient(dbName: string, uri: string): Promise<void> {
    await connectDB(uri, { dbName, name: dbName, logger });
  }

  static getDb(dbName: string): Db | null {
    try {
      return getDB(dbName);
    } catch {
      return null;
    }
  }

  static async closeAll(): Promise<void> {
    await disconnectDB();
  }
}
