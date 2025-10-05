#!/usr/bin/env node

// Rename table and add multi-venue support
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '.env') });

const { Pool } = pg;

async function migrateToVenueCredentials() {
  console.log('🔧 Migrating to multi-venue credentials...');
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await pool.query('BEGIN');

    // 1. Rename table
    console.log('📝 Renaming table...');
    await pool.query(`
      ALTER TABLE user_polymarket_credentials RENAME TO user_venue_credentials;
    `);

    // 2. Add venue column with default 'polymarket'
    console.log('📝 Adding venue column...');
    await pool.query(`
      ALTER TABLE user_venue_credentials 
      ADD COLUMN IF NOT EXISTS venue text NOT NULL DEFAULT 'polymarket';
    `);

    // 3. Add additional_data column
    console.log('📝 Adding additional_data column...');
    await pool.query(`
      ALTER TABLE user_venue_credentials 
      ADD COLUMN IF NOT EXISTS additional_data jsonb;
    `);

    // 4. Drop old unique constraint
    console.log('📝 Updating constraints...');
    await pool.query(`
      ALTER TABLE user_venue_credentials 
      DROP CONSTRAINT IF EXISTS user_polymarket_credentials_user_id_wallet_address_key;
    `);

    // 5. Add new unique constraint with venue
    await pool.query(`
      ALTER TABLE user_venue_credentials 
      ADD CONSTRAINT user_venue_credentials_user_id_wallet_address_venue_key 
      UNIQUE (user_id, wallet_address, venue);
    `);

    // 6. Add check constraint for venue values
    await pool.query(`
      ALTER TABLE user_venue_credentials 
      ADD CONSTRAINT user_venue_credentials_venue_check 
      CHECK (venue IN ('polymarket', 'kalshi', 'limitless'));
    `);

    // 7. Update indexes
    console.log('📝 Updating indexes...');
    await pool.query(`DROP INDEX IF EXISTS idx_polymarket_creds_user_id;`);
    await pool.query(`DROP INDEX IF EXISTS idx_polymarket_creds_wallet;`);
    await pool.query(`DROP INDEX IF EXISTS idx_polymarket_creds_active;`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_venue_creds_user_id ON user_venue_credentials(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_venue_creds_wallet ON user_venue_credentials(wallet_address);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_venue_creds_venue ON user_venue_credentials(venue);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_venue_creds_active ON user_venue_credentials(is_active);`);

    // 8. Update trigger
    console.log('📝 Updating triggers...');
    await pool.query(`DROP TRIGGER IF EXISTS update_polymarket_creds_updated_at ON user_venue_credentials;`);
    await pool.query(`
      CREATE TRIGGER update_venue_creds_updated_at 
      BEFORE UPDATE ON user_venue_credentials 
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

    await pool.query('COMMIT');

    console.log('\n✅ Migration completed successfully!');
    
    // Verify the changes
    const result = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'user_venue_credentials' 
      ORDER BY ordinal_position;
    `);

    console.log('\n📋 user_venue_credentials columns:');
    result.rows.forEach(row => {
      console.log(`  - ${row.column_name} (${row.data_type})`);
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateToVenueCredentials();
