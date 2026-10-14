const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cds = require('@sap/cds');
const embeddingMatcher = require('./embeddingMatcher');

// Attempt to load pdf-parse v2
let PDFParse = null;
try {
    const pdfModule = require('pdf-parse');
    PDFParse = pdfModule.PDFParse || pdfModule;
} catch (e) {
    console.warn('[quotationExtractor] Notice loading pdf-parse:', e.message);
}

class QuotationExtractor {
    constructor() {
        this.resolvedLlmDeploymentId = null;
    }

    /**
     * Detect MIME type from buffer magic bytes or file extension
     */
    detectMimeType(buffer, fileName = '') {
        if (buffer && buffer.length >= 4) {
            if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
                return 'application/pdf';
            }
            if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
                return 'image/png';
            }
            if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
                return 'image/jpeg';
            }
            if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
                return 'image/webp';
            }
        }
        const ext = path.extname(fileName || '').toLowerCase();
        switch (ext) {
            case '.pdf': return 'application/pdf';
            case '.png': return 'image/png';
            case '.jpg':
            case '.jpeg': return 'image/jpeg';
            case '.webp': return 'image/webp';
            default: return 'application/pdf';
        }
    }

    /**
     * Resolve active LLM deployment ID from SAP AI Core
     */
    async _resolveLlmDeploymentId() {
        if (process.env.AICORE_LLM_DEPLOYMENT_ID) {
            return process.env.AICORE_LLM_DEPLOYMENT_ID;
        }
        if (this.resolvedLlmDeploymentId) {
            return this.resolvedLlmDeploymentId;
        }

        const token = await embeddingMatcher._getAccessToken();
        const config = embeddingMatcher._getAiCoreConfig();

        const headers = {
            Authorization: `Bearer ${token}`
        };
        if (config.resourceGroup) {
            headers['AI-Resource-Group'] = config.resourceGroup;
        }

        const res = await axios.get(`${config.baseUrl}/v2/lm/deployments`, { headers });
        const resources = res.data?.resources || [];

        // Explicitly prioritize gpt-4.1-mini / gpt-4.1 as requested
        const targetModel = (process.env.AICORE_MODEL_NAME || 'gpt-4.1-mini').toLowerCase();
        const candidates = [targetModel, 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4'];
        let match = null;

        for (const modelTarget of candidates) {
            match = resources.find(d => {
                if (d.status !== 'RUNNING') return false;
                const name = (d.details?.resources?.backendDetails?.model?.name || d.configurationName || d.scenarioId || '').toLowerCase();
                return name.includes(modelTarget);
            });
            if (match) break;
        }

        if (!match) {
            // Pick any RUNNING chat deployment
            match = resources.find(d => d.status === 'RUNNING' && !d.configurationName?.includes('embedding'));
        }

        if (!match) {
            throw new Error(`No active chat/vision LLM deployment found in AI Core resource group "${config.resourceGroup}".`);
        }

        this.resolvedLlmDeploymentId = match.id;
        console.log(`[QuotationExtractor] Auto-discovered LLM deployment: ${this.resolvedLlmDeploymentId} (${match.details?.resources?.backendDetails?.model?.name || match.configurationName})`);
        return this.resolvedLlmDeploymentId;
    }

    /**
     * Extract raw text from PDF buffer using pdf-parse v2
     */
    async extractTextFromPdf(buffer) {
        if (!PDFParse) return '';
        try {
            if (typeof PDFParse === 'function' && PDFParse.prototype && PDFParse.prototype.getText) {
                const parser = new PDFParse({ data: buffer });
                const res = await parser.getText();
                return res?.text || '';
            }
            if (typeof PDFParse === 'function') {
                const res = await PDFParse(buffer);
                return res?.text || '';
            }
            return '';
        } catch (err) {
            console.warn('[QuotationExtractor] Notice extracting text with pdf-parse:', err.message);
            return '';
        }
    }

    /**
     * Call AI Core GPT-4o with prompt and content (text or image)
     */
    async _callLlm(messages) {
        const token = await embeddingMatcher._getAccessToken();
        const config = embeddingMatcher._getAiCoreConfig();
        const deploymentId = await this._resolveLlmDeploymentId();

        const url = `${config.baseUrl}/v2/inference/deployments/${deploymentId}/chat/completions?api-version=2024-02-01`;
        const headers = {
            Authorization: `Bearer ${token}`,
            'AI-Resource-Group': config.resourceGroup,
            'Content-Type': 'application/json'
        };

        const body = {
            messages,
            response_format: { type: 'json_object' },
            temperature: 0.1
        };

        const res = await axios.post(url, body, { headers });
        const usage = res.data?.usage || {};
        const content = res.data?.choices?.[0]?.message?.content || '{}';

        return {
            content,
            tokenUsage: {
                promptTokens: usage.prompt_tokens || 0,
                completionTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0
            }
        };
    }

    /**
     * Primary Extraction method: parses quotation details from file buffer
     */
    async extractQuotation(fileBuffer, fileName = '', mimeType = '') {
        const detectedType = mimeType || this.detectMimeType(fileBuffer, fileName);
        let extractedText = '';
        let messages = [];

        const systemPrompt = `You are an expert procurement and SAP ERP document specialist.
Your task is to accurately extract all information from this Sales Quotation (or vendor estimate/proforma invoice) and output STRICT JSON.

Rules:
1. Return ONLY valid JSON, with no markdown code blocks and no conversational text.
2. Extract all available data:
   - "quotationNumber": reference or quote number (e.g. "QT-2026-081", "9000123")
   - "quotationDate": formatted as YYYY-MM-DD
   - "supplierName": company/seller issuing the quotation
   - "supplierAddress": address or contact info if available
   - "buyerName": customer or sold-to company
   - "currency": 3-letter currency code (e.g. "INR", "USD", "EUR")
   - "netAmount": numeric subtotal before tax
   - "taxAmount": numeric total tax
   - "grossAmount": numeric total / grand total
   - "purchasingOrganization": 4-digit code if mentioned (e.g. "1000")
   - "purchasingGroup": 3-digit code if mentioned (e.g. "100")
   - "companyCode": 4-digit code if mentioned (e.g. "1000")
   - "plant": 4-digit plant code if mentioned (e.g. "1120")
   - "lineItems": array of objects:
     - "itemNumber": integer (1, 2, 3...)
     - "description": clear product or material description (strip leading numbering or bullet symbols)
     - "quantity": numeric quantity ordered/quoted
     - "unit": unit of measure (e.g. "KG", "EA", "TO", "M")
     - "unitPrice": unit price/rate before tax
     - "amount": line total amount
     - "taxCode": tax code if mentioned (e.g. "I0", "V1")
     - "storageLocation": storage location if mentioned (e.g. "101A")
     - "plant": item plant if specified

Schema:
{
  "quotationNumber": string,
  "quotationDate": string,
  "supplierName": string,
  "supplierAddress": string,
  "buyerName": string,
  "currency": string,
  "netAmount": number,
  "taxAmount": number,
  "grossAmount": number,
  "purchasingOrganization": string,
  "purchasingGroup": string,
  "companyCode": string,
  "plant": string,
  "lineItems": [
    {
      "itemNumber": number,
      "description": string,
      "quantity": number,
      "unit": string,
      "unitPrice": number,
      "amount": number,
      "taxCode": string,
      "storageLocation": string,
      "plant": string
    }
  ]
}`;

        if (detectedType === 'application/pdf') {
            extractedText = await this.extractTextFromPdf(fileBuffer);
            if (extractedText && extractedText.trim().length > 40) {
                messages = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Extract Sales Quotation data from this document text:\n\n${extractedText}` }
                ];
            } else {
                // Scanned PDF or minimal text fallback: send base64 data URL
                const base64 = fileBuffer.toString('base64');
                messages = [
                    { role: 'system', content: systemPrompt },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Extract all Sales Quotation details from this PDF document:' },
                            { type: 'image_url', image_url: { url: `data:application/pdf;base64,${base64}` } }
                        ]
                    }
                ];
            }
        } else if (detectedType.startsWith('image/')) {
            const base64 = fileBuffer.toString('base64');
            messages = [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Extract all Sales Quotation details from this image:' },
                        { type: 'image_url', image_url: { url: `data:${detectedType};base64,${base64}` } }
                    ]
                }
            ];
        } else {
            // Text or fallback
            extractedText = fileBuffer.toString('utf8');
            messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Extract Sales Quotation data from this content:\n\n${extractedText}` }
            ];
        }

        console.log(`[QuotationExtractor] Invoking AI Core GPT-4o for file "${fileName}" (${detectedType})...`);
        const { content, tokenUsage } = await this._callLlm(messages);

        let parsed;
        try {
            const cleanJson = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            parsed = JSON.parse(cleanJson);
        } catch (err) {
            throw new Error(`Failed to parse AI response as JSON: ${err.message}. Response was: ${content.slice(0, 150)}`);
        }

        return {
            extractedData: parsed,
            extractedText,
            tokenUsage
        };
    }

    /**
     * Semantic Harmonization with S/4HANA Master Data
     * Matches extracted supplier name and line items against PostgreSQL pgvector embeddings
     */
    async harmonizeWithS4Hana(extractedData, userOverrides = {}) {
        const harmonization = {
            supplier: {
                extractedName: extractedData.supplierName || '',
                matchedSupplierId: null,
                matchedName: null,
                similarity: 0,
                matchStatus: 'UNMATCHED',
                candidates: []
            },
            items: [],
            orgData: {
                purchasingOrganization: userOverrides.purchasingOrganization || extractedData.purchasingOrganization || '1000',
                purchasingGroup: userOverrides.purchasingGroup || extractedData.purchasingGroup || '100',
                companyCode: userOverrides.companyCode || extractedData.companyCode || '1000',
                documentCurrency: userOverrides.documentCurrency || extractedData.currency || 'INR',
                plant: userOverrides.plant || extractedData.plant || '1120'
            }
        };

        // 1. Resolve Supplier using Vector Embeddings
        if (extractedData.supplierName) {
            try {
                const supplierMatches = await embeddingMatcher.searchSupplier(extractedData.supplierName, 5);
                if (supplierMatches && supplierMatches.length > 0) {
                    harmonization.supplier.candidates = supplierMatches;
                    const topMatch = supplierMatches[0];
                    harmonization.supplier.matchedSupplierId = topMatch.supplierId;
                    harmonization.supplier.matchedName = topMatch.name;
                    harmonization.supplier.similarity = topMatch.similarity;
                    harmonization.supplier.matchStatus = topMatch.similarity >= 0.70 ? 'CONFIDENT_MATCH' : 'POSSIBLE_MATCH';
                }
            } catch (err) {
                console.warn('[QuotationExtractor] Notice resolving supplier embeddings:', err.message);
            }
        }

        // 2. Resolve Line Items using Vector Embeddings
        const rawItems = Array.isArray(extractedData.lineItems) ? extractedData.lineItems : [];
        for (let i = 0; i < rawItems.length; i++) {
            const rawItem = rawItems[i];
            const itemHarmonized = {
                itemNumber: rawItem.itemNumber || (i + 1),
                extractedDescription: rawItem.description || '',
                extractedQuantity: rawItem.quantity || 1,
                extractedUnit: rawItem.unit || 'KG',
                extractedUnitPrice: rawItem.unitPrice || 0,
                extractedAmount: rawItem.amount || ((rawItem.quantity || 1) * (rawItem.unitPrice || 0)),
                matchedMaterial: null,
                matchedDescription: null,
                matchedBaseUnit: null,
                matchedProductType: null,
                similarity: 0,
                matchStatus: 'UNMATCHED',
                taxCode: userOverrides.taxCode || rawItem.taxCode || '',
                storageLocation: userOverrides.storageLocation || rawItem.storageLocation || '',
                plant: userOverrides.plant || rawItem.plant || harmonization.orgData.plant,
                candidates: []
            };

            if (rawItem.description) {
                try {
                    const prodMatches = await embeddingMatcher.searchProduct(rawItem.description, 5);
                    if (prodMatches && prodMatches.length > 0) {
                        itemHarmonized.candidates = prodMatches;
                        const topProd = prodMatches[0];
                        itemHarmonized.matchedMaterial = topProd.material;
                        itemHarmonized.matchedDescription = topProd.description;
                        itemHarmonized.matchedBaseUnit = topProd.baseUnit || 'KG';
                        itemHarmonized.matchedProductType = topProd.productType || 'ZR01';
                        itemHarmonized.similarity = topProd.similarity;
                        itemHarmonized.matchStatus = topProd.similarity >= 0.70 ? 'CONFIDENT_MATCH' : 'POSSIBLE_MATCH';
                    }
                } catch (err) {
                    console.warn(`[QuotationExtractor] Notice resolving product "${rawItem.description}":`, err.message);
                }
            }

            harmonization.items.push(itemHarmonized);
        }

        // 3. Construct ready-to-post Purchase Order Payload
        const poItems = harmonization.items.map((it, idx) => {
            const unit = it.matchedBaseUnit || it.extractedUnit || 'KG';
            const price = it.extractedUnitPrice > 0 ? it.extractedUnitPrice : 50;
            return {
                PurchaseOrderItem: String((idx + 1) * 10).padStart(5, '0'),
                Material: it.matchedMaterial || it.extractedDescription,
                Plant: it.plant || harmonization.orgData.plant,
                OrderQuantity: it.extractedQuantity || 1,
                PurchaseOrderQuantityUnit: unit,
                NetPriceAmount: price,
                DocumentCurrency: harmonization.orgData.documentCurrency,
                OrderPriceUnit: unit,
                NetPriceQuantity: 1,
                ...(it.taxCode ? { TaxCode: it.taxCode } : {}),
                ...(it.storageLocation ? { StorageLocation: it.storageLocation } : {}),
                ...(it.matchedProductType === 'SERV' ? { AccountAssignmentCategory: 'U' } : {})
            };
        });

        const poPayload = {
            PurchaseOrderType: 'NB',
            Supplier: harmonization.supplier.matchedSupplierId || '1000000',
            PurchasingOrganization: harmonization.orgData.purchasingOrganization,
            PurchasingGroup: harmonization.orgData.purchasingGroup,
            CompanyCode: harmonization.orgData.companyCode,
            DocumentCurrency: harmonization.orgData.documentCurrency,
            _PurchaseOrderItem: poItems
        };

        return {
            harmonization,
            poPayload
        };
    }

    /**
     * Save uploaded document record into database
     */
    async saveUploadedDocument(db, {
        conversationId = '',
        fileReferenceId = '',
        fileName = 'quotation.pdf',
        mimeType = 'application/pdf',
        fileContent
    }) {
        const buffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent || '');
        const base64Data = buffer.toString('base64');
        const id = cds.utils.uuid();
        const convId = conversationId ? String(conversationId).trim() : id;

        const record = {
            ID: id,
            fileId: String(fileReferenceId || id).trim(),
            fileName: fileName || 'sales_quotation.pdf',
            contentType: mimeType || this.detectMimeType(buffer, fileName),
            sizeBytes: buffer.length,
            base64Data,
            extractedText: null,
            extractedJson: null,
            conversationId: convId,
            userId: 'quotation-agent',
            processingStatus: 'UPLOADED',
            extractionError: null,
            retryCount: 0,
            createdAt: new Date().toISOString()
        };

        try {
            const UploadedDocuments = db?.entities?.UploadedDocuments || 'sap.procurement.UploadedDocuments';
            await db.run(cds.ql.INSERT.into(UploadedDocuments).entries(record));
        } catch (dbErr) {
            console.warn('[QuotationExtractor] DB save notice (in-memory/no-table):', dbErr.message);
        }

        return record;
    }

    /**
     * Update database record with extracted and harmonized quotation details
     */
    async updateDocumentExtracted(db, documentId, { extractedData, extractedText, harmonization, tokenUsage }) {
        try {
            const UploadedDocuments = db?.entities?.UploadedDocuments || 'sap.procurement.UploadedDocuments';
            await db.run(
                cds.ql.UPDATE(UploadedDocuments).set({
                    processingStatus: 'EXTRACTED',
                    extractedJson: JSON.stringify({ extractedData, harmonization }),
                    extractedText: extractedText || null,
                    extractedAt: new Date().toISOString(),
                    quotationNumber: extractedData.quotationNumber || null,
                    quotationDate: extractedData.quotationDate || null,
                    supplierName: extractedData.supplierName || null,
                    supplierId: harmonization?.supplier?.matchedSupplierId || null,
                    currency: extractedData.currency || 'INR',
                    netAmount: extractedData.netAmount || null,
                    taxAmount: extractedData.taxAmount || null,
                    grossAmount: extractedData.grossAmount || null,
                    promptTokens: tokenUsage?.promptTokens || null,
                    completionTokens: tokenUsage?.completionTokens || null,
                    totalTokens: tokenUsage?.totalTokens || null,
                    extractionError: null
                }).where({ ID: documentId })
            );
        } catch (dbErr) {
            console.warn('[QuotationExtractor] DB update notice:', dbErr.message);
        }
    }

    /**
     * Complete workflow: Upload Buffer -> AI Extraction -> S/4HANA Harmonization -> DB Sync
     */
    async processQuotationBuffer(db, fileBuffer, fileName, mimeType, conversationId, userOverrides = {}) {
        const detectedType = mimeType || this.detectMimeType(fileBuffer, fileName);
        const docRecord = await this.saveUploadedDocument(db, {
            conversationId,
            fileName,
            mimeType: detectedType,
            fileContent: fileBuffer
        });

        console.log(`[QuotationExtractor] Processing quotation document ${docRecord.ID} (${fileName})...`);

        // 1. AI Extraction
        const { extractedData, extractedText, tokenUsage } = await this.extractQuotation(fileBuffer, fileName, detectedType);

        // 2. Semantic Harmonization
        const { harmonization, poPayload } = await this.harmonizeWithS4Hana(extractedData, userOverrides);

        // 3. Update DB
        await this.updateDocumentExtracted(db, docRecord.ID, {
            extractedData,
            extractedText,
            harmonization,
            tokenUsage
        });

        return {
            documentId: docRecord.ID,
            fileName,
            conversationId: docRecord.conversationId,
            status: 'EXTRACTED',
            extractedData,
            harmonization,
            poPayload,
            tokenUsage
        };
    }
}

module.exports = new QuotationExtractor();
