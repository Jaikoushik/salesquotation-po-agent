/**
 * Server-side export script that runs directly inside the Cloud Foundry container
 * with direct internal network access to PostgreSQL (no SSH tunnel overhead).
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('/home/vcap/app/node_modules/pg');

const SCHEMA_NAME = process.env.SCHEMA_NAME || 'salesquotationagent';
const OUTPUT_DIR = '/home/vcap/tmp';
const BATCH_SIZE = 1000;

function getCredentials() {
    if (!process.env.VCAP_SERVICES) {
        throw new Error('VCAP_SERVICES environment variable not set.');
    }
    const vcap = JSON.parse(process.env.VCAP_SERVICES);
    const postgres = vcap['postgresql-db'] || vcap['postgres'];
    if (!postgres || postgres.length === 0) {
        throw new Error('No PostgreSQL service binding found in VCAP_SERVICES.');
    }
    return postgres[0].credentials;
}

function sanitizeText(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/\r?\n/g, ' ')
        .replace(/,/g, ' ')
        .replace(/^"|"$/g, '')
        .trim();
}

function formatEmbeddingVector(vec) {
    if (!vec) return '[]';
    if (typeof vec === 'string') {
        const trimmed = vec.trim();
        return trimmed.startsWith('[') ? trimmed : `[${trimmed}]`;
    }
    if (Array.isArray(vec)) {
        return `[${vec.join(',')}]`;
    }
    return JSON.stringify(vec);
}

async function exportBusinessPartners(pool, schema, outputFile) {
    console.log(`[export] Exporting Business Partners from schema "${schema}"...`);

    const tableCheck = await pool.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name IN ('businesspartnerembeddings', 'saleorderagent_bpembeddings')
        ORDER BY table_name LIMIT 1
    `, [schema]);

    if (tableCheck.rows.length === 0) {
        console.warn(`[export] No business partner embeddings table found in schema "${schema}".`);
        return 0;
    }

    const tableName = tableCheck.rows[0].table_name;
    const countRes = await pool.query(`SELECT count(*) FROM "${schema}"."${tableName}"`);
    const total = parseInt(countRes.rows[0].count, 10);
    console.log(`[export] Found ${total} business partner records.`);

    const writeStream = fs.createWriteStream(outputFile, { encoding: 'utf8' });
    writeStream.write('ID,businessPartnerId,searchText,contentHash,embeddingModel,embeddingDimensions,lastEmbeddedAt,embedding\n');

    let exported = 0;
    let offset = 0;

    while (offset < total) {
        const res = await pool.query(`
            SELECT id, businesspartnerid, searchtext, contenthash, embeddingmodel, embeddingdimensions, lastembeddedat, embedding
            FROM "${schema}"."${tableName}"
            ORDER BY id
            LIMIT $1 OFFSET $2
        `, [BATCH_SIZE, offset]);

        for (const row of res.rows) {
            const id = row.id || '';
            const bpId = row.businesspartnerid || '';
            const searchText = sanitizeText(row.searchtext);
            const contentHash = row.contenthash || '';
            const model = row.embeddingmodel || process.env.AICORE_EMBEDDING_MODEL_NAME || '';
            const dims = row.embeddingdimensions || 3072;
            const lastEmbedded = row.lastembeddedat ? new Date(row.lastembeddedat).toISOString() : new Date().toISOString();
            const vec = formatEmbeddingVector(row.embedding);

            writeStream.write(`${id},${bpId},${searchText},${contentHash},${model},${dims},${lastEmbedded},${vec}\n`);
            exported++;
        }

        offset += BATCH_SIZE;
        console.log(`[export] Exported ${exported}/${total} Business Partners...`);
    }

    writeStream.end();
    await new Promise(resolve => writeStream.on('finish', resolve));
    console.log(`[export] Successfully written: ${outputFile} (${exported} records).`);
    return exported;
}

async function exportProducts(pool, schema, outputFile) {
    console.log(`[export] Exporting Products from schema "${schema}"...`);

    const tableCheck = await pool.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name IN ('productdescriptionembeddings', 'saleorderagent_productembeddings')
        ORDER BY table_name LIMIT 1
    `, [schema]);

    if (tableCheck.rows.length === 0) {
        console.warn(`[export] No product embeddings table found in schema "${schema}".`);
        return 0;
    }

    const tableName = tableCheck.rows[0].table_name;
    const countRes = await pool.query(`SELECT count(*) FROM "${schema}"."${tableName}"`);
    const total = parseInt(countRes.rows[0].count, 10);
    console.log(`[export] Found ${total} product records.`);

    const writeStream = fs.createWriteStream(outputFile, { encoding: 'utf8' });
    writeStream.write('ID,productId,language,description,contentHash,embeddingModel,embeddingDimensions,lastEmbeddedAt,productType,productGroup,baseUnit,embedding\n');

    let exported = 0;
    let offset = 0;

    while (offset < total) {
        const res = await pool.query(`
            SELECT id, productid, language, description, contenthash, embeddingmodel, embeddingdimensions, lastembeddedat, producttype, productgroup, baseunit, embedding
            FROM "${schema}"."${tableName}"
            ORDER BY id
            LIMIT $1 OFFSET $2
        `, [BATCH_SIZE, offset]);

        for (const row of res.rows) {
            const id = row.id || '';
            const prodId = row.productid || '';
            const language = row.language || 'EN';
            const description = sanitizeText(row.description);
            const contentHash = row.contenthash || '';
            const model = row.embeddingmodel || process.env.AICORE_EMBEDDING_MODEL_NAME || '';
            const dims = row.embeddingdimensions || 3072;
            const lastEmbedded = row.lastembeddedat ? new Date(row.lastembeddedat).toISOString() : new Date().toISOString();
            const productType = row.producttype || '';
            const productGroup = row.productgroup || '';
            const baseUnit = row.baseunit || '';
            const vec = formatEmbeddingVector(row.embedding);

            writeStream.write(`${id},${prodId},${language},${description},${contentHash},${model},${dims},${lastEmbedded},${productType},${productGroup},${baseUnit},${vec}\n`);
            exported++;
        }

        offset += BATCH_SIZE;
        console.log(`[export] Exported ${exported}/${total} Products...`);
    }

    writeStream.end();
    await new Promise(resolve => writeStream.on('finish', resolve));
    console.log(`[export] Successfully written: ${outputFile} (${exported} records).`);
    return exported;
}

async function main() {
    const creds = getCredentials();
    console.log(`[export] Connecting directly to ${creds.hostname}:${creds.port}, db: ${creds.dbname}...`);

    const pool = new Pool({
        user: creds.username,
        host: creds.hostname,
        database: creds.dbname,
        port: creds.port,
        password: creds.password,
        ssl: { require: true, rejectUnauthorized: false }
    });

    try {
        const bpOutput = path.join(OUTPUT_DIR, 'business_partner_embeddings.csv');
        const prodOutput = path.join(OUTPUT_DIR, 'product_embeddings.csv');

        await exportBusinessPartners(pool, SCHEMA_NAME, bpOutput);
        await exportProducts(pool, SCHEMA_NAME, prodOutput);

        console.log('\n[export] Server-side export complete!');
    } finally {
        await pool.end();
    }
}

main().catch(err => {
    console.error('\n[export] Error:', err.message);
    process.exit(1);
});
