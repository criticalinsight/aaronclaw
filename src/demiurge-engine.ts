export type AccessPolicyDSL = {
  version: "1.0";
  rules: {
    pathPattern: string;
    allowRoles: string[];
    denyRoles?: string[];
    allowUnauthenticated?: boolean;
  }[];
  defaultAction: "allow" | "deny";
};

export function evaluateDemiurgeAccess(
  dsl: AccessPolicyDSL,
  path: string,
  role?: string
): boolean {
  for (const rule of dsl.rules) {
    const pathMatch = new RegExp(`^${rule.pathPattern.replace(/\*/g, ".*")}$`).test(path);
    if (pathMatch) {
      if (!role) {
        return !!rule.allowUnauthenticated;
      }
      if (rule.denyRoles?.includes(role)) {
        return false;
      }
      if (rule.allowRoles.includes(role) || rule.allowRoles.includes("*")) {
        return true;
      }
    }
  }

  return dsl.defaultAction === "allow";
}
