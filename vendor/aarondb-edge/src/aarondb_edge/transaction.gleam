import aarondb_edge/fact.{type EntityId, type Operation, type Value}
import aarondb_edge/index
import aarondb_edge/shared/state.{type DbState, DbState}
import gleam/list

pub type TxOp {
  TxOp(entity: EntityId, attribute: String, value: Value, operation: Operation)
}

pub fn transact(db: DbState, ops: List(TxOp)) -> #(DbState, Int) {
  let tx_id = db.latest_tx + 1

  let #(new_eavt, new_aevt, new_avet, _i) =
    list.fold(ops, #(db.eavt, db.aevt, db.avet, 0), fn(acc, op) {
      let #(eavt, aevt, avet, i) = acc

      let datom =
        fact.new_datom(
          entity: op.entity,
          attribute: op.attribute,
          value: op.value,
          tx: tx_id,
          tx_index: i,
          operation: op.operation,
        )

      // We preserve history for Time Travel logic using fact.All (Datomic style append-only).
      let retention = fact.All

      // Insert into all three indices.
      let next_eavt = index.insert_eavt(eavt, datom, retention)
      let next_aevt = index.insert_aevt(aevt, datom, retention)
      let next_avet = index.insert_avet(avet, datom)

      #(next_eavt, next_aevt, next_avet, i + 1)
    })

  let new_state =
    DbState(
      ..db,
      eavt: new_eavt,
      aevt: new_aevt,
      avet: new_avet,
      latest_tx: tx_id,
    )

  #(new_state, tx_id)
}
