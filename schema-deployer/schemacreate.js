const { pool } = require("./db");

async function createSchema(schema) {
    if (!schema) {
        console.warn("No SCHEMA_NAME specified. Skipping.");
        return;
    }

    try {
        console.log("Ensuring pgvector extension is enabled in public schema...");
        try {
            await pool.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`);
            console.log("pgvector extension enabled.");
        } catch (extErr) {
            console.warn("Notice: CREATE EXTENSION vector check:", extErr.message);
        }

        console.log("Ensuring schema exists:", schema);
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        console.log("Schema ready:", schema);

        try {
            console.log("Ensuring embedding views are available in schema...");
            await pool.query(`
                CREATE OR REPLACE VIEW "${schema}"."businesspartnerembeddings" AS 
                SELECT * FROM "saleorder-agent"."businesspartnerembeddings";
            `);
            await pool.query(`
                CREATE OR REPLACE VIEW "${schema}"."productdescriptionembeddings" AS 
                SELECT * FROM "saleorder-agent"."productdescriptionembeddings";
            `);
            console.log("Embedding views ready in schema:", schema);
        } catch (viewErr) {
            console.warn("Notice: embedding views creation:", viewErr.message);
        }
    }
    catch (e) {
        console.error("Failed to prepare schema:", e);
        process.exitCode = 1;
    }
    finally {
        await pool.end();
    }
}

createSchema(process.env.SCHEMA_NAME);