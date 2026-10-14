/**
 * Utility script to dump embeddings from assets/*.csv into the CAP database
 * (PostgreSQL in production or SQLite in local hybrid).
 *
 * Usage:
 *   node scripts/dumpEmbeddingsToDb.js
 *   or: cds run scripts/dumpEmbeddingsToDb.js --profile hybrid
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const cds = require('@sap/cds');

async function main() {
    console.log('[dumpEmbeddings] Connecting to database...');
    const db = await cds.connect.to('db');

    const bpFile = path.resolve(__dirname, '../assets/business_partner_embeddings.csv');
    const prodFile = path.resolve(__dirname, '../assets/product_embeddings.csv');

    // 1. Business Partners
    if (fs.existsSync(bpFile)) {
        console.log(`[dumpEmbeddings] Processing ${bpFile}...`);
        const rl = readline.createInterface({
            input: fs.createReadStream(bpFile),
            crlfDelay: Infinity
        });

        let isHeader = true;
        let batch = [];
        let totalBp = 0;
        const BATCH_SIZE = 500;

        for await (const line of rl) {
            if (isHeader) { isHeader = false; continue; }
            const start = line.lastIndexOf('[');
            const end = line.lastIndexOf(']');
            if (start === -1 || end <= start) continue;

            const vecStr = line.substring(start, end + 1);
            const prefix = line.substring(0, start);
            const parts = prefix.split(',');

            const id = parts[0]?.trim();
            const bpId = parts[1]?.trim();
            const searchText = parts[2]?.replace(/^"|"$/g, '').trim();
            const contentHash = parts[3]?.trim();
            const model = parts[4]?.trim();
            const dims = parseInt(parts[5], 10) || 3072;
            const lastEmbedded = parts[6]?.trim();

            let vec;
            try { vec = JSON.parse(vecStr); } catch (_) { vec = vecStr; }

            batch.push({
                ID: id,
                businessPartnerId: bpId,
                searchText: searchText,
                contentHash: contentHash,
                embeddingModel: model,
                embeddingDimensions: dims,
                lastEmbeddedAt: lastEmbedded,
                embedding: vec
            });

            if (batch.length >= BATCH_SIZE) {
                await db.run(UPSERT.into('sap.procurement.BusinessPartnerEmbeddings').entries(batch));
                totalBp += batch.length;
                console.log(`[dumpEmbeddings] Inserted ${totalBp} Business Partners...`);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await db.run(UPSERT.into('sap.procurement.BusinessPartnerEmbeddings').entries(batch));
            totalBp += batch.length;
            console.log(`[dumpEmbeddings] Inserted ${totalBp} Business Partners.`);
        }
    } else {
        console.warn(`[dumpEmbeddings] Business partner embeddings file not found: ${bpFile}`);
    }

    // 2. Products
    if (fs.existsSync(prodFile)) {
        console.log(`[dumpEmbeddings] Processing ${prodFile}...`);
        const rl = readline.createInterface({
            input: fs.createReadStream(prodFile),
            crlfDelay: Infinity
        });

        let isHeader = true;
        let batch = [];
        let totalProd = 0;
        const BATCH_SIZE = 500;

        for await (const line of rl) {
            if (isHeader) { isHeader = false; continue; }
            const start = line.lastIndexOf('[');
            const end = line.lastIndexOf(']');
            if (start === -1 || end <= start) continue;

            const vecStr = line.substring(start, end + 1);
            const prefix = line.substring(0, start);
            const parts = prefix.split(',');

            const id = parts[0]?.trim();
            const productId = parts[1]?.trim();
            const language = parts[2]?.trim() || 'EN';
            const description = parts[3]?.replace(/^"|"$/g, '').trim();
            const contentHash = parts[4]?.trim();
            const model = parts[5]?.trim();
            const dims = parseInt(parts[6], 10) || 3072;
            const lastEmbedded = parts[7]?.trim();
            const productType = parts[8]?.trim();
            const productGroup = parts[9]?.trim();
            const baseUnit = parts[10]?.trim();

            let vec;
            try { vec = JSON.parse(vecStr); } catch (_) { vec = vecStr; }

            batch.push({
                ID: id,
                productId: productId,
                language: language,
                description: description,
                contentHash: contentHash,
                embeddingModel: model,
                embeddingDimensions: dims,
                lastEmbeddedAt: lastEmbedded,
                productType: productType,
                productGroup: productGroup,
                baseUnit: baseUnit,
                embedding: vec
            });

            if (batch.length >= BATCH_SIZE) {
                await db.run(UPSERT.into('sap.procurement.ProductEmbeddings').entries(batch));
                totalProd += batch.length;
                console.log(`[dumpEmbeddings] Inserted ${totalProd} Products...`);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await db.run(UPSERT.into('sap.procurement.ProductEmbeddings').entries(batch));
            totalProd += batch.length;
            console.log(`[dumpEmbeddings] Inserted ${totalProd} Products.`);
        }
    } else {
        console.warn(`[dumpEmbeddings] Product embeddings file not found: ${prodFile}`);
    }

    console.log('[dumpEmbeddings] Completed successfully!');
    process.exit(0);
}

main().catch(err => {
    console.error('[dumpEmbeddings] Error:', err);
    process.exit(1);
});
