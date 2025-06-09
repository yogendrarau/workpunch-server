const { Pool } = require('pg');

// Create a new pool using the connection string from environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test DB connection immediately
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ DB CONNECTION FAILED:', err.message);
  } else {
    console.log('✅ DB CONNECTED — current time:', res.rows[0].now);
  }
});

// Initialize database tables
const initializeDatabase = async () => {
  try {
    console.log('🔧 Initializing companies table...');
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

    await pool.query('CREATE INDEX IF NOT EXISTS idx_company_name ON companies(company_name)');
    console.log('✅ Table check complete');
  } catch (error) {
    console.error('❌ Error initializing database:', error.message);
    throw error;
  }
};

// Initialize on load
initializeDatabase();

// Helper functions for token management
const tokenHelpers = {
  // Store or update company tokens
  storeTokens: async (companyName, tokens) => {
    const { access_token, refresh_token, instance_url } = tokens;
    const now = new Date().toISOString();

    console.log(`🟡 Storing tokens for company: ${companyName}`);
    console.log(`🟡 Instance URL sample: ${instance_url?.slice(0, 30)}...`);

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

      console.log(`✅ Tokens stored. Company ID: ${result.rows[0].id}`);
      return result.rows[0].id;
    } catch (error) {
      console.error('❌ Error storing tokens:', error.message);
      throw error;
    }
  },

  // Get tokens
  getTokens: async (companyName) => {
    try {
      const result = await pool.query(
        'SELECT access_token, refresh_token, instance_url, last_token_refresh FROM companies WHERE company_name = $1 AND is_active = TRUE',
        [companyName]
      );
      return result.rows[0];
    } catch (error) {
      console.error('❌ Error getting tokens:', error.message);
      throw error;
    }
  },

  // Invalidate tokens
  invalidateTokens: async (companyName) => {
    try {
      const result = await pool.query(
        'UPDATE companies SET is_active = FALSE, updated_at = $1 WHERE company_name = $2',
        [new Date().toISOString(), companyName]
      );
      return result.rowCount;
    } catch (error) {
      console.error('❌ Error invalidating tokens:', error.message);
      throw error;
    }
  }
};

module.exports = {
  pool,
  tokenHelpers
};
