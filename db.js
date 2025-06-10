const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Initialize database tables
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        company_name VARCHAR(255) NOT NULL,
        tenant_id VARCHAR(255) UNIQUE NOT NULL,
        salesforce_access_token TEXT,
        salesforce_refresh_token TEXT,
        salesforce_instance_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

const tokenHelpers = {
  async storeTokens(companyName, tenantId, tokens) {
    const { access_token, refresh_token, instance_url } = tokens;
    try {
      await pool.query(
        `INSERT INTO companies (company_name, tenant_id, salesforce_access_token, salesforce_refresh_token, salesforce_instance_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) 
         DO UPDATE SET 
           company_name = $1,
           salesforce_access_token = $3,
           salesforce_refresh_token = $4,
           salesforce_instance_url = $5,
           updated_at = CURRENT_TIMESTAMP`,
        [companyName, tenantId, access_token, refresh_token, instance_url]
      );
    } catch (error) {
      console.error('Error storing tokens:', error);
      throw error;
    }
  },

  async getTokensByTenantId(tenantId) {
    try {
      const result = await pool.query(
        'SELECT * FROM companies WHERE tenant_id = $1',
        [tenantId]
      );
      if (result.rows.length === 0) return null;
      
      const company = result.rows[0];
      return {
        companyName: company.company_name,
        access_token: company.salesforce_access_token,
        refresh_token: company.salesforce_refresh_token,
        instance_url: company.salesforce_instance_url
      };
    } catch (error) {
      console.error('Error getting tokens:', error);
      throw error;
    }
  },

  async invalidateTokens(tenantId) {
    try {
      const result = await pool.query(
        'UPDATE companies SET salesforce_access_token = NULL, salesforce_refresh_token = NULL, salesforce_instance_url = NULL WHERE tenant_id = $1',
        [tenantId]
      );
      return result.rowCount;
    } catch (error) {
      console.error('Error invalidating tokens:', error);
      throw error;
    }
  }
};

module.exports = {
  db: pool,
  initDb,
  tokenHelpers
};
