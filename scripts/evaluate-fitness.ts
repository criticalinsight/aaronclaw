import { exec } from "child_process";
import { promisify } from "util";
import { stat } from "fs/promises";

const execAsync = promisify(exec);

export interface FitnessResult {
  pass: boolean;
  score: number;
  reason?: string;
  originalSize?: number;
  newSize?: number;
}

export async function evaluateFitness(targetFile: string, originalSizeBytes: number): Promise<FitnessResult> {
  // 1. Check file size (Complection Score)
  const stats = await stat(targetFile);
  const newSize = stats.size;
  
  // We want to reduce size or keep it roughly the same. If it grew by more than 5%, it's suspicious unless justified.
  // For this pure loop, let's say it MUST be <= originalSize + 5%
  if (newSize > originalSizeBytes * 1.05) {
      return {
          pass: false,
          score: newSize,
          reason: `Complection increased. File size grew from ${originalSizeBytes} to ${newSize} bytes (>5%).`,
          originalSize: originalSizeBytes,
          newSize
      };
  }

  // 2. Typecheck
  try {
      await execAsync("npm run typecheck");
  } catch (e: any) {
      return {
          pass: false,
          score: newSize,
          reason: `Typecheck failed:\n${e.stdout}\n${e.stderr}`,
          originalSize: originalSizeBytes,
          newSize
      };
  }

  // 3. Tests
  try {
      // Run vitest in non-watch run mode
      await execAsync("npx vitest run");
  } catch (e: any) {
      return {
          pass: false,
          score: newSize,
          reason: `Tests failed:\n${e.stdout}\n${e.stderr}`,
          originalSize: originalSizeBytes,
          newSize
      };
  }

  // Pass!
  return {
      pass: true,
      score: newSize, // Lower size is better
      originalSize: originalSizeBytes,
      newSize
  };
}
