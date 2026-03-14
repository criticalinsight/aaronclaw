import { generateDocsSiteContent } from "./src/docs-generator.ts";

async function verify() {
  console.log("🧙🏾‍♂️ Synthesizing Documentation Truth...");
  const changes = await generateDocsSiteContent();
  
  const roadmap = changes.find(c => c.path === "roadmap.html");
  if (roadmap) {
    console.log(`✅ roadmap.html generated (${roadmap.content.length} bytes)`);
    if (roadmap.content.includes("Mission Roadmap") && roadmap.content.includes("Phase 2: Birth")) {
        console.log("✅ Roadmap content verified.");
    } else {
        console.log("❌ Roadmap content missing expected tokens!");
    }
  } else {
    console.log("❌ roadmap.html NOT found in changes!");
  }

  const index = changes.find(c => c.path === "index.html");
  if (index?.content.includes("roadmap.html")) {
    console.log("✅ Navigation updated in index.html");
  } else {
    console.log("❌ Navigation NOT found in index.html");
  }
}

verify().catch(console.error);
