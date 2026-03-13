import { bundledHandDefinitions } from "./hands-catalog";
import { getBundledSkillCatalog } from "./skills-runtime";
import { buildBootstrapStatus } from "./routes";
import { defaultDocsContract } from "./docs-drift";
import type { GithubFileChange } from "./github-coordinator";

/**
 * 🧙🏾‍♂️ Rich Hickey: Documentation as a derived value.
 * Synthesizes a Schematic-styled docs site from the runtime truth.
 */
export async function generateDocsSiteContent(): Promise<GithubFileChange[]> {
  const hands = bundledHandDefinitions;
  const skills = getBundledSkillCatalog();
  const bootstrap = buildBootstrapStatus();
  const contract = defaultDocsContract;

  const changes: GithubFileChange[] = [];

  // 1. Index Page
  changes.push({
    path: "index.html",
    content: renderIndexHtml(bootstrap)
  });

  // 2. CSS (Schematic Aesthetic)
  changes.push({
    path: "style.css",
    content: renderSchematicCss()
  });

  // 3. Hands Documentation
  changes.push({
    path: "hands.html",
    content: renderHandsHtml(hands)
  });

  // 4. Skills Documentation
  changes.push({
    path: "skills.html",
    content: renderSkillsHtml(skills)
  });

  // 5. API Reference
  changes.push({
    path: "api.html",
    content: renderApiHtml(bootstrap.operatorRoutes, bootstrap.sessionRoutes)
  });

  // 6. Architecture & Philosophy
  changes.push({
    path: "architecture.html",
    content: renderArchitectureHtml(contract)
  });

  return changes;
}

function renderIndexHtml(bootstrap: any): string {
  return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>AaronClaw Docs | Infrastructure</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header>
        <div class="container">
            <h1>AARONCLAW / SCHEMATIC</h1>
            <nav>
                <a href="index.html" class="active">Overview</a>
                <a href="hands.html">Hands</a>
                <a href="skills.html">Skills</a>
                <a href="api.html">API</a>
                <a href="architecture.html">Architecture</a>
            </nav>
        </div>
    </header>
    <main class="container">
        <section class="hero">
            <h2>Autonomous Software Factory</h2>
            <p>De-complecting software generation from human labor via Cloudflare-native orchestration.</p>
        </section>
        <div class="grid">
            <div class="card">
                <h3>Runtime Info</h3>
                <ul>
                    <li><strong>Service:</strong> ${bootstrap.service}</li>
                    <li><strong>Baseline:</strong> ${bootstrap.baseline}</li>
                    <li><strong>Storage:</strong> ${bootstrap.durableSourceOfTruth}</li>
                </ul>
            </div>
            <div class="card">
                <h3>Capabilities</h3>
                <p>Equipped with <strong>${bundledHandDefinitions.length}</strong> Hands and <strong>${getBundledSkillCatalog().length}</strong> Skills.</p>
                <a href="hands.html" class="btn">Explore Hands</a>
            </div>
        </div>
    </main>
    <footer>
        <div class="container">
            <p>&copy; 2026 AaronClaw Software Factory. Derived from runtime truth.</p>
        </div>
    </footer>
</body>
</html>`;
}

function renderSchematicCss(): string {
  return `
:root {
    --bg: #0a0e14;
    --surface: #121820;
    --border: #2d3748;
    --text: #e2e8f0;
    --muted: #a0aec0;
    --accent: #3182ce;
    --accent-glow: rgba(49, 130, 206, 0.2);
    --font-mono: "JetBrains Mono", "Fira Code", monospace;
    --font-sans: "Inter", system-ui, sans-serif;
}

* { box-sizing: border-box; }
body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    line-height: 1.6;
}

.container {
    max-width: 1000px;
    margin: 0 auto;
    padding: 0 24px;
}

header {
    background: var(--surface);
    border-bottom: 2px solid var(--accent);
    padding: 16px 0;
    position: sticky;
    top: 0;
    z-index: 100;
}

header h1 {
    font-family: var(--font-mono);
    font-size: 1.2rem;
    margin: 0;
    color: var(--accent);
    letter-spacing: 2px;
}

nav {
    display: flex;
    gap: 24px;
    margin-top: 12px;
}

nav a {
    color: var(--muted);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
    text-transform: uppercase;
    transition: color 0.2s;
}

nav a:hover, nav a.active {
    color: var(--accent);
}

main {
    padding: 48px 0;
}

.hero {
    margin-bottom: 48px;
    border-left: 4px solid var(--accent);
    padding-left: 24px;
}

.hero h2 {
    font-size: 2.5rem;
    margin: 0 0 16px 0;
    font-weight: 800;
}

.hero p {
    font-size: 1.2rem;
    color: var(--muted);
    max-width: 700px;
}

.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 24px;
}

.card {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 24px;
    border-radius: 4px;
    transition: transform 0.2s, border-color 0.2s;
}

.card:hover {
    border-color: var(--accent);
    box-shadow: 0 0 15px var(--accent-glow);
}

.card h3 {
    margin: 0 0 16px 0;
    font-family: var(--font-mono);
    color: var(--accent);
}

ul {
    padding-left: 20px;
    margin: 0;
}

li {
    margin-bottom: 8px;
}

code {
    font-family: var(--font-mono);
    background: #000;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.9em;
}

.btn {
    display: inline-block;
    padding: 8px 16px;
    background: var(--accent);
    color: white;
    text-decoration: none;
    border-radius: 4px;
    font-weight: 600;
    margin-top: 16px;
    font-size: 0.9rem;
}

footer {
    padding: 48px 0;
    border-top: 1px solid var(--border);
    text-align: center;
    color: var(--muted);
    font-size: 0.8rem;
}
`;
}

function renderHandsHtml(hands: readonly any[]): string {
  return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Hands | AaronClaw Docs</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header>
        <div class="container">
            <h1>AARONCLAW / SCHEMATIC</h1>
            <nav>
                <a href="index.html">Overview</a>
                <a href="hands.html" class="active">Hands</a>
                <a href="skills.html">Skills</a>
                <a href="api.html">API</a>
                <a href="architecture.html">Architecture</a>
            </nav>
        </div>
    </header>
    <main class="container">
        <h2>System Hands</h2>
        <p class="muted">Hands are high-order orchestrators that manage background tasks and system integrity.</p>
        <div class="grid">
            ${hands.map(hand => `
            <div class="card">
                <h3>${hand.label}</h3>
                <p>${hand.description}</p>
                <ul class="detail-list">
                    <li><strong>ID:</strong> <code>${hand.id}</code></li>
                    <li><strong>Runtime:</strong> ${hand.runtime}</li>
                    <li><strong>Crons:</strong> ${(hand.scheduleCrons || []).join(', ') || 'None'}</li>
                </ul>
            </div>`).join('')}
        </div>
    </main>
</body>
</html>`;
}

function renderSkillsHtml(skills: readonly any[]): string {
  return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Skills | AaronClaw Docs</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header>
        <div class="container">
            <h1>AARONCLAW / SCHEMATIC</h1>
            <nav>
                <a href="index.html">Overview</a>
                <a href="hands.html">Hands</a>
                <a href="skills.html" class="active">Skills</a>
                <a href="api.html">API</a>
                <a href="architecture.html">Architecture</a>
            </nav>
        </div>
    </header>
    <main class="container">
        <h2>System Skills</h2>
        <p class="muted">Skills are specialized capabilities deployed to workers, enabling complex reasoning and tool usage.</p>
        <div class="grid">
            ${skills.map(skill => `
            <div class="card">
                <h3>${skill.label}</h3>
                <p>${skill.description}</p>
                <ul class="detail-list">
                    <li><strong>ID:</strong> <code>${skill.id}</code></li>
                    <li><strong>Runtime:</strong> ${skill.runtime}</li>
                    <li><strong>Tools:</strong> ${(skill.declaredTools || []).join(', ')}</li>
                </ul>
            </div>`).join('')}
        </div>
    </main>
</body>
</html>`;
}

function renderApiHtml(operatorRoutes: readonly string[], sessionRoutes: readonly string[]): string {
  return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>API Reference | AaronClaw Docs</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header>
        <div class="container">
            <h1>AARONCLAW / SCHEMATIC</h1>
            <nav>
                <a href="index.html">Overview</a>
                <a href="hands.html">Hands</a>
                <a href="skills.html">Skills</a>
                <a href="api.html" class="active">API</a>
                <a href="architecture.html">Architecture</a>
            </nav>
        </div>
    </header>
    <main class="container">
        <h2>API Surface</h2>
        
        <h3>Operator Routes</h3>
        <p class="muted">Protected administrative endpoints for managing system state.</p>
        <div class="card">
            <pre><code>${(operatorRoutes || []).join('\n')}</code></pre>
        </div>

        <h3>Session Routes</h3>
        <p class="muted">Live conversation and state management endpoints.</p>
        <div class="card">
            <pre><code>${(sessionRoutes || []).join('\n')}</code></pre>
        </div>
    </main>
</body>
</html>`;
}

function renderArchitectureHtml(contract: any): string {
  return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Architecture | AaronClaw Docs</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header>
        <div class="container">
            <h1>AARONCLAW / SCHEMATIC</h1>
            <nav>
                <a href="index.html">Overview</a>
                <a href="hands.html">Hands</a>
                <a href="skills.html">Skills</a>
                <a href="api.html">API</a>
                <a href="architecture.html" class="active">Architecture</a>
            </nav>
        </div>
    </header>
    <main class="container">
        <h2>Architecture & Philosophy</h2>
        
        <div class="hero">
            <h3>Provenance & Simplicity</h3>
            <p>Built on the belief that state should be immutable, identity should be de-complected from transport, and every action must have clear provenance.</p>
        </div>

        <div class="grid">
            <div class="card">
                <h3>Documentation Contract</h3>
                <p>The system periodically checks its own documentation for drift using the <code>docs-drift</code> hand.</p>
                <ul>
                    <li><strong>Primary Path:</strong> ${contract.documentedHands.source.path}</li>
                    <li><strong>Core Section:</strong> ${contract.documentedHands.source.section}</li>
                </ul>
            </div>
            <div class="card">
                <h3>AaronDB Substrate</h3>
                <p>A Datalog-flavored fact log built on Cloudflare D1. Optimized for hyper-recall and structured state projections.</p>
            </div>
        </div>
    </main>
</body>
</html>`;
}
