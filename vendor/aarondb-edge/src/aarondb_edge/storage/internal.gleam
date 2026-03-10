import aarondb_edge/fact
import gleam/option.{type Option}

pub type CrackingNode {
  Leaf(values: List(fact.Value))
  Branch(pivot: fact.Value, left: CrackingNode, right: CrackingNode)
}

pub type StorageChunk {
  StorageChunk(
    attribute: fact.Attribute,
    values: CrackingNode,
    max_tx: Int,
    is_compressed: Bool,
  )
}

pub type StorageLayout {
  Row
  Columnar
}

pub type Retention {
  All
  LatestOnly
  Last(Int)
}

pub type StorageTier {
  Memory
  Disk
  Cloud
}

pub type EvictionPolicy {
  AlwaysInMemory
  LruToDisk
  LruToCloud
}

pub type Cardinality {
  Many
  One
}

pub type AttributeConfig {
  AttributeConfig(
    unique: Bool,
    component: Bool,
    retention: Retention,
    cardinality: Cardinality,
    check: Option(String),
    composite_group: Option(String),
    layout: StorageLayout,
    tier: StorageTier,
    eviction: EvictionPolicy,
  )
}
