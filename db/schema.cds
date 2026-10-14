namespace sap.procurement;

using { cuid, managed } from '@sap/cds/common';

/**
 * Stores vector embeddings and search metadata for SAP Business Partners / Suppliers.
 */
entity BusinessPartnerEmbeddings : cuid, managed {
    businessPartnerId   : String(20);
    searchText          : LargeString;
    contentHash         : String(64);
    embeddingModel      : String(50);
    embeddingDimensions : Integer;
    lastEmbeddedAt      : String(100);
    embedding           : Vector(3072);
}

/**
 * Stores vector embeddings and metadata for SAP Products / Materials.
 */
entity ProductEmbeddings : cuid, managed {
    productId           : String(40);
    language            : String(5);
    description         : LargeString;
    contentHash         : String(64);
    embeddingModel      : String(50);
    embeddingDimensions : Integer;
    lastEmbeddedAt      : String(100);
    productType         : String(10);
    productGroup        : String(20);
    baseUnit            : String(10);
    embedding           : Vector(3072);
}

/**
 * Stores uploaded Sales Quotation documents and extraction state
 */
entity UploadedDocuments : cuid, managed {
    fileId           : String(100);
    fileName         : String(255);
    contentType      : String(100);
    sizeBytes        : Integer;
    extractedText    : LargeString;
    extractedJson    : LargeString;
    base64Data       : LargeString;
    conversationId   : String(255);
    userId           : String(255);
    processingStatus : String(20) default 'UPLOADED'; // UPLOADED, EXTRACTING, EXTRACTED, FAILED
    extractionError  : LargeString;
    extractedAt      : DateTime;
    lastUsedAt       : DateTime;
    quotationNumber  : String(100);
    quotationDate    : String(50);
    supplierName     : String(255);
    supplierId       : String(50);
    currency         : String(10);
    grossAmount      : Decimal(15, 2);
    netAmount        : Decimal(15, 2);
    taxAmount        : Decimal(15, 2);
    promptTokens     : Integer;
    completionTokens : Integer;
    totalTokens      : Integer;
    retryCount       : Integer default 0;
}

/**
 * Stores drafted and posted Purchase Orders generated from Sales Quotations
 */
entity SalesQuotationDrafts : cuid, managed {
    documentId          : UUID;                 // Reference to UploadedDocuments.ID
    fileName            : String(255);
    quotationNumber     : String(100);
    supplier            : String(50);
    supplierName        : String(255);
    purchasingOrg       : String(10);
    purchasingGroup     : String(10);
    companyCode         : String(10);
    plant               : String(10);
    documentCurrency    : String(10);
    grossAmount         : Decimal(15, 2);
    payload             : LargeString;          // Ready-to-post PO payload JSON
    conversationId      : String(255);
    status              : String(30) default 'DRAFTED'; // DRAFTED, POSTED, FAILED
    statusMessage       : LargeString;
    sapPurchaseOrder    : String(20);
    postedAt            : DateTime;
}