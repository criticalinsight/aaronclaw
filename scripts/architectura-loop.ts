import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { evaluateFitness } from "./evaluate-fitness.js";

const execAsync = promisify(exec);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY environment variable is required.");
  process.exit(1);
}

const TARGET_FILE = process.argv[2];
if (!TARGET_FILE) {
  console.error("❌ Please provide a target file path (e.g., src/assistant.ts)");
  process.exit(1);
}

const targetPath = resolve(process.cwd(), TARGET_FILE);

async function generateMutation(originalCode: string, promptText: string): Promise<string> {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=" + GEMINI_API_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: promptText },
            { text: "Here is the target code to refactor:\n\n```typescript\n" + originalCode + "\n```" }
          ]
        }
      ],
      systemInstruction: {
        role: "system",
        parts: [{ text: "You are Architectura. You must output raw code only. Do not wrap in ```typescript or ```. Just the code." }]
      },
      generationConfig: {
        temperature: 0.2
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API failed: ${err}`);
  }

  const data = await response.json();
  let code = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  
  // Strip any accidental markdown blocks
  if (code.startsWith("```typescript")) code = code.slice(13);
  if (code.startsWith("```ts")) code = code.slice(5);
  if (code.startsWith("```")) code = code.slice(3);
  if (code.endsWith("```")) code = code.slice(0, -3);

  return code.trim() + "\n";
}

async function runAutoresearchLoop() {
  console.log(`🧙🏾‍♂️ Architectura Autoresearch Engine Initiated`);
  console.log(`🎯 Target: ${TARGET_FILE}`);

  try {
    const promptPath = resolve(process.cwd(), "prompts/architectural_intent.md");
    const promptText = await readFile(promptPath, "utf-8");
    const originalCode = await readFile(targetPath, "utf-8");
    const originalSizeBytes = Buffer.byteLength(originalCode, "utf-8");

    console.log(`📊 Original Size: ${originalSizeBytes} bytes`);
    
    // Evaluate current state just to make sure tests pass before we mutate
    console.log(`🧪 Running baseline fitness check...`);
    const baseline = await evaluateFitness(targetPath, originalSizeBytes);
    if (!baseline.pass) {
      console.error(`❌ Baseline failed! Cannot start autoresearch on broken code.\n${baseline.reason}`);
      process.exit(1);
    }
    console.log(`✅ Baseline passed.\n`);

    console.log(`🧠 Synthesizing mutation...`);
    const mutatedCode = await generateMutation(originalCode, promptText);

    console.log(`💾 Applying mutation to disk...`);
    await writeFile(targetPath, mutatedCode, "utf-8");

    console.log(`⚖️ Evaluating fitness of mutation...`);
    const result = await evaluateFitness(targetPath, originalSizeBytes);

    if (result.pass) {
      console.log(`🎉 Mutation SUCCESS! Size changed from ${originalSizeBytes} to ${result.newSize} bytes.`);
      console.log(`📦 Committing change via git...`);
      await execAsync(`git add ${TARGET_FILE} && git commit -m "refactor(architectura): autonomous de-complection of ${TARGET_FILE}"`);
      console.log(`✅ Refactor committed.`);
    } else {
      console.log(`⚠️ Mutation FAILED: ${result.reason}`);
      console.log(`⏪ Reverting changes...`);
      await execAsync(`git checkout -- ${TARGET_FILE}`);
      console.log(`✅ Revert complete. Discarded failed experiment.`);
    }

  } catch (error: any) {
    console.error(`💥 Fatal Error:`, error.message);
    console.log(`⏪ Attempting emergency revert...`);
    try {
      await execAsync(`git checkout -- ${TARGET_FILE}`);
    } catch {}
    process.exit(1);
  }
}

runAutoresearchLoop();
