import aarondb_edge/fact
import aarondb_edge/shared/ast
import aarondb_edge/storage/internal
import gleam/dict.{type Dict}
import gleam/option.{type Option}

pub type PullResult {
  PullMap(Dict(String, PullResult))
  PullSingle(fact.Value)
  PullMany(List(fact.Value))
  PullNestedMany(List(PullResult))
  PullRawBinary(BitArray)
}

pub type QueryResult {
  QueryResult(
    rows: List(Dict(String, fact.Value)),
    metadata: QueryMetadata,
    updated_columnar_store: Option(Dict(String, List(internal.StorageChunk))),
  )
}

pub type QueryMetadata {
  QueryMetadata(
    tx_id: Option(Int),
    valid_time: Option(Int),
    execution_time_ms: Int,
    index_hits: Int,
    plan: String,
    shard_id: Option(Int),
    aggregates: Dict(String, ast.AggFunc),
  )
}
