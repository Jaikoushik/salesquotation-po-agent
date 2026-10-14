using { PURCHASEORDER_0001 as PO   } from './external/PURCHASEORDER_0001';
using { API_BUSINESS_PARTNER_0001 as BP   } from './external/API_BUSINESS_PARTNER_0001';
using { API_PRODUCT_SRV_0001      as PROD } from './external/API_PRODUCT_SRV_0001';

/**
 * Sales Quotation → Purchase Order Agent Service
 *
 * @agent tells @cap-js/agents to:
 *   - Pick up AGENTS.MD from ./salesquotation-po-agent/ as the LLM system prompt
 *   - Expose the actions below as callable tools via MCP / A2A protocol
 */
@agent
service POAgentService {

    // ── Agent Tools ───────────────────────────────────────────────────────────

    /** Look up a supplier in S/4HANA by name or ID. Returns matched supplier IDs. */
    action lookupSupplier(
        searchTerm   : String,
        supplierName : String
    ) returns array of SupplierResult;

    /** Look up a product/material in S/4HANA by name or number. */
    action lookupProduct(
        searchTerm  : String,
        productName : String,
        material    : String
    ) returns array of ProductResult;

    /**
     * POST a Purchase Order to S/4HANA (OData V4 deep-insert).
     * This is the final step — call after all IDs are resolved and user confirmed.
     */
    @agent.hitl: true
    @Common.IsActionCritical: true
    action postPurchaseOrder(
        purchaseOrderType      : String default 'NB',
        supplier               : String,
        purchasingOrganization : String default '1000',
        purchasingGroup        : String default '100',
        companyCode            : String default '1000',
        documentCurrency       : String default 'INR',
        items                  : array of POItemInput
    ) returns POResult;

    // ── Return / Parameter Types ──────────────────────────────────────────────

    type SupplierResult {
        supplierId  : String;
        name        : String;
        searchTerm  : String;
    };

    type ProductResult {
        material    : String;
        description : String;
        productType : String;
        baseUnit    : String;
        productGroup: String;
    };

    type POItemInput {
        material                  : String;
        plant                     : String;
        orderQuantity             : Decimal;
        orderQuantityUnit         : String;
        netPriceAmount            : Decimal;
        priceUnit                 : Integer;
        taxCode                   : String;
        storageLocation           : String;
        materialGroup             : String;
        accountAssignmentCategory : String;
    };

    type POResult {
        success             : Boolean;
        purchaseOrderNumber : String;
        message             : String;
    };
}
