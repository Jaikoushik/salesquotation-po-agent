const { Pool } = require('pg');

const pool = new Pool({
    user: '5c7107de9df4',
    host: '127.0.0.1',
    database: 'NdbYEgtoLNwq',
    port: 5433,
    password: 'e4bd896bbfd8e0a0',
    ssl: { require: true, rejectUnauthorized: false }
});

async function main() {
    const res = await pool.query(`
        SELECT e.extname, n.nspname 
        FROM pg_extension e 
        JOIN pg_namespace n ON e.extnamespace = n.oid 
        WHERE e.extname = 'vector'
    `);
    console.log('Vector extension location:', res.rows);

    // Check search path of database / user
    const sp = await pool.query('SHOW search_path');
    console.log('Current search path:', sp.rows);
}

main().catch(console.error).finally(() => pool.end());
