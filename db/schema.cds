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