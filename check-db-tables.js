#!/usr/bin/env node

// Check what tables exist in the database
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '.env') });

const { Pool } = pg;

async function checkTables() {
  console.log('🔍 Checking database tables...');
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Check if tables exist
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND (table_name LIKE '%credential%' OR table_name LIKE '%session%')
      ORDER BY table_name;
    `);

    console.log('\n📋 Tables found:');
    result.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

    // Check user_sessions columns
    const sessionCols = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'user_sessions' 
      ORDER BY ordinal_position;
    `);

    console.log('\n📋 user_sessions columns:');
    sessionCols.rows.forEach(row => {
      console.log(`  - ${row.column_name} (${row.data_type})`);
    });

    // Check if we have the old or new credentials table
    const hasOldTable = result.rows.some(r => r.table_name === 'user_polymarket_credentials');
    const hasNewTable = result.rows.some(r => r.table_name === 'user_venue_credentials');

    console.log(`\n🔍 Table status:`);
    console.log(`  - user_polymarket_credentials: ${hasOldTable ? '✅ EXISTS' : '❌ NOT FOUND'}`);
    console.log(`  - user_venue_credentials: ${hasNewTable ? '✅ EXISTS' : '❌ NOT FOUND'}`);

    if (hasOldTable && !hasNewTable) {
      console.log('\n⚠️  Migration needed: Table needs to be renamed from user_polymarket_credentials to user_venue_credentials');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

checkTables();
