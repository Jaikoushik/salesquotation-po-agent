const cds = require('@sap/cds');
const express = require('express');
const quotationExtractor = require('./quotationExtractor');

cds.on('bootstrap', (app) => {
    // 1. CORS headers
    app.use((req, res, next) => {
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name, X-File-ID, X-Conversation-ID, conversationid, x-conversationid'
        });
        if (req.method === 'OPTIONS') return res.status(200).end();
        next();
    });

    // 2. Health check
    app.get('/health', (req, res) => res.status(200).send('OK'));

    // 3. Raw body parser for Joule file-upload webhook (up to 50MB)
    app.use(
        ['/api/process-quotation', '/api/upload-sales-quotation', '/po-agent/api/process-quotation'],
        express.raw({
            type: '*/*',
            limit: '50mb'
        })
    );

    // 4. File upload and AI parsing handler for Joule
    const uploadHandler = async (req, res) => {
        try {
            const db = await cds.connect.to('db');
            const conversationId =
                req.headers['x-conversation-id'] ||
                req.headers['conversationid'] ||
                req.headers['x-conversationid'] ||
                req.query.conversationId ||
                req.query.conversation_id ||
                cds.utils.uuid();

            const fileName =
                req.headers['x-file-name'] ||
                req.headers['x-filename'] ||
                req.query.fileName ||
                'sales_quotation.pdf';

            if (!req.body || (Buffer.isBuffer(req.body) && req.body.length === 0)) {
                return res.status(400).json({ status: 'error', message: 'No file content received' });
            }

            const fileBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
            const mimeType = quotationExtractor.detectMimeType(fileBuffer, fileName);

            console.log(`[Joule Upload API] Received "${fileName}" (${fileBuffer.length} bytes, ${mimeType}) for conversation: ${conversationId}`);

            const result = await quotationExtractor.processQuotationBuffer(
                db,
                fileBuffer,
                fileName,
                mimeType,
                conversationId
            );

            return res.status(200).json({
                status: 'success',
                message: 'Quotation extracted and harmonized successfully',
                ...result
            });

        } catch (error) {
            console.error('[Joule Upload API Error]:', error);
            return res.status(500).json({
                status: 'error',
                message: error.message || 'Quotation processing failed'
            });
        }
    };

    app.post('/api/process-quotation', uploadHandler);
    app.post('/api/upload-sales-quotation', uploadHandler);
    app.post('/po-agent/api/process-quotation', uploadHandler);

    // 5. If Joule sends agent requests to root "/", forward to "/a2a/poagent"
    app.use((req, res, next) => {
        if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
            req.url = '/a2a/poagent';
        }
        next();
    });
});

module.exports = cds.server;
