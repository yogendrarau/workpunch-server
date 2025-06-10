const { Pool } = require('pg');

// Create a new pool using the connection string from environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Add error handling for the pool
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Initialize database tables
async function initDb() {
  try {
    console.log('Starting database initialization...');
    
    // Check if companies table exists
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'companies'
      );
    `);

    if (!tableExists.rows[0].exists) {
      console.log('Creating companies table...');
      await pool.query(`
        CREATE TABLE companies (
          id SERIAL PRIMARY KEY,
          salesforce_access_token TEXT,
          salesforce_refresh_token TEXT,
          salesforce_instance_url TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('Companies table created successfully');
    } else {
      console.log('Companies table already exists');
    }

    // Verify the table structure
    const tableInfo = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'companies';
    `);
    console.log('Table structure:', tableInfo.rows);

    console.log('Database initialization completed successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

const tokenHelpers = {
  async storeTokens(tokens) {
    const { access_token, refresh_token, instance_url } = tokens;
    try {
      console.log('Storing tokens...');

      await pool.query(
        `INSERT INTO companies (salesforce_access_token, salesforce_refresh_token, salesforce_instance_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) 
         DO UPDATE SET 
           salesforce_access_token = $1,
           salesforce_refresh_token = $2,
           salesforce_instance_url = $3,
           updated_at = CURRENT_TIMESTAMP`,
        [access_token, refresh_token, instance_url]
      );

      // Verify the stored data
      const result = await pool.query('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
      console.log('Stored data verification:', result.rows[0]);
    } catch (error) {
      console.error('Error storing tokens:', error);
      throw error;
    }
  },

  async getTokens() {
    try {
      const result = await pool.query('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
      if (result.rows.length === 0) return null;
      
      const company = result.rows[0];
      return {
        access_token: company.salesforce_access_token,
        refresh_token: company.salesforce_refresh_token,
        instance_url: company.salesforce_instance_url
      };
    } catch (error) {
      console.error('Error getting tokens:', error);
      throw error;
    }
  }
};

// Export both the pool and the helpers
module.exports = {
  pool,
  initDb,
  tokenHelpers
};
