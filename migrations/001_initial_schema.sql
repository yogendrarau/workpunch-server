-- Create companies table
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  salesforce_instance_url TEXT NOT NULL,
  salesforce_access_token TEXT NOT NULL,
  salesforce_refresh_token TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create user_locks table
CREATE TABLE IF NOT EXISTS user_locks (
  user_id TEXT PRIMARY KEY,
  lock_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index on created_at for cleanup
CREATE INDEX IF NOT EXISTS idx_user_locks_created_at ON user_locks(created_at);

-- Add cleanup function
CREATE OR REPLACE FUNCTION cleanup_old_locks() RETURNS void AS $$
BEGIN
  DELETE FROM user_locks WHERE created_at < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- Add cleanup trigger
CREATE OR REPLACE FUNCTION trigger_cleanup_old_locks() RETURNS trigger AS $$
BEGIN
  PERFORM cleanup_old_locks();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cleanup_locks_trigger
  AFTER INSERT ON user_locks
  EXECUTE FUNCTION trigger_cleanup_old_locks(); 