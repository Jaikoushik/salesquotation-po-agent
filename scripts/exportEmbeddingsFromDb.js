/**
 * Master utility script to export embeddings from the PostgreSQL server
 * directly into the local assets folder (assets/*.csv).
 *
 * Uses a fast 2-step process:
 *   1. Executes the export script directly inside the Cloud Foundry container
 *      (direct 10Gbps AWS VPC access to PostgreSQL without SSH tunnel drops).
 *   2. Streams the resulting CSV files directly to assets/*.csv.
 *
 * Usage:
 *   npm run export-embeddings
 *   or: node scripts/exportEmbeddingsFromDb.js
 *   or: node scripts/exportEmbeddingsFromDb.js --schema=saleorder-agent
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Parse CLI args
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [k, v] = arg.replace(/^--/, '').split('=');
    acc[k] = v || true;
    return acc;
}, {});

const SCHEMA_NAME = args.schema || process.env.SCHEMA_NAME;
const APP_NAME = args.app || process.env.CF_APP_NAME;
const ASSETS_DIR = path.resolve(__dirname, '../assets');
const SERVER_SCRIPT = path.resolve(__dirname, 'export_on_server.js');

function runCommand(cmd, options = {}) {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function streamRemoteFile(remotePath, localFile) {
    return new Promise((resolve, reject) => {
        console.log(`[exportEmbeddings] Streaming ${remotePath} -> ${localFile}...`);
        const start = Date.now();
        const tmpFile = localFile + '.tmp';

        const out = fs.createWriteStream(tmpFile);
        const cf = spawn('cf', ['ssh', APP_NAME, '-T', '-c', `cat ${remotePath}`], {
            stdio: ['ignore', 'pipe', 'inherit']
        });

        let bytes = 0;
        cf.stdout.on('data', chunk => {
            bytes += chunk.length;
        });

        cf.stdout.pipe(out);

        cf.on('close', code => {
            if (code !== 0) {
                out.close();
                fs.unlink(tmpFile, () => {});
                return reject(new Error(`cf ssh exited with code ${code}`));
            }
            out.close(() => {
                if (fs.existsSync(localFile)) {
                    fs.unlinkSync(localFile);
                }
                fs.renameSync(tmpFile, localFile);
                const duration = ((Date.now() - start) / 1000).toFixed(1);
                const mb = (bytes / (1024 * 1024)).toFixed(1);
                console.log(`[exportEmbeddings] Saved ${path.basename(localFile)} (${mb} MB in ${duration}s).`);
                resolve();
            });
        });

        cf.on('error', err => {
            out.close();
            fs.unlink(tmpFile, () => {});
            reject(err);
        });
    });
}

async function main() {
    console.log(`[exportEmbeddings] Target schema: "${SCHEMA_NAME}" | Host container: "${APP_NAME}"`);

    if (!fs.existsSync(ASSETS_DIR)) {
        fs.mkdirSync(ASSETS_DIR, { recursive: true });
    }

    if (!fs.existsSync(SERVER_SCRIPT)) {
        throw new Error(`Server export template not found: ${SERVER_SCRIPT}`);
    }

    // Step 1: Upload export script to remote container
    console.log('[exportEmbeddings] Uploading server export worker into container...');
    const scriptContent = fs.readFileSync(SERVER_SCRIPT, 'utf8');
    const uploadProcess = spawn('cf', ['ssh', APP_NAME, '-T', '-c', 'cat > /home/vcap/tmp/export_on_server.js'], {
        stdio: ['pipe', 'inherit', 'inherit']
    });
    uploadProcess.stdin.end(scriptContent);
    await new Promise((resolve, reject) => {
        uploadProcess.on('close', code => code === 0 ? resolve() : reject(new Error(`Upload failed with code ${code}`)));
        uploadProcess.on('error', reject);
    });

    // Step 2: Run export script inside container
    console.log(`[exportEmbeddings] Executing query export inside container (schema: ${SCHEMA_NAME})...`);
    const remoteRunCmd = `SCHEMA_NAME=${SCHEMA_NAME} /home/vcap/deps/0/bin/node /home/vcap/tmp/export_on_server.js`;
    const runProcess = spawn('cf', ['ssh', APP_NAME, '-T', '-c', remoteRunCmd], {
        stdio: ['ignore', 'inherit', 'inherit']
    });
    await new Promise((resolve, reject) => {
        runProcess.on('close', code => code === 0 ? resolve() : reject(new Error(`Server export failed with code ${code}`)));
        runProcess.on('error', reject);
    });

    // Step 3: Stream generated files to local assets directory
    console.log('\n[exportEmbeddings] Transferring exported embeddings to local assets folder...');
    const bpLocal = path.join(ASSETS_DIR, 'business_partner_embeddings.csv');
    const prodLocal = path.join(ASSETS_DIR, 'product_embeddings.csv');

    await streamRemoteFile('/home/vcap/tmp/business_partner_embeddings.csv', bpLocal);
    await streamRemoteFile('/home/vcap/tmp/product_embeddings.csv', prodLocal);

    // Clean up temporary container files
    console.log('\n[exportEmbeddings] Cleaning up remote temporary files...');
    try {
        runCommand(`cf ssh ${APP_NAME} -T -c "rm -f /home/vcap/tmp/export_on_server.js /home/vcap/tmp/business_partner_embeddings.csv /home/vcap/tmp/product_embeddings.csv"`);
    } catch (_) {}

    console.log(`\n======================================================================`);
    console.log(` Embeddings successfully exported to: ${ASSETS_DIR}`);
    console.log(` - business_partner_embeddings.csv`);
    console.log(` - product_embeddings.csv`);
    console.log(`======================================================================\n`);
}

main().catch(err => {
    console.error('\n[exportEmbeddings] Export failed:', err.message);
    process.exit(1);
});
