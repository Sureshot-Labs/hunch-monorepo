#!/usr/bin/env node

// Fix user_sessions constraints using Node.js and pg
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: resolve(__dirname, '.env') });

const { Pool } = pg;

async function fixConstraints() {
  console.log('🔧 Fixing user_sessions constraints...');
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Remove composite unique constraint
    await pool.query(`
      ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_session_token_user_id_key;
    `);
    console.log('✅ Removed composite constraint');

    // Check and add session_token unique constraint if needed
    const result = await pool.query(`
      SELECT conname 
      FROM pg_constraint 
      WHERE conname = 'user_sessions_session_token_key' 
      AND conrelid = 'user_sessions'::regclass;
    `);

    if (result.rows.length === 0) {
      await pool.query(`
        ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_session_token_key UNIQUE (session_token);
      `);
      console.log('✅ Added session_token unique constraint');
    } else {
      console.log('✅ session_token unique constraint already exists');
    }

    // Show current constraints
    const constraints = await pool.query(`
      SELECT conname, contype 
      FROM pg_constraint 
      WHERE conrelid = 'user_sessions'::regclass;
    `);

    console.log('\n📋 Current constraints on user_sessions:');
    constraints.rows.forEach(row => {
      const type = row.contype === 'p' ? 'PRIMARY KEY' : 
                   row.contype === 'u' ? 'UNIQUE' : 
                   row.contype === 'f' ? 'FOREIGN KEY' : row.contype;
      console.log(`  - ${row.conname} (${type})`);
    });

    console.log('\n🎉 Constraints fixed successfully!');
  } catch (error) {
    console.error('❌ Error fixing constraints:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

fixConstraints();

