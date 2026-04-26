// ============================================================
// API Portal — Portfolio Route
// ============================================================
// GET/PUT /portfolio — portfolio content and projects.
// ============================================================

import { Router } from "express";
import PortfolioService from "../services/PortfolioService.js";

const router = Router();

/**
 * GET /portfolio
 * Returns portfolio content (bio, skills, social links) and projects.
 */
router.get("/", async (_req, res, next) => {
  try {
    const [content, projects] = await Promise.all([
      PortfolioService.getContent(),
      PortfolioService.getProjects(),
    ]);

    res.json({ content, projects });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /portfolio/projects
 * Returns just the project list.
 */
router.get("/projects", async (_req, res, next) => {
  try {
    const projects = await PortfolioService.getProjects();
    res.json({ projects });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /portfolio/content
 * Update portfolio content (bio, skills, social links, etc.)
 */
router.put("/content", async (req, res, next) => {
  try {
    const result = await PortfolioService.updateContent(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /portfolio/projects
 * Create or update a portfolio project.
 */
router.put("/projects", async (req, res, next) => {
  try {
    const result = await PortfolioService.upsertProject(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /portfolio/projects/:id
 * Delete a portfolio project.
 */
router.delete("/projects/:id", async (req, res, next) => {
  try {
    await PortfolioService.deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
