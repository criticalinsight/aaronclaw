import type { JsonObject } from "./session-state";

export interface ResourceMap {
    d1: string[];
    kv: string[];
    vectorize: string[];
    ai: boolean;
}

/**
 * 🧙🏾‍♂️ Wiring Engine: De-complecting resource discovery from app creation.
 * Scans the parent environment to identify sharable substrate components.
 */
export function discoverResources(env: any): ResourceMap {
    const resources: ResourceMap = {
        d1: [],
        kv: [],
        vectorize: [],
        ai: !!env.AI
    };

    // Discovery logic: Identifying bindings by testing for common methods
    // In Worker context, we iterate over the env object
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'object' && value !== null) {
            const proto = Object.getPrototypeOf(value);
            
            // D1 check: has .prepare()
            if ('prepare' in value && typeof (value as any).prepare === 'function') {
                resources.d1.push(key);
            }
            // KV check: has .get() and .put()
            else if ('get' in value && 'put' in value && typeof (value as any).get === 'function') {
                resources.kv.push(key);
            }
            // Vectorize check: has .insert() and .query()
            else if ('insert' in value && 'query' in value && typeof (value as any).insert === 'function') {
                resources.vectorize.push(key);
            }
        }
    }

    return resources;
}

/**
 * 🧙🏾‍♂️ Generates a wrangler.jsonc string with inherited bindings.
 */
export function generateWranglerConfig(appName: string, resources: ResourceMap): string {
    const config: any = {
        "name": appName,
        "main": "src/index.ts",
        "compatibility_date": new Date().toISOString().split('T')[0],
        "observability": {
            "enabled": true
        },
        "d1_databases": resources.d1.map(key => ({
            "binding": key,
            "database_name": key, // Mapping binding to name for simplicity in seed
            "database_id": "REPLACE_WITH_ID" // IDs must be fetched via API or passed in
        })),
        "kv_namespaces": resources.kv.map(key => ({
            "binding": key,
            "id": "REPLACE_WITH_ID"
        })),
        "vectorize_indexes": resources.vectorize.map(key => ({
            "binding": key,
            "index_name": key
        }))
    };

    if (resources.ai) {
        config.ai = { "binding": "AI" };
    }

    return JSON.stringify(config, null, 2);
}
