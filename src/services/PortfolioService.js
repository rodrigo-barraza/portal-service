// ============================================================
// Portal API — Portfolio Service
// ============================================================
// Manages portfolio content — projects, bio, and contact info.
// MongoDB-backed for easy CRUD.
// ============================================================

import { COLLECTIONS } from "../constants.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../config.js";

export default class PortfolioService {
  static _db() {
    return MongoWrapper.getDb(MONGO_DB_NAME);
  }

  /**
   * Get all portfolio projects, sorted by display order.
   * @returns {Promise<Array>}
   */
  static async getProjects() {
    const db = PortfolioService._db();
    if (!db) return [];

    return db
      .collection(COLLECTIONS.PORTFOLIO_PROJECTS)
      .find({})
      .sort({ order: 1 })
      .toArray();
  }

  /**
   * Get portfolio content (bio, about, contact, social links, etc.)
   * Returns a single document or defaults.
   * @returns {Promise<object>}
   */
  static async getContent() {
    const db = PortfolioService._db();
    if (!db) return PortfolioService._defaultContent();

    const doc = await db
      .collection(COLLECTIONS.PORTFOLIO_CONTENT)
      .findOne({ type: "main" });

    return doc || PortfolioService._defaultContent();
  }

  /**
   * Update portfolio content (upsert).
   * @param {object} content
   * @returns {Promise<object>}
   */
  static async updateContent(content) {
    const db = PortfolioService._db();
    if (!db) throw new Error("Database not connected");

    const result = await db
      .collection(COLLECTIONS.PORTFOLIO_CONTENT)
      .findOneAndUpdate(
        { type: "main" },
        {
          $set: { ...content, updatedAt: new Date() },
          $setOnInsert: { type: "main", createdAt: new Date() },
        },
        { upsert: true, returnDocument: "after" },
      );

    return result;
  }

  /**
   * Create or update a portfolio project.
   * @param {object} project
   * @returns {Promise<object>}
   */
  static async upsertProject(project) {
    const db = PortfolioService._db();
    if (!db) throw new Error("Database not connected");

    const { id, ...rest } = project;

    const result = await db
      .collection(COLLECTIONS.PORTFOLIO_PROJECTS)
      .findOneAndUpdate(
        { id },
        {
          $set: { ...rest, updatedAt: new Date() },
          $setOnInsert: { id, createdAt: new Date() },
        },
        { upsert: true, returnDocument: "after" },
      );

    return result;
  }

  /**
   * Delete a portfolio project.
   * @param {string} id
   */
  static async deleteProject(id) {
    const db = PortfolioService._db();
    if (!db) throw new Error("Database not connected");

    await db.collection(COLLECTIONS.PORTFOLIO_PROJECTS).deleteOne({ id });
  }

  /**
   * Default portfolio content structure.
   */
  static _defaultContent() {
    return {
      type: "main",
      name: "",
      title: "",
      bio: "",
      location: "",
      email: "",
      socialLinks: [],
      skills: [],
    };
  }
}
