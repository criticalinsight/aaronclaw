import { Executor, ExecuteResult } from "@cloudflare/codemode";
import * as vm from "node:vm";

/**
 * SovereignExecutor implements the @cloudflare/codemode Executor interface
 * using Node's built-in 'vm' module. This provides a secure, local sandbox
 * for executing LLM-generated orchestration code without needing 
 * Cloudflare's paid Dynamic Worker Loader features.
 */
export class SovereignExecutor implements Executor {
  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    const logs: string[] = [];
    let result: unknown = null;

    return new Promise((resolve) => {
      // Prepare the sandbox environment
      const sandbox = {
        console: {
          log: (...args: any[]) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
          error: (...args: any[]) => logs.push(`ERROR: ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
        },
        codemode: fns,
        JSON, Math, Date, Buffer, Error, setTimeout, clearTimeout,
        __resolve: (val: unknown) => {
          result = val;
          resolve({ result, logs });
        },
        __reject: (err: any) => {
          resolve({ result: null, error: err.message || String(err), logs });
        }
      };

      const context = vm.createContext(sandbox);

      // Wrap the code in an IIFE that captures the result of the last expression if possible,
      // or at least handles resolution.
      const wrappedCode = `
        (async () => {
          try {
            // Note: codemode usually provides the 'return' in its generated logic
            const _res = await (async () => {
              ${code}
            })();
            __resolve(_res);
          } catch (e) {
            __reject(e);
          }
        })();
      `;

      try {
        vm.runInContext(wrappedCode, context, { timeout: 30000 });
      } catch (e: any) {
        resolve({
          result: null,
          error: e.message || String(e),
          logs: logs
        });
      }
    });
  }
}
