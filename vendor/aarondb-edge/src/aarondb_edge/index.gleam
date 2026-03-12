import aarondb_edge/fact.{type Datom, type Entity, type Value}
import gleam/dict.{type Dict}
import gleam/list
import gleam/result

pub type Index =
  Dict(fact.EntityId, List(Datom))

pub type AIndex =
  Dict(String, List(Datom))

pub type AVIndex =
  Dict(String, Dict(Value, Entity))

pub fn new_index() -> Index {
  dict.new()
}

pub fn new_aindex() -> AIndex {
  dict.new()
}

pub fn new_avindex() -> AVIndex {
  dict.new()
}

pub fn insert_eavt(
  index: Index,
  datom: Datom,
  retention: fact.Retention,
) -> Index {
  let bucket = dict.get(index, datom.entity) |> result_to_list
  let new_bucket = case retention {
    fact.All -> [datom, ..bucket]
    fact.LatestOnly -> {
      let filtered =
        list.filter(bucket, fn(d) { d.attribute != datom.attribute })
      [datom, ..filtered]
    }
    fact.Last(n) -> {
      let filtered =
        list.filter(bucket, fn(d) { d.attribute != datom.attribute })
      let existing =
        list.filter(bucket, fn(d) { d.attribute == datom.attribute })
      let kept = list.take(existing, n - 1)
      [datom, ..list.append(kept, filtered)]
    }
  }
  dict.insert(index, datom.entity, new_bucket)
}

pub fn insert_aevt(
  index: AIndex,
  datom: Datom,
  retention: fact.Retention,
) -> AIndex {
  let bucket = dict.get(index, datom.attribute) |> result_to_list
  let new_bucket = case retention {
    fact.All -> [datom, ..bucket]
    fact.LatestOnly -> {
      let filtered = list.filter(bucket, fn(d) { d.entity != datom.entity })
      [datom, ..filtered]
    }
    fact.Last(n) -> {
      let filtered = list.filter(bucket, fn(d) { d.entity != datom.entity })
      let existing = list.filter(bucket, fn(d) { d.entity == datom.entity })
      let kept = list.take(existing, n - 1)
      [datom, ..list.append(kept, filtered)]
    }
  }
  dict.insert(index, datom.attribute, new_bucket)
}

pub fn insert_avet(index: AVIndex, datom: Datom) -> AVIndex {
  let v_dict = dict.get(index, datom.attribute) |> result.unwrap(dict.new())
  let new_v_dict = case datom.operation {
    fact.Assert -> dict.insert(v_dict, datom.value, datom.entity)
    fact.Retract -> dict.delete(v_dict, datom.value)
  }
  dict.insert(index, datom.attribute, new_v_dict)
}

fn result_to_list(res: Result(List(a), b)) -> List(a) {
  case res {
    Ok(l) -> l
    Error(_) -> []
  }
}

pub fn get_datoms_by_entity_attr_val(
  index: Index,
  entity: fact.EntityId,
  attr: String,
  val: fact.Value,
) -> List(Datom) {
  dict.get(index, entity)
  |> result_to_list
  |> list.filter(fn(d) { d.attribute == attr && d.value == val })
}

pub fn get_datoms_by_entity_attr(
  index: Index,
  entity: fact.EntityId,
  attr: String,
) -> List(Datom) {
  dict.get(index, entity)
  |> result_to_list
  |> list.filter(fn(d) { d.attribute == attr })
}

pub fn get_datoms_by_val(
  index: AIndex,
  attr: String,
  val: fact.Value,
) -> List(Datom) {
  dict.get(index, attr)
  |> result_to_list
  |> list.filter(fn(d) { d.value == val })
}

pub fn get_all_datoms_for_attr(index: Index, attr: String) -> List(Datom) {
  dict.values(index)
  |> list.flatten
  |> list.filter(fn(d) { d.attribute == attr })
}
