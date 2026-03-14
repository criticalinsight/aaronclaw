import { generateDocsSiteContent } from "../src/docs-generator";
import { deploySimpleSite } from "../src/wrangler-orchestration";

const ACCOUNT_ID = "c3acded8228bc2ac657cf660dc7960d5";
const CREDENTIALS = {
  email: "moneyacad@gmail.com",
  key: "36d8c57d22827d8bb2678de3307fad3c02c33"
};

async function deployDocs() {
  console.log("🧙🏾‍♂️ Synthesizing Documentation Truth...");
  const files = await generateDocsSiteContent();
  
  console.log(`🚀 Deploying 'docs' worker to account ${ACCOUNT_ID}...`);
  try {
    const result = await deploySimpleSite(
      CREDENTIALS,
      ACCOUNT_ID,
      "docs",
      files
    );
    console.log("✅ Documentation deployment successful!");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("❌ Documentation deployment failed:", error);
    process.exit(1);
  }
}

deployDocs().catch(console.error);
