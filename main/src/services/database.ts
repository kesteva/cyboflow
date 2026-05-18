import { DatabaseService } from '../database/database';
import { join } from 'path';
import { getCyboflowDirectory } from '../utils/cyboflowDirectory';

// Create and export a singleton instance
const dbPath = join(getCyboflowDirectory(), 'sessions.db');
export const databaseService = new DatabaseService(dbPath);

// Initialize the database schema and run migrations
databaseService.initialize();