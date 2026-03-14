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

  // 7. Roadmap Dashboard
  changes.push({
    path: "roadmap.html",
    content: renderRoadmapHtml({ bootstrap })
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
                <a href="roadmap.html">Roadmap</a>
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
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap');

:root {
    --bg: #05080f;
    --surface: #0a0f18;
    --border: #1e293b;
    --border-highlight: #38bdf8;
    --text: #f8fafc;
    --muted: #64748b;
    --accent: #0ea5e9;
    --accent-glow: rgba(14, 165, 233, 0.25);
    --font-mono: "JetBrains Mono", monospace;
}

* { box-sizing: border-box; }
body {
    margin: 0;
    background-color: var(--bg);
    background-image: 
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 40px 40px;
    background-position: center top;
    color: var(--text);
    font-family: var(--font-mono);
    line-height: 1.6;
    letter-spacing: -0.02em;
}

.container {
    max-width: 1000px;
    margin: 0 auto;
    padding: 0 24px;
    background: rgba(5, 8, 15, 0.85);
    backdrop-filter: blur(4px);
}

header {
    background: var(--surface);
    border-bottom: 1px solid var(--accent);
    padding: 16px 0;
    position: sticky;
    top: 0;
    z-index: 100;
    box-shadow: 0 4px 20px var(--accent-glow);
}

header .container {
    background: transparent;
    backdrop-filter: none;
}

header h1 {
    font-size: 1.1rem;
    margin: 0;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 4px;
    font-weight: 800;
}

nav {
    display: flex;
    gap: 24px;
    margin-top: 12px;
}

nav a {
    color: var(--muted);
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 500;
    text-transform: uppercase;
    transition: all 0.2s;
    padding-bottom: 4px;
    border-bottom: 2px solid transparent;
}

nav a:hover, nav a.active {
    color: var(--text);
    border-bottom-color: var(--accent);
}

main {
    padding: 48px 0;
    min-height: 80vh;
}

.hero {
    margin-bottom: 48px;
    border-left: 2px solid var(--accent);
    padding-left: 24px;
    background: linear-gradient(90deg, var(--accent-glow) 0%, transparent 100%);
    padding-top: 16px;
    padding-bottom: 16px;
}

.hero h2 {
    font-size: 2rem;
    margin: 0 0 16px 0;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.hero p {
    font-size: 1rem;
    color: var(--text);
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
    border-radius: 0; /* Sharp schematic edges */
    transition: all 0.2s;
    position: relative;
}

/* Schematic corner markers */
.card::before, .card::after {
    content: "";
    position: absolute;
    width: 8px;
    height: 8px;
    border: 1px solid var(--accent);
    opacity: 0;
    transition: opacity 0.2s;
}
.card::before { top: -1px; left: -1px; border-right: none; border-bottom: none; }
.card::after { bottom: -1px; right: -1px; border-left: none; border-top: none; }

.card:hover {
    border-color: var(--border-highlight);
    box-shadow: inset 0 0 20px var(--accent-glow);
}

.card:hover::before, .card:hover::after {
    opacity: 1;
}

.card h3 {
    margin: 0 0 16px 0;
    color: var(--accent);
    text-transform: uppercase;
    font-size: 1rem;
    letter-spacing: 1px;
    border-bottom: 1px dashed var(--border);
    padding-bottom: 8px;
}

ul {
    padding-left: 0;
    margin: 0;
    list-style: none;
}

li {
    margin-bottom: 8px;
    position: relative;
    padding-left: 16px;
    font-size: 0.9rem;
}

li::before {
    content: ">";
    position: absolute;
    left: 0;
    color: var(--accent);
    font-weight: bold;
}

code {
    background: rgba(0,0,0,0.5);
    padding: 2px 6px;
    border: 1px solid var(--border);
    font-size: 0.85em;
    color: #38bdf8;
}

pre code {
    display: block;
    padding: 16px;
    border: 1px solid var(--border);
    background: var(--bg);
    overflow-x: auto;
    color: var(--text);
    font-size: 0.85rem;
}

.btn {
    display: inline-block;
    padding: 8px 16px;
    background: transparent;
    color: var(--accent);
    text-decoration: none;
    border: 1px solid var(--accent);
    text-transform: uppercase;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 1px;
    margin-top: 16px;
    transition: all 0.2s;
}

.btn:hover {
    background: var(--accent);
    color: var(--bg);
    box-shadow: 0 0 15px var(--accent-glow);
}

footer {
    padding: 32px 0;
    border-top: 1px solid var(--border);
    text-align: center;
    color: var(--muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 2px;
    background: var(--surface);
}

/* Roadmap Styles */
.roadmap-container {
    display: flex;
    flex-direction: column;
    gap: 48px;
    padding: 32px 0;
}

.roadmap-phase {
    position: relative;
    padding-left: 48px;
    border-left: 1px dashed var(--border);
}

.roadmap-phase::before {
    content: '';
    position: absolute;
    left: -5px;
    top: 0;
    width: 9px;
    height: 9px;
    background: var(--bg);
    border: 1px solid var(--border);
}

.roadmap-phase.active {
    border-left: 1px solid var(--accent);
}
.roadmap-phase.active::before {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent-glow);
}

.roadmap-phase.complete {
    border-left: 1px solid #10b981;
}
.roadmap-phase.complete::before {
    background: #10b981;
    border-color: #10b981;
}

.status-indicator {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 16px;
    color: var(--muted);
}
.roadmap-phase.complete .status-indicator { color: #10b981; }
.roadmap-phase.active .status-indicator { color: var(--accent); }

.led {
    width: 6px;
    height: 6px;
    background: var(--muted);
}
.pulse {
    animation: led-pulse 2s infinite;
    background: var(--accent);
}
.led-green { background: #10b981; box-shadow: 0 0 8px rgba(16, 185, 129, 0.4); }

@keyframes led-pulse {
    0% { box-shadow: 0 0 0 0 var(--accent-glow); }
    70% { box-shadow: 0 0 0 6px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
}

.roadmap-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-top: 16px;
}

.roadmap-item {
    font-size: 0.8rem;
    color: var(--text);
    padding: 8px 12px;
    border: 1px solid var(--border);
    background: rgba(0,0,0,0.2);
}

.muted { color: var(--muted); }

/* Complection Gauge */
.complection-gauge {
    margin-top: 16px;
    padding: 16px;
    background: rgba(0,0,0,0.3);
    border: 1px solid var(--border);
}

.gauge-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 0.8rem;
    text-transform: uppercase;
    color: var(--muted);
}

.gauge-track {
    height: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    position: relative;
}

.gauge-fill {
    height: 100%;
    transition: width 0.5s ease-in-out;
}

.gauge-fill.simple { background: #10b981; }
.gauge-fill.complex { background: #f59e0b; }
.gauge-fill.complected { background: #ef4444; }

.aether-console, .chronos-scrubber, .oracle-projection, .sovereign-health {
    background: var(--surface);
    border: 1px solid var(--border);
    margin-top: 24px;
    position: relative;
}

.console-header, .projection-header {
    background: rgba(0,0,0,0.3);
    padding: 8px 16px;
    font-size: 0.75rem;
    display: flex;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--muted);
}

.console-body { padding: 16px; }

.console-body .code-block {
    background: #000;
    color: #38bdf8;
    padding: 16px;
    font-size: 0.8rem;
    margin-bottom: 16px;
    border: 1px solid var(--border);
    white-space: pre-wrap;
}

.scrubber-controls {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px;
}

.scrubber-slider {
    flex-grow: 1;
    accent-color: var(--accent);
}

.scrubber-label {
    font-size: 0.75rem;
    min-width: 160px;
    color: var(--muted);
}

.delta-badge {
    padding: 2px 6px;
    font-size: 0.7rem;
    border: 1px solid;
}
.delta-positive { color: #ef4444; border-color: #ef4444; background: rgba(239, 68, 68, 0.1); }
.delta-negative { color: #10b981; border-color: #10b981; background: rgba(16, 185, 129, 0.1); }

.health-stat {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 0.8rem;
    padding: 8px;
    border-bottom: 1px dashed var(--border);
}

.sovereign-health { padding: 16px; }

.status-alert {
    color: #ef4444;
    animation: blink 1.5s infinite;
}

@keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
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
                <a href="roadmap.html">Roadmap</a>
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
                <a href="roadmap.html">Roadmap</a>
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
                <a href="roadmap.html">Roadmap</a>
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
                <a href="roadmap.html">Roadmap</a>
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

export function renderRoadmapHtml(data: any = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Roadmap | AaronClaw Docs</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header>
        <div class="container">
            <h1>AARONCLAW / SCHEMATIC</h1>
            <nav>
                <a href="index.html">Overview</a>
                <a href="roadmap.html" class="active">Roadmap</a>
                <a href="hands.html">Hands</a>
                <a href="skills.html">Skills</a>
                <a href="api.html">API</a>
                <a href="architecture.html">Architecture</a>
            </nav>
        </div>
    </header>
    <main class="container">
        <h2>Mission Roadmap</h2>
        <p class="muted">The evolutionary trajectory of the AaronClaw Software Factory.</p>

        <div class="roadmap-container">
            <!-- Phase 1 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 1: Seed [Substrate]</span>
                </div>
                <div class="card">
                    <h3>Infrastructure Primitives</h3>
                    <p>Established core dispatcher, GitHub coordinator, and tool policies. Truth is managed via AaronDB substrate.</p>
                    <div class="roadmap-grid">
                        <div class="roadmap-item">GitHub Integration</div>
                        <div class="roadmap-item">Wrangler Orchestration</div>
                        <div class="roadmap-item">Audit Foundation</div>
                    </div>
                </div>
            </section>

            <!-- Phase 2 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 2: Birth [Complete]</span>
                </div>
                <div class="card">
                    <h3>Automated Deployment Loop</h3>
                    <p>Closed the loop between code generation and live execution. Enabled one-click spawning of new edge workers.</p>
                    <div class="roadmap-grid">
                        <div class="roadmap-item">CI/CD Lifecycle</div>
                        <div class="roadmap-item">Mission Control: Telemetry</div>
                        <div class="roadmap-item">Mission Control: Terminal</div>
                        <div class="roadmap-item">App Provisioning</div>
                    </div>
                </div>
            </section>

            <!-- Phase 3 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 3: Growth [Complete]</span>
                </div>
                <div class="card">
                    <h3>Autonomous Lifecycle</h3>
                    <p>Observability and self-improvement loops. Fleet monitoring and automated refactoring via GitHub PRs.</p>
                    <div class="roadmap-grid">
                        <div class="roadmap-item">Fleet Surveillance</div>
                        <div class="roadmap-item">Hand History Visuals</div>
                        <div class="roadmap-item">Self-Improvement Loop</div>
                        <div class="roadmap-item">Vulnerability Scanner</div>
                    </div>
                </div>
            </section>

            <!-- Phase 4 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 4: Maturity [Complete]</span>
                </div>
                <div class="card">
                    <h3>Fleet Intelligence</h3>
                    <p>Cross-pollination of knowledge across the entire fleet. AI-native governance and architectural purity enforcement.</p>
                    <div class="roadmap-grid">
                        <div class="roadmap-item">Global Knowledge Vault</div>
                        <div class="roadmap-item">Multi-Tenant Factory</div>
                        <div class="roadmap-item">AI-Native Governance</div>
                    </div>
                </div>
            </section>

            <!-- Phase 5 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 5: Singularity [Complete]</span>
                </div>
                <div class="card">
                    <h3>Autonomous Operations</h3>
                    <p>Full closure of the self-improvement loop with CI/CD failure ingestion and auto-pilot deployments.</p>
                    <div class="roadmap-grid">
                        <div class="roadmap-item">CI/CD Failure Wiring</div>
                        <div class="roadmap-item">Auto-Pilot Deployment</div>
                        <div class="roadmap-item">Economic Self-Optimization</div>
                    </div>
                </div>
            </section>

            <!-- Phase 6 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 6: Nexus [Complete]</span>
                </div>
                <div class="card">
                    <h3>Multi-Factory Mesh</h3>
                    <p>Establishing a distributed knowledge and state substrate across multiple AaronClaw factory instances.</p>
                    <div class="roadmap-grid">
                        <div class="roadmap-item">D1 Replay Mesh</div>
                        <div class="roadmap-item">Cross-Account Identity</div>
                        <div class="roadmap-item">Peer Knowledge Sync</div>
                        <div class="roadmap-item">Consensus Engine</div>
                    </div>
                </div>
            </section>

            <!-- Phase 7 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 7: Guardian [Complete]</span>
                </div>
                <div class="card">
                    <h3>Proactive Governance</h3>
                    <p>Automatically rejecting architectural drift and unnecessary complexity via the Complection Engine.</p>
                    
                    <div class="complection-gauge">
                        <div class="gauge-header">
                            <span>Complection Gauge</span>
                            <span class="muted">Status: Analyzing Fleet...</span>
                        </div>
                        <div class="gauge-track">
                            <div class="gauge-fill simple" style="width: 15%"></div>
                        </div>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">Complection Engine</div>
                        <div class="roadmap-item">Governance Bouncer</div>
                        <div class="roadmap-item">Simplicity Gating</div>
                    </div>
                </div>
            </section>

            <!-- Phase 8 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 8: Aether [Complete]</span>
                </div>
                <div class="card">
                    <h3>Intent-Driven Synthesis</h3>
                    <p>Moving from text-based prompting to declarative domain modeling and automated synthesis.</p>
                    
                    <div class="aether-console">
                        <div class="console-header">
                            <span>Aether Synthesis Console</span>
                            <span class="muted">Ready for Domain Intent...</span>
                        </div>
                        <div class="console-body">
                            <div class="code-block">
{
  "domain": "inventory/warehouse",
  "attributes": [
    { "name": "sku", "type": "string" },
    { "name": "quantity", "type": "number" }
  ]
}</div>
                        </div>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">Domain Declarations</div>
                        <div class="roadmap-item">Aether Engine</div>
                        <div class="roadmap-item">Automated Spawning</div>
                    </div>
                </div>
            </section>

            <!-- Phase 9 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 9: Chronos [Complete]</span>
                </div>
                <div class="card">
                    <h3>Temporal Fact Auditing</h3>
                    <p>Replaying architectural evolution via "As-Of" queries on the immutable fact log.</p>
                    
                    <div class="chronos-scrubber">
                        <div class="scrubber-controls">
                            <span class="scrubber-label">T-Minus: <span id="chronos-val">Current</span></span>
                            <input type="range" class="scrubber-slider" min="0" max="100" value="100" id="chronos-input">
                        </div>
                        <p class="muted" style="margin-top: 0.5rem; font-size: 0.75rem;">🧙🏾‍♂️ Scrub back in time to audit the factory transformation.</p>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">As-Of Resolvers</div>
                        <div class="roadmap-item">Historical Replay</div>
                        <div class="roadmap-item">Fact Provenance</div>
                        <div class="roadmap-item">Temporal Integrity</div>
                    </div>
                </div>
            </section>

            <!-- Phase 10 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 10: Oracle [Complete]</span>
                </div>
                <div class="card">
                    <h3>Predictive Simulation</h3>
                    <p>Speculative optimization via architectural sandboxing. Foreseeing complexity before it emerges.</p>
                    
                    <div class="oracle-projection">
                        <div class="projection-header">
                            <span>Oracle Projection: <code>#742-Spawn</code></span>
                            <span class="delta-badge delta-positive">+42 Complection</span>
                        </div>
                        <p style="font-size: 0.85rem; margin-bottom: 0.5rem;"><strong>Risk:</strong> Cross-domain coupling detected between <code>inventory</code> and <code>finance</code>.</p>
                        <div class="gauge-track" style="height: 6px;">
                            <div class="gauge-fill complex" style="width: 65%"></div>
                        </div>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">Virtual Projection</div>
                        <div class="roadmap-item">Speculative ROI</div>
                        <div class="roadmap-item">Complexity Gating</div>
                        <div class="roadmap-item">Structural Mirror</div>
                    </div>
                </div>
            </section>

            <!-- Phase 11 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 11: Sovereign [Complete]</span>
                </div>
                <div class="card">
                    <h3>Infrastructural Self-Assembly</h3>
                    <p>Autonomic resource orchestration and lifecycle sovereignty. The factory is now self-sustaining.</p>
                    
                    <div class="sovereign-health">
                        <div class="health-stat">
                            <span>Active Nodes</span>
                            <span class="value">${data.sovereign?.nodes ?? 1}</span>
                        </div>
                        <div class="health-stat">
                            <span>Structural Drift</span>
                            <span class="${data.sovereign?.driftDetected ? 'status-alert' : ''}">
                                ${data.sovereign?.driftDetected ? 'DETECTED' : 'None'}
                            </span>
                        </div>
                        <div class="health-stat">
                            <span>Last Rebalance</span>
                            <span class="value" style="font-size: 0.7rem;">${data.sovereign?.lastRebalance ?? 'Never'}</span>
                        </div>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">Self-Provisioning</div>
                        <div class="roadmap-item">Drift Detection</div>
                        <div class="roadmap-item">Secret Rotation</div>
                        <div class="roadmap-item">Auth Lifecycle</div>
                    </div>
                </div>
            </section>

            <h2 style="margin: 2rem 0 1rem; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">Transcendence Horizon</h2>

            <!-- Phase 12 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 12: Economos [Complete]</span>
                </div>
                <div class="card">
                    <h3>Economic Self-Management</h3>
                    <p>Autonomous cost and efficiency auditing. Treating complexity as an architectural expense.</p>
                    
                    <div class="economos-efficiency">
                        <div class="efficiency-header">
                            <span>Overall Efficiency Score</span>
                            <span class="value">${data.economos?.overallEfficiencyScore ?? 92}%</span>
                        </div>
                        <div class="gauge-track">
                            <div class="gauge-fill" style="width: ${data.economos?.overallEfficiencyScore ?? 92}%"></div>
                        </div>
                        <div class="efficiency-stats">
                            <div class="stat">
                                <span>Stateful Places</span>
                                <span>${data.economos?.totalStatefulPlaces ?? 142}</span>
                            </div>
                            <div class="stat">
                                <span>Complexity Cost</span>
                                <span>LOW</span>
                            </div>
                        </div>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">Cost Auditing</div>
                        <div class="roadmap-item">Latency Insight</div>
                        <div class="roadmap-item">Resource Optimization</div>
                        <div class="roadmap-item">Efficiency Facts</div>
                    </div>
                </div>
            </section>

            <!-- Phase 13 -->
            <section class="roadmap-phase complete">
                <div class="status-indicator">
                    <span class="led led-green"></span>
                    <span>Phase 13: Sophia [Complete]</span>
                </div>
                <div class="card">
                    <h3>Knowledge Generation</h3>
                    <p>Recursive log analysis to synthesize new skills and optimization patterns.</p>
                    
                    <div class="scholar-yield">
                        <div class="yield-header">
                            <span>Knowledge Yield</span>
                            <span class="value">${data.sophia?.totalKnowledgeYield ?? 1} Discovered</span>
                        </div>
                        <div class="yield-patterns">
                            ${(data.sophia?.patternsDiscovered ?? []).map((p: any) => `
                                <div class="pattern-item">
                                    <div class="pattern-meta">
                                        <strong>${p.name}</strong>
                                        <span class="confidence">${Math.round(p.confidence * 100)}% Conf.</span>
                                    </div>
                                    <p>${p.description}</p>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">Log Mining</div>
                        <div class="roadmap-item">Skill Synthesis</div>
                        <div class="roadmap-item">Pattern Discovery</div>
                        <div class="roadmap-item">Meta-Reflection</div>
                    </div>
                </div>
            </section>

            <!-- Phase 14 -->
            <section class="roadmap-phase active">
                <div class="status-indicator">
                    <span class="led led-blue"></span>
                    <span>Phase 14: Architectura [Active]</span>
                </div>
                <div class="card">
                    <h3>Structural Optimization</h3>
                    <p>Autonomous de-complecting propositions based on synthesized knowledge patterns.</p>
                    
                    <div class="architectura-loop">
                        <div class="loop-header">
                            <span>Active Optimization Proposals</span>
                            <span class="value">${data.architectura?.propositions.length ?? 0} Pending</span>
                        </div>
                        <div class="proposition-list">
                            ${(data.architectura?.propositions ?? []).map((p: any) => `
                                <div class="prop-item">
                                    <div class="prop-meta">
                                        <strong>${p.type}</strong>
                                        <span class="gain">+${p.estimatedSimplicityGain}% Simplicity</span>
                                    </div>
                                    <code>${p.targetModule}</code>
                                    <p style="font-size: 0.8rem; margin-top: 0.2rem; opacity: 0.8;">${p.rationale ?? 'Structural alignment proposed.'}</p>
                                </div>
                            `).join('')}
                            ${(data.architectura?.propositions ?? []).length === 0 ? '<p style="opacity: 0.5; font-size: 0.8rem;">Monitoring structural complexity for optimization triggers...</p>' : ''}
                        </div>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">De-complecting</div>
                        <div class="roadmap-item">Auto-Refactor</div>
                        <div class="roadmap-item">Structural PRs</div>
                        <div class="roadmap-item">Self-Shaping</div>
                    </div>
                </div>
            </section>

            <!-- Phase 15 -->
            <section class="roadmap-phase active">
                <div class="status-indicator">
                    <span class="led led-blue"></span>
                    <span>Phase 15: Aeturnus [Active]</span>
                </div>
                <div class="card">
                    <h3>The Eternal Swarm</h3>
                    <p>Absolute resilience via full swarm decentralization and cross-cloud persistence.</p>
                    
                    <div class="aeturnus-swarm">
                        <div class="swarm-header">
                            <span>Swarm Health</span>
                            <span class="value">${data.aeturnus?.overallHealth ?? 0}%</span>
                        </div>
                        <div class="swarm-grid">
                            ${(data.aeturnus?.activeNodes ?? []).map((n: any) => `
                                <div class="node-status ${n.status}">
                                    <strong>${n.nodeId}</strong>
                                    <span>${n.type} | ${n.latency}ms</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <div class="roadmap-grid">
                        <div class="roadmap-item">Decentralized</div>
                        <div class="roadmap-item">Self-Healing</div>
                        <div class="roadmap-item">Persistence</div>
                        <div class="roadmap-item">Immortal</div>
                    </div>
                </div>
            </section>
        </div>
    </main>
    <footer>
        <div class="container">
            <p>🧙🏾‍♂️ "Identity is persistence. Roadmap is direction."</p>
        </div>
    </footer>
</body>
</html>`;
}
