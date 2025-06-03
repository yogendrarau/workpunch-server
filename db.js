const { Pool } = require('pg');

// Create a new pool using the connection string from environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
const initializeDatabase = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        company_name TEXT NOT NULL UNIQUE,
        access_token TEXT,
        refresh_token TEXT,
        instance_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_token_refresh TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE
      )
    `);

    // Create index for faster lookups
    await pool.query('CREATE INDEX IF NOT EXISTS idx_company_name ON companies(company_name)');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
};

// Initialize the database
initializeDatabase();

// Helper functions for token management
const tokenHelpers = {
  // Store or update company tokens
  storeTokens: async (companyName, tokens) => {
    const { access_token, refresh_token, instance_url } = tokens;
    const now = new Date().toISOString();
    
    try {
      const result = await pool.query(
        `INSERT INTO companies (company_name, access_token, refresh_token, instance_url, created_at, updated_at, last_token_refresh)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(company_name) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         instance_url = EXCLUDED.instance_url,
         updated_at = EXCLUDED.updated_at,
         last_token_refresh = EXCLUDED.last_token_refresh
         RETURNING id`,
        [companyName, access_token, refresh_token, instance_url, now, now, now]
      );
      return result.rows[0].id;
    } catch (error) {
      console.error('Error storing tokens:', error);
      throw error;
    }
  },

  // Get company tokens
  getTokens: async (companyName) => {
    try {
      const result = await pool.query(
        'SELECT access_token, refresh_token, instance_url, last_token_refresh FROM companies WHERE company_name = $1 AND is_active = TRUE',
        [companyName]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Error getting tokens:', error);
      throw error;
    }
  },

  // Invalidate company tokens
  invalidateTokens: async (companyName) => {
    try {
      const result = await pool.query(
        'UPDATE companies SET is_active = FALSE, updated_at = $1 WHERE company_name = $2',
        [new Date().toISOString(), companyName]
      );
      return result.rowCount;
    } catch (error) {
      console.error('Error invalidating tokens:', error);
      throw error;
    }
  }
};

module.exports = {
  pool,
  tokenHelpers
};