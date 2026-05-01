import { pgTable, text, integer, real, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const repositoryClassificationEnum = pgEnum("repository_classification", [
  "service",
  "library",
  "tool",
  "infrastructure",
  "unknown",
]);

export const repositoriesTable = pgTable("repositories", {
  id:              text("id").primaryKey(),
  name:            text("name").notNull(),
  url:             text("url").notNull(),
  language:        text("language").notNull().default("unknown"),
  classification:  repositoryClassificationEnum("classification").notNull().default("unknown"),
  dependencyCount: integer("dependency_count").notNull().default(0),
  overlapScore:    real("overlap_score"),
  createdAt:       timestamp("created_at").defaultNow().notNull(),
  updatedAt:       timestamp("updated_at").defaultNow().notNull(),
});

export type Repository = typeof repositoriesTable.$inferSelect;
