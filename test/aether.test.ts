import { describe, it, expect } from 'vitest';
import { 
  parseDomainDeclaration, 
  synthesizeD1Migration, 
  synthesizeTypescriptTypes, 
  synthesizeUiManifest 
} from '../src/aether-engine';

describe('AetherEngine Synthesis', () => {
  const sampleDeclaration = {
    domain: "inventory/warehouse",
    attributes: [
      { name: "sku", type: "string" },
      { name: "quantity", type: "number" },
      { name: "location", type: "string" }
    ]
  };

  it('should parse a valid domain declaration', () => {
    const domain = parseDomainDeclaration(JSON.stringify(sampleDeclaration));
    expect(domain.domain).toBe("inventory/warehouse");
    expect(domain.attributes).toHaveLength(3);
  });

  it('should synthesize D1 migrations correctly', () => {
    const domain = parseDomainDeclaration(JSON.stringify(sampleDeclaration));
    const sql = synthesizeD1Migration(domain);
    
    expect(sql[0]).toContain("CREATE TABLE IF NOT EXISTS inventory_warehouse");
    expect(sql[0]).toContain("sku TEXT");
    expect(sql[0]).toContain("quantity REAL");
  });

  it('should synthesize TypeScript types correctly', () => {
    const domain = parseDomainDeclaration(JSON.stringify(sampleDeclaration));
    const types = synthesizeTypescriptTypes(domain);
    
    expect(types).toContain("export interface InventoryWarehouse");
    expect(types).toContain("sku: string;");
    expect(types).toContain("quantity: number;");
  });

  it('should synthesize a UI manifest correctly', () => {
    const domain = parseDomainDeclaration(JSON.stringify(sampleDeclaration));
    const ui = synthesizeUiManifest(domain);
    
    expect(ui.title).toBe("Inventory/Warehouse");
    expect(ui.fields).toHaveLength(3);
    expect(ui.fields[0].label).toBe("Sku");
  });
});
