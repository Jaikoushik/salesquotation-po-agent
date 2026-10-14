const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');

// Helper to ensure .env variables are loaded into process.env if running outside cds/dotenv
function ensureEnvLoaded() {
    const envFile = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envFile)) return;

    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && process.env[key] === undefined) {
            process.env[key] = val;
        }
    }
}

class EmbeddingMatcher {
    constructor() {
        this.token = null;
        this.tokenExpiresAt = 0;
        this.aiCoreConfig = null;
        this.resolvedDeploymentId = null;
        this.pool = null;
        this.isInitialized = false;
    }

    _getSchemaName() {
        ensureEnvLoaded();
        const raw = process.env.SCHEMA_NAME || global.cds?.env?.requires?.db?.credentials?.schema || 'public';
        return raw.split(',')[0].replace(/["']/g, '').trim();
    }

    _getAiCoreConfig() {
        if (this.aiCoreConfig) return this.aiCoreConfig;
        ensureEnvLoaded();

        let credentials = null;

        // 1. Cloud Foundry VCAP_SERVICES binding for aicore
        if (process.env.VCAP_SERVICES) {
            try {
                const vcap = JSON.parse(process.env.VCAP_SERVICES);
                const aicore = vcap['aicore'];
                if (aicore && aicore.length > 0) {
                    credentials = aicore[0].credentials;
                }
            } catch (_) {}
        }

        // 2. Fallback to AICORE_SERVICE_KEY from environment
        if (!credentials && process.env.AICORE_SERVICE_KEY) {
            try {
                credentials = JSON.parse(process.env.AICORE_SERVICE_KEY);
            } catch (_) {}
        }

        if (!credentials) {
            throw new Error('AI Core binding/credentials not found in VCAP_SERVICES or AICORE_SERVICE_KEY.');
        }

        const baseUrl = process.env.AICORE_BASE_URL || credentials.serviceurls?.AI_API_URL;
        const resourceGroup = process.env.AICORE_RESOURCE_GROUP || process.env['cds.requires.llm.resourceGroup'] || 'default';
        const modelName = process.env.AICORE_EMBEDDING_MODEL_NAME || 'embedding';

        this.aiCoreConfig = {
            clientId: credentials.clientid,
            clientSecret: credentials.clientsecret,
            tokenUrl: (process.env.AICORE_AUTH_URL || credentials.url) + '/oauth/token?grant_type=client_credentials',
            baseUrl: baseUrl,
            resourceGroup: resourceGroup,
            modelName: modelName
        };

        return this.aiCoreConfig;
    }

    async _getAccessToken() {
        const config = this._getAiCoreConfig();
        const now = Date.now();
        if (this.token && now < this.tokenExpiresAt - 60000) {
            return this.token;
        }

        const authHeader = 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
        const res = await axios.post(config.tokenUrl, null, {
            headers: { Authorization: authHeader }
        });

        this.token = res.data.access_token;
        this.tokenExpiresAt = now + ((res.data.expires_in || 3600) * 1000);
        return this.token;
    }

    async _resolveDeploymentId(token) {
        if (process.env.AICORE_EMBEDDING_DEPLOYMENT_ID) {
            return process.env.AICORE_EMBEDDING_DEPLOYMENT_ID;
        }

        if (this.resolvedDeploymentId) {
            return this.resolvedDeploymentId;
        }

        const config = this._getAiCoreConfig();
        const modelToFind = config.modelName.toLowerCase();

        const headers = {
            Authorization: `Bearer ${token}`
        };
        if (config.resourceGroup) {
            headers['AI-Resource-Group'] = config.resourceGroup;
        }

        const res = await axios.get(`${config.baseUrl}/v2/lm/deployments`, { headers });
        const resources = res.data?.resources || [];

        // Locate active deployment matching model name or embedding capability
        const match = resources.find(d => {
            if (d.status !== 'RUNNING') return false;
            const name = (d.details?.resources?.backendDetails?.model?.name || d.configurationName || d.scenarioId || '').toLowerCase();
            return name.includes(modelToFind) || name.includes('embedding');
        });

        if (!match) {
            throw new Error(`Could not find an active embedding deployment for "${config.modelName}" in AI Core resource group "${config.resourceGroup}".`);
        }

        this.resolvedDeploymentId = match.id;
        console.log(`[EmbeddingMatcher] Auto-discovered embedding deployment from AI Core binding: ${this.resolvedDeploymentId} (model: ${config.modelName})`);
        return this.resolvedDeploymentId;
    }

    async getEmbedding(text) {
        const config = this._getAiCoreConfig();
        const token = await this._getAccessToken();
        const deploymentId = await this._resolveDeploymentId(token);

        const embedUrl = `${config.baseUrl}/v2/inference/deployments/${deploymentId}/models/${config.modelName}:predict`;

        const headers = {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
        if (config.resourceGroup) {
            headers['AI-Resource-Group'] = config.resourceGroup;
        }

        const response = await axios.post(embedUrl, {
            instances: [{ content: text }]
        }, { headers });

        const pred = response.data.predictions?.[0];
        const values = pred?.embeddings?.values || pred?.embedding?.values || pred?.values;
        if (!values) throw new Error('No embedding values returned from AI Core.');

        return values;
    }

    _getPool() {
        if (this.pool) return this.pool;
        ensureEnvLoaded();

        // 1. Cloud Foundry VCAP_SERVICES binding (production)
        if (process.env.VCAP_SERVICES) {
            try {
                const vcap = JSON.parse(process.env.VCAP_SERVICES);
                const postgres = vcap['postgresql-db'] || vcap['postgres'];
                if (postgres && postgres.length > 0) {
                    const creds = postgres[0].credentials;
                    this.pool = new Pool({
                        user: creds.username,
                        host: creds.hostname,
                        database: creds.dbname,
                        port: creds.port,
                        password: creds.password,
                        ssl: { require: true, rejectUnauthorized: false }
                    });
                    return this.pool;
                }
            } catch (e) {
                console.warn('[EmbeddingMatcher] Could not parse VCAP_SERVICES credentials:', e.message);
            }
        }

        // 2. Dynamic environment variables (development / hybrid / tunnel)
        const host = process.env.PGHOST;
        const port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : undefined;
        const user = process.env.PGUSER;
        const password = process.env.PGPASSWORD;
        const database = process.env.PGDATABASE;

        if (!host || !user || !password || !database) {
            throw new Error('Database credentials missing in environment (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).');
        }

        this.pool = new Pool({
            user,
            host,
            database,
            port,
            password,
            ssl: { require: true, rejectUnauthorized: false }
        });

        return this.pool;
    }

    async init() {
        if (this.isInitialized) return;

        try {
            const schema = this._getSchemaName();
            const pool = this._getPool();
            const res = await pool.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = $1
                  AND table_name IN ('businesspartnerembeddings', 'productdescriptionembeddings')
            `, [schema]);

            console.log(`[EmbeddingMatcher] Connected to PostgreSQL pgvector (schema: "${schema}"). Verified tables:`, res.rows.map(r => r.table_name));
            this.isInitialized = true;
        } catch (err) {
            console.warn(`[EmbeddingMatcher] Notice connecting to pgvector DB: ${err.message}`);
        }
    }

    async searchSupplier(queryText, topK = 5, minSimilarity = 0.55) {
        if (!queryText) return [];

        const schema = this._getSchemaName();
        const values = await this.getEmbedding(queryText);
        const vecStr = `[${values.join(',')}]`;
        const pool = this._getPool();

        const query = `
            SELECT 
                businesspartnerid, 
                searchtext, 
                1 - (embedding <=> $1::vector) AS similarity
            FROM "${schema}"."businesspartnerembeddings"
            WHERE (1 - (embedding <=> $1::vector)) >= $2
            ORDER BY embedding <=> $1::vector
            LIMIT $3;
        `;

        let res;
        try {
            res = await pool.query(query, [vecStr, minSimilarity, topK]);
            if (res.rows.length === 0 && schema !== 'saleorder-agent') {
                const fallbackQuery = query.replace(`"${schema}"."businesspartnerembeddings"`, `"saleorder-agent"."businesspartnerembeddings"`);
                const fbRes = await pool.query(fallbackQuery, [vecStr, minSimilarity, topK]);
                if (fbRes.rows.length > 0) res = fbRes;
            }
        } catch (err) {
            if (schema !== 'saleorder-agent') {
                const fallbackQuery = query.replace(`"${schema}"."businesspartnerembeddings"`, `"saleorder-agent"."businesspartnerembeddings"`);
                res = await pool.query(fallbackQuery, [vecStr, minSimilarity, topK]);
            } else {
                throw err;
            }
        }

        return res.rows.map(r => {
            const searchText = r.searchtext || '';
            const segments = searchText ? searchText.split('|').map(s => s.trim()) : [];
            const name = segments[0] || r.businesspartnerid;
            const details = segments.slice(2).filter(Boolean).join(', ') || segments[1] || '';

            return {
                supplierId: r.businesspartnerid,
                name: name,
                searchTerm: details,
                similarity: parseFloat(r.similarity)
            };
        });
    }

    async searchProduct(queryText, topK = 5, minSimilarity = 0.55) {
        if (!queryText) return [];

        const schema = this._getSchemaName();
        const values = await this.getEmbedding(queryText);
        const vecStr = `[${values.join(',')}]`;
        const pool = this._getPool();

        const query = `
            SELECT 
                productid, 
                description, 
                producttype, 
                productgroup, 
                baseunit, 
                1 - (embedding <=> $1::vector) AS similarity
            FROM "${schema}"."productdescriptionembeddings"
            WHERE (1 - (embedding <=> $1::vector)) >= $2
            ORDER BY embedding <=> $1::vector
            LIMIT $3;
        `;

        let res;
        try {
            res = await pool.query(query, [vecStr, minSimilarity, topK]);
            if (res.rows.length === 0 && schema !== 'saleorder-agent') {
                const fallbackQuery = query.replace(`"${schema}"."productdescriptionembeddings"`, `"saleorder-agent"."productdescriptionembeddings"`);
                const fbRes = await pool.query(fallbackQuery, [vecStr, minSimilarity, topK]);
                if (fbRes.rows.length > 0) res = fbRes;
            }
        } catch (err) {
            if (schema !== 'saleorder-agent') {
                const fallbackQuery = query.replace(`"${schema}"."productdescriptionembeddings"`, `"saleorder-agent"."productdescriptionembeddings"`);
                res = await pool.query(fallbackQuery, [vecStr, minSimilarity, topK]);
            } else {
                throw err;
            }
        }

        return res.rows.map(r => ({
            material: r.productid,
            description: r.description || r.productid,
            productType: r.producttype || 'ZR01',
            productGroup: r.productgroup || '',
            baseUnit: r.baseunit || 'KG',
            similarity: parseFloat(r.similarity)
        }));
    }
}

module.exports = new EmbeddingMatcher();
