/**
 * 🧙🏾‍♂️ Aether Engine: Intent-Driven Domain Synthesis.
 * This component transforms declarative domain models into operational reality.
 */

export type AttributeType = "string" | "number" | "boolean" | "ref" | "json";

export interface AttributeDefinition {
    ident: string;
    type: AttributeType;
    cardinality: "one" | "many";
    doc?: string;
    indexed?: boolean;
}

export interface DomainDeclaration {
    domain: string;
    doc?: string;
    attributes: AttributeDefinition[];
}

export interface SynthesisResult {
    sql: string[];
    typescript: string;
    uiManifest: any;
}

/**
 * Parses a Datalog-flavored JSON declaration and normalizes it.
 */
export function parseDomainDeclaration(input: string | object): DomainDeclaration {
    const raw = typeof input === 'string' ? JSON.parse(input) : input;
    
    if (!raw.domain || !Array.isArray(raw.attributes)) {
        throw new Error("Invalid domain declaration: 'domain' and 'attributes' are required.");
    }

    const attributes: AttributeDefinition[] = raw.attributes.map((attr: any) => {
        const name = attr.name || (attr.ident ? attr.ident.split("/").pop() : "unknown");
        const ident = attr.ident || `${raw.domain}/${name}`;
        
        return {
            ident,
            type: (attr.type || "string") as AttributeType,
            cardinality: (attr.cardinality || "one") as "one" | "many",
            doc: attr.doc,
            indexed: !!attr.indexed
        };
    });

    return {
        domain: raw.domain,
        doc: raw.doc,
        attributes
    };
}

/**
 * Generates D1 SQL migrations from a domain declaration.
 */
export function synthesizeD1Migration(declaration: DomainDeclaration): string[] {
    const tableName = declaration.domain.replace(/\//g, "_");
    const sql: string[] = [];

    const columns = declaration.attributes.map(attr => {
        const sqlName = attr.ident.split("/").pop() || attr.ident;
        let sqlType = "TEXT";
        if (attr.type === "number") sqlType = "REAL";
        if (attr.type === "boolean") sqlType = "INTEGER"; // SQLite 0/1
        return `  ${sqlName} ${sqlType}${attr.cardinality === "many" ? "" : ""}`;
    });

    sql.push(`CREATE TABLE IF NOT EXISTS ${tableName} (\n  id TEXT PRIMARY KEY,\n${columns.join(",\n")}\n);`);

    declaration.attributes.forEach(attr => {
        if (attr.indexed) {
            const sqlName = attr.ident.split("/").pop() || attr.ident;
            sql.push(`CREATE INDEX IF NOT EXISTS idx_${tableName}_${sqlName} ON ${tableName} (${sqlName});`);
        }
    });

    return sql;
}

/**
 * Generates TypeScript interfaces for the domain.
 */
export function synthesizeTypescriptTypes(declaration: DomainDeclaration): string {
    const interfaceName = declaration.domain
        .split("/")
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
    
    const fields = declaration.attributes.map(attr => {
        const tsName = attr.ident.split("/").pop() || attr.ident;
        let tsType = "string";
        if (attr.type === "number") tsType = "number";
        if (attr.type === "boolean") tsType = "boolean";
        if (attr.type === "ref") tsType = "string";
        if (attr.type === "json") tsType = "any";
        
        return `    ${tsName}: ${tsType}${attr.cardinality === "many" ? "[]" : ""};`;
    });

    return `export interface ${interfaceName} {\n    id: string;\n${fields.join("\n")}\n}`;
}

/**
 * Generates a UI manifest for the Schematic UI.
 */
export function synthesizeUiManifest(declaration: DomainDeclaration): any {
    return {
        domain: declaration.domain,
        title: declaration.doc || declaration.domain.split("/").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("/"),
        fields: declaration.attributes.map(attr => {
            const name = attr.ident.split("/").pop() || attr.ident;
            return {
                label: name.charAt(0).toUpperCase() + name.slice(1),
                key: name,
                type: attr.type,
                cardinality: attr.cardinality
            };
        })
    };
}
