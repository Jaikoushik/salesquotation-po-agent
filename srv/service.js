// Prevent Node.js TimeoutOverflowWarning when upstream SAP libraries schedule timers with TTLs > 24.8 days
const _origSetTimeout = global.setTimeout;
global.setTimeout = function (fn, delay, ...args) {
    if (typeof delay === 'number' && delay > 2147483647) {
        delay = 2147483647; // clamp to max 32-bit integer (~24.8 days)
    }
    return _origSetTimeout.call(this, fn, delay, ...args);
};

const cds = require('@sap/cds');
const embeddingMatcher = require('./embeddingMatcher');
const quotationExtractor = require('./quotationExtractor');

/**
 * POAgentService — Tool Handlers
 *
 * The @agent annotation on the service (service.cds) + the AGENTS.MD file
 * in ./salesquotation-po-agent/ tells @cap-js/agents to:
 *   - Use AGENTS.MD as the LLM system prompt
 *   - Auto-wire every action below as a callable tool via MCP
 *
 * This file only needs to implement the action handlers.
 * The agent orchestration (ReAct loop, tool routing) is handled by the framework.
 */
module.exports = class POAgentService extends cds.ApplicationService {

    async init() {
        // ── Connect to external S/4HANA APIs ─────────────────────────────────
        this.poAPI   = await cds.connect.to('PURCHASEORDER_0001');
        this.bpAPI   = await cds.connect.to('API_BUSINESS_PARTNER_0001');
        this.prodAPI = await cds.connect.to('API_PRODUCT_SRV_0001');

        // ── Connect to application database ──────────────────────────────────
        this.db = await cds.connect.to('db');

        // ── Initialize pgvector Embeddings Matcher (PostgreSQL) in Background ──
        embeddingMatcher.init().catch(err => {
            console.warn('[EmbeddingMatcher] Background init notice:', err.message);
        });

        // ── Tool: requestDocumentUpload (HITL trigger for Joule upload popup) ──
        this.on('requestDocumentUpload', async (req) => {
            const reason = req.data.reason || 'Please upload the Sales Quotation document (PDF or image).';
            console.log(`[requestDocumentUpload] HITL triggered for Joule. Reason: ${reason}`);
            return `requestDocumentUpload: ${reason}. Please choose a Sales Quotation PDF or image to upload.`;
        });

        // ── Tool: uploadSalesQuotation ────────────────────────────────────────
        this.on('uploadSalesQuotation', async (req) => {
            const { fileName, mimeType, content, conversationId } = req.data;
            if (!content) {
                req.reject(400, 'Document content is required.');
            }

            try {
                const buffer = Buffer.from(content, 'base64');
                const result = await quotationExtractor.processQuotationBuffer(
                    this.db,
                    buffer,
                    fileName || 'quotation.pdf',
                    mimeType || 'application/pdf',
                    conversationId || req.headers?.['x-conversation-id'] || ''
                );
                return JSON.stringify(result);
            } catch (err) {
                console.error('[uploadSalesQuotation Error]:', err);
                req.reject(500, `Quotation upload & parsing failed: ${err.message}`);
            }
        });

        // ── Tool: getUploadedDocument ─────────────────────────────────────────
        this.on('getUploadedDocument', async (req) => {
            const { documentId } = req.data;
            if (!documentId) req.reject(400, 'documentId is required');

            try {
                const { UploadedDocuments } = this.entities;
                const doc = await this.db.run(
                    SELECT.one.from(UploadedDocuments).where({ ID: documentId })
                );
                if (!doc) req.reject(404, `Document ${documentId} not found`);

                // Strip heavy raw base64 data from response
                const { base64Data, ...cleanDoc } = doc;
                return JSON.stringify(cleanDoc);
            } catch (err) {
                req.reject(500, `Failed to retrieve document: ${err.message}`);
            }
        });

        // ── Tool: listUploadedDocuments ───────────────────────────────────────
        this.on('listUploadedDocuments', async (req) => {
            try {
                const { UploadedDocuments } = this.entities;
                const convId = req.headers?.['x-conversation-id'] || req.headers?.['conversationid'] || req.query?.conversationId;
                let query = SELECT.from(UploadedDocuments);
                if (convId) {
                    query = query.where({ conversationId: String(convId).trim() });
                }
                const docs = await this.db.run(
                    query.columns('ID', 'fileName', 'contentType', 'processingStatus', 'quotationNumber', 'supplierName', 'grossAmount', 'currency', 'extractedJson', 'createdAt')
                        .orderBy`createdAt desc`
                        .limit(5)
                );
                return JSON.stringify(docs || []);
            } catch (err) {
                req.reject(500, `Failed to list documents: ${err.message}`);
            }
        });

        // ── Tool: createPOFromQuotation ───────────────────────────────────────
        this.on('createPOFromQuotation', async (req) => {
            const {
                documentId,
                purchasingOrganization = '1000',
                purchasingGroup = '100',
                companyCode = '1000',
                plant = '1120',
                taxCode,
                storageLocation
            } = req.data;

            if (!documentId) req.reject(400, 'documentId is required');

            try {
                const { UploadedDocuments, SalesQuotationDrafts } = this.entities;
                const doc = await this.db.run(
                    SELECT.one.from(UploadedDocuments).where({ ID: documentId })
                );

                if (!doc) req.reject(404, `Document ${documentId} not found`);

                let parsedInfo;
                try {
                    parsedInfo = typeof doc.extractedJson === 'string'
                        ? JSON.parse(doc.extractedJson)
                        : doc.extractedJson;
                } catch (_) {
                    parsedInfo = {};
                }

                const extracted = parsedInfo.extractedData || {};
                const harmonized = parsedInfo.harmonization || {};

                // Use harmonized supplier or fall back
                const supplierId = harmonized.supplier?.matchedSupplierId
                    || doc.supplierId
                    || '1000000';

                // Map items
                const harmonizedItems = harmonized.items || [];
                const poItems = harmonizedItems.map(it => ({
                    material: it.matchedMaterial || it.extractedDescription,
                    plant: plant || it.plant || '1120',
                    orderQuantity: it.extractedQuantity || 1,
                    orderQuantityUnit: it.matchedBaseUnit || it.extractedUnit || 'KG',
                    netPriceAmount: it.extractedUnitPrice > 0 ? it.extractedUnitPrice : 50,
                    priceUnit: 1,
                    taxCode: taxCode || it.taxCode || undefined,
                    storageLocation: storageLocation || it.storageLocation || undefined
                }));

                // Execute postPurchaseOrder action directly
                const poResult = await this.send('postPurchaseOrder', {
                    purchaseOrderType: 'NB',
                    supplier: supplierId,
                    purchasingOrganization,
                    purchasingGroup,
                    companyCode,
                    documentCurrency: extracted.currency || 'INR',
                    items: poItems
                });

                // Persist draft and result in SalesQuotationDrafts
                try {
                    const draftRecord = {
                        ID: cds.utils.uuid(),
                        documentId: doc.ID,
                        fileName: doc.fileName,
                        quotationNumber: doc.quotationNumber,
                        supplier: supplierId,
                        supplierName: harmonized.supplier?.matchedName || doc.supplierName,
                        purchasingOrg: purchasingOrganization,
                        purchasingGroup,
                        companyCode,
                        plant,
                        documentCurrency: extracted.currency || 'INR',
                        grossAmount: doc.grossAmount,
                        payload: JSON.stringify(poItems),
                        conversationId: doc.conversationId,
                        status: poResult.success ? 'POSTED' : 'FAILED',
                        statusMessage: poResult.message,
                        sapPurchaseOrder: poResult.purchaseOrderNumber || null,
                        postedAt: poResult.success ? new Date().toISOString() : null
                    };
                    await this.db.run(INSERT.into(SalesQuotationDrafts).entries(draftRecord));
                } catch (draftErr) {
                    console.warn('[createPOFromQuotation] Notice storing draft record:', draftErr.message);
                }

                return poResult;

            } catch (err) {
                console.error('[createPOFromQuotation Error]:', err);
                return {
                    success: false,
                    purchaseOrderNumber: null,
                    message: `Failed to create PO from quotation: ${err.message}`
                };
            }
        });

        // ── Tool: lookupSupplier ──────────────────────────────────────────────
        /**
         * Search for a business partner / supplier by name.
         * First performs semantic embedding match directly in PostgreSQL (pgvector),
         * with automatic fallback to live S/4HANA OData if needed.
         */
        this.on('lookupSupplier', async (req) => {
            const term = req.data.searchTerm || req.data.supplierName || '';

            // 1. Semantic Embedding Search
            try {
                const vectorMatches = await embeddingMatcher.searchSupplier(term, 5);
                if (vectorMatches && vectorMatches.length > 0) {
                    return vectorMatches.map(bp => ({
                        supplierId : bp.supplierId,
                        name       : bp.name,
                        searchTerm : bp.searchTerm || term
                    }));
                }
            } catch (err) {
                console.warn(`[lookupSupplier] Semantic search fallback to OData: ${err.message}`);
            }

            // 2. Fallback to S/4HANA OData Search
            try {
                const { A_BusinessPartner } = this.bpAPI.entities;

                const results = await this.bpAPI.run(
                    SELECT.from(A_BusinessPartner)
                        .where`contains(OrganizationBPName1, ${term}) or contains(SearchTerm1, ${term}) or BusinessPartner = ${term}`
                        .columns(
                            'BusinessPartner',
                            'OrganizationBPName1',
                            'SearchTerm1',
                            'BusinessPartnerType'
                        )
                        .limit(5)
                );

                if (!results || results.length === 0) {
                    return [];
                }

                return results.map(bp => ({
                    supplierId : bp.BusinessPartner,
                    name       : bp.OrganizationBPName1,
                    searchTerm : bp.SearchTerm1 || ''
                }));

            } catch (err) {
                req.reject(500, `Supplier lookup failed: ${err.message}`);
            }
        });

        // ── Tool: lookupProduct ───────────────────────────────────────────────
        /**
         * Search for a material/product by description or name.
         * First performs semantic embedding match directly in PostgreSQL (pgvector),
         * with automatic fallback to live S/4HANA OData if needed.
         */
        this.on('lookupProduct', async (req) => {
            const term = req.data.searchTerm || req.data.productName || req.data.material || '';

            // 1. Semantic Embedding Search
            try {
                const vectorMatches = await embeddingMatcher.searchProduct(term, 5);
                if (vectorMatches && vectorMatches.length > 0) {
                    return vectorMatches.map(p => ({
                        material    : p.material,
                        description : p.description || p.material,
                        productType : p.productType,
                        baseUnit    : p.baseUnit,
                        productGroup: p.productGroup
                    }));
                }
            } catch (err) {
                console.warn(`[lookupProduct] Semantic search fallback to OData: ${err.message}`);
            }

            // 2. Fallback to S/4HANA OData Search
            try {
                const { A_Product } = this.prodAPI.entities;

                const results = await this.prodAPI.run(
                    SELECT.from(A_Product)
                        .where`contains(Product, ${term}) or contains(ProductGroup, ${term}) or Product = ${term}`
                        .columns(
                            'Product',
                            'ProductType',
                            'BaseUnit',
                            'ProductGroup',
                            'Division'
                        )
                        .limit(5)
                );

                if (!results || results.length === 0) {
                    return [];
                }

                return results.map(p => ({
                    material    : p.Product,
                    description : p.Product,
                    productType : p.ProductType,
                    baseUnit    : p.BaseUnit,
                    productGroup: p.ProductGroup
                }));

            } catch (err) {
                req.reject(500, `Product lookup failed: ${err.message}`);
            }
        });

        // ── Tool: postPurchaseOrder ───────────────────────────────────────────
        /**
         * Create a Purchase Order in S/4HANA via a direct HTTP POST
         * to the PURCHASEORDER_0001 OData V4 API.
         *
         * The agent calls this as the FINAL step once all supplier and
         * material IDs have been resolved.
         *
         * OData V4 deep-insert payload structure:
         * {
         *   PurchaseOrderType: "NB",
         *   Supplier: "0000100001",
         *   PurchasingOrganization: "1710",
         *   PurchasingGroup: "001",
         *   CompanyCode: "1710",
         *   DocumentCurrency: "USD",
         *   _PurchaseOrderItem: [
         *     {
         *       PurchaseOrderItem: "00010",
         *       Material: "TG11",
         *       Plant: "1710",
         *       OrderQuantity: 100,
         *       PurchaseOrderQuantityUnit: "EA",
         *       NetPriceAmount: 25.00,
         *       PriceUnit: 1
         *     }
         *   ]
         * }
         */
        this.on('postPurchaseOrder', async (req) => {
            const {
                purchaseOrderType = 'NB',
                supplier,
                items = []
            } = req.data;

            // Use user-specified values if provided; fall back to defaults only when omitted
            const pOrg    = req.data.purchasingOrganization || '1000';
            const pGrp    = req.data.purchasingGroup || '100';
            const cCode   = req.data.companyCode || '1000';
            const docCurr = req.data.documentCurrency || 'INR';

            // ── Auto-resolve unit and account assignment per item ──────────────
            const processedItems = await Promise.all(items.map(async (item, idx) => {
                let unit = item.orderQuantityUnit;
                let acctAssgmt = item.accountAssignmentCategory;

                // Lookup product in S/4 to ensure correct unit and account assignment
                if (item.material) {
                    try {
                        const { A_Product } = this.prodAPI.entities;
                        const prodInfo = await this.prodAPI.run(
                            SELECT.one.from(A_Product)
                                .columns('ProductType', 'BaseUnit')
                                .where({ Product: item.material })
                        );
                        if (prodInfo) {
                            // If unit was omitted or defaulted to 'EA' on a non-EA product, use BaseUnit
                            if (!unit || (unit === 'EA' && prodInfo.BaseUnit !== 'EA')) {
                                unit = prodInfo.BaseUnit;
                            }
                            // Service materials (ProductType 'SERV') require AccountAssignmentCategory
                            if (prodInfo.ProductType === 'SERV' && !acctAssgmt) {
                                acctAssgmt = 'U'; // Unknown / default account assignment for service items
                            }
                        }
                    } catch (_) {
                        // proceed with provided inputs
                    }
                }

                unit = unit || 'KG';
                const netPrice = item.netPriceAmount != null && item.netPriceAmount > 0
                    ? item.netPriceAmount
                    : 50;

                // Use user-specified plant if provided, else default to '1120'
                const plant = item.plant || '1120';

                return {
                    PurchaseOrderItem:         String((idx + 1) * 10).padStart(5, '0'),
                    Material:                  item.material,
                    Plant:                     plant,
                    OrderQuantity:             item.orderQuantity || 1,
                    PurchaseOrderQuantityUnit: unit,
                    NetPriceAmount:            netPrice,
                    DocumentCurrency:          docCurr,
                    OrderPriceUnit:            unit,
                    NetPriceQuantity:          item.priceUnit || 1,
                    ...(item.taxCode ? { TaxCode: item.taxCode } : {}),
                    ...(item.storageLocation ? { StorageLocation: item.storageLocation } : {}),
                    ...(acctAssgmt ? { AccountAssignmentCategory: acctAssgmt } : {}),
                    ...(item.materialGroup ? { MaterialGroup: item.materialGroup } : {})
                };
            }));

            // ── Build the OData V4 POST payload ───────────────────────────────
            const payload = {
                PurchaseOrderType:       purchaseOrderType || 'NB',
                Supplier:                supplier,
                PurchasingOrganization:  pOrg,
                PurchasingGroup:         pGrp,
                CompanyCode:             cCode,
                DocumentCurrency:        docCurr,
                _PurchaseOrderItem:      processedItems
            };

            try {
                // POST directly to the OData V4 PurchaseOrder entity set
                const response = await this.poAPI.send({
                    method:  'POST',
                    path:    '/PurchaseOrder',
                    data:    payload,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept':       'application/json'
                    }
                });

                const poNumber = response?.PurchaseOrder
                    ?? response?.value?.PurchaseOrder
                    ?? JSON.stringify(response);

                return {
                    success:             true,
                    purchaseOrderNumber: poNumber,
                    message: `Purchase Order ${poNumber} created successfully in S/4HANA.`
                };

            } catch (err) {
                // Surface the actual S/4HANA OData error and details to the agent
                const remoteError = err?.reason?.response?.body?.error;
                // Filter specifically for severity 4 (blocking errors) to ignore severity 3 warnings
                const blockingErrors = remoteError?.details?.filter(d => d['@SAP__common.numericSeverity'] === 4);
                const errorDetails = (blockingErrors?.length ? blockingErrors : remoteError?.details)
                    ?.map(d => d.message).filter(Boolean).join('; ');

                const s4msg = errorDetails
                    || remoteError?.message
                    || err?.reason?.response?.data?.error?.message?.value
                    || err?.response?.data?.error?.message?.value
                    || err?.cause?.message
                    || err.message;

                return {
                    success:             false,
                    purchaseOrderNumber: null,
                    message: `PO creation failed: ${s4msg}`
                };
            }
        });

        await super.init();
    }
};
