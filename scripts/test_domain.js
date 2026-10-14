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
    try {
        console.log('Testing setting search_path on database / role:');
        // Let's see what user connects:
        const userRes = await pool.query('SELECT current_user, session_user');
        console.log('Current users:', userRes.rows[0]);

        // Test if schema setting can be altered:
        // ALTER DATABASE dbname SET search_path TO "$user", public;
        // Or ALTER USER username SET search_path TO "$user", public;
        console.log('\nTesting domain creation:');
        try {
            await pool.query('CREATE DOMAIN "salesquotationagent".vector AS public.vector');
            console.log('Domain created successfully!');
        } catch (e) {
            console.log('Domain creation error:', e.message);
        }

        console.log('\nTesting SET search_path TO "salesquotationagent" and then CREATE TABLE with vector:');
        const client = await pool.connect();
        try {
            await client.query('SET search_path TO "salesquotationagent"');
            await client.query('CREATE TEMP TABLE test_v (id int, v vector(3))');
            console.log('TEMP TABLE with vector(3) created successfully under search_path = salesquotationagent!');
        } catch (e) {
            console.log('TEMP TABLE creation error:', e.message);
        } finally {
            client.release();
        }
    } finally {
        await pool.end();
    }
}

main().catch(console.error);
