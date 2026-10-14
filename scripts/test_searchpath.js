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
    await pool.query('DROP DOMAIN IF EXISTS "salesquotationagent".vector CASCADE');
    console.log('Domain dropped!');

    const client = await pool.connect();
    try {
        const schema = 'salesquotationagent", "public';
        const sql = `SET search_path TO "${schema}";`;
        console.log('Running:', sql);
        await client.query(sql);

        const sp = await client.query('SHOW search_path');
        console.log('search_path is:', sp.rows[0]);

        await client.query('CREATE TEMP TABLE test_v2 (id int, v vector(3072))');
        console.log('SUCCESS! Table with vector(3072) created under search_path!');

        const check = await client.query(`
            SELECT table_name, column_name, data_type, udt_name 
            FROM information_schema.columns 
            WHERE table_name = 'test_v2'
        `);
        console.log('Column details:', check.rows);
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(console.error);
