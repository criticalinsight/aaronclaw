import aarondb_edge/fact.{type AttributeConfig}
import aarondb_edge/index.{type AIndex, type AVIndex, type Index}
import aarondb_edge/shared/ast
import aarondb_edge/storage/internal
import gleam/dict.{type Dict}
import gleam/option.{type Option}

pub type Config {
  Config(
    batch_size: Int,
  )
}

pub type DbState {
  DbState(
    eavt: Index,
    aevt: AIndex,
    avet: AVIndex,
    latest_tx: Int,
    schema: Dict(String, AttributeConfig),
    stored_rules: List(ast.Rule),
    columnar_store: Dict(String, List(internal.StorageChunk)),
    config: Config,
  )
}

pub fn new_state() -> DbState {
  DbState(
    eavt: index.new_index(),
    aevt: index.new_aindex(),
    avet: index.new_avindex(),
    latest_tx: 0,
    schema: dict.new(),
    stored_rules: [],
    columnar_store: dict.new(),
    config: Config(batch_size: 1000),
  )
}
