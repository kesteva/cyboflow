import { DatabaseService } from '../database/database';
import { getBootDatabasePath } from './demo/demoBootstrap';

// Create and export a singleton instance. The path comes from the demo
// bootstrap so this singleton and the index.ts instance ALWAYS open the same
// database — in demo mode that is the freshly-reset demo.db, not sessions.db.
const dbPath = getBootDatabasePath();
export const databaseService = new DatabaseService(dbPath);

// Initialize the database schema and run migrations
databaseService.initialize();