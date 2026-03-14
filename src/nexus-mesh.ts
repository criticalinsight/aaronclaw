import { AaronDbFactRecord } from "./session-state";

export interface NexusPeer {
  id: string; // Peer UUID
  url: string; // Base URL of the peer node
  label: string;
  lastSeenAt: string;
  status: "online" | "offline" | "degraded";
}

export interface NexusIdentity {
  nodeId: string;
  ownerHandle: string;
  roles: string[];
}

/**
 * NexusMesh manages the distributed identity and connectivity of the AaronClaw network.
 * It leverages D1 as the persistent registry of known peers.
 */
export class NexusMesh {
  private readonly PEER_ENTITY = "nexus:peer";

  constructor(private readonly databases: D1Database[]) {}

  /**
   * Registers a peer in the local registry.
   */
  async registerPeer(peer: Omit<NexusPeer, "status" | "lastSeenAt">): Promise<void> {
    const primaryDb = this.databases[0];
    if (!primaryDb) return;

    const tx = Date.now();
    const fact: Omit<AaronDbFactRecord, "txIndex"> = {
      sessionId: "__nexus:registry__",
      entity: `${this.PEER_ENTITY}:${peer.id}`,
      attribute: "metadata",
      value: {
        ...peer,
        lastSeenAt: new Date().toISOString()
      },
      tx,
      occurredAt: new Date().toISOString(),
      operation: "assert"
    };

    await primaryDb.prepare(
      `INSERT INTO aarondb_facts (session_id, entity, attribute, value_json, tx, tx_index, occurred_at, operation)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(
      fact.sessionId,
      fact.entity,
      fact.attribute,
      JSON.stringify(fact.value),
      fact.tx,
      fact.occurredAt,
      fact.operation
    ).run();
  }

  /**
   * Lists all known peers across the synchronized substrate.
   */
  async listPeers(): Promise<NexusPeer[]> {
    const peersMap = new Map<string, NexusPeer>();

    for (const db of this.databases) {
      const results = await db.prepare(
        `SELECT value_json FROM aarondb_facts 
         WHERE session_id = '__nexus:registry__' 
           AND entity LIKE 'nexus:peer:%'
         ORDER BY tx DESC`
      ).all<{ value_json: string }>();

      for (const row of results.results) {
        try {
          const peer = JSON.parse(row.value_json) as NexusPeer;
          if (!peersMap.has(peer.id)) {
            peersMap.set(peer.id, { ...peer, status: "online" });
          }
        } catch {
          // Skip malformed records
        }
      }
    }

    return Array.from(peersMap.values());
  }

  /**
   * Propagates facts to all known online peers.
   */
  async broadcastFacts(sessionId: string, facts: AaronDbFactRecord[], authToken: string): Promise<void> {
    const peers = await this.listPeers();
    const syncPromises = peers.map(async (peer) => {
      try {
        const response = await fetch(`${peer.url}/api/sessions/${sessionId}/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`
          },
          body: JSON.stringify(facts)
        });
        if (!response.ok) {
          console.error(`Failed to sync facts to peer ${peer.id} (${peer.label}): ${response.statusText}`);
        }
      } catch (error) {
        console.error(`Error broadcasting to peer ${peer.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    await Promise.all(syncPromises);
  }
}
