import aarondb_edge/fact.{type Value, Float, Int, Str}
import aarondb_edge/storage/internal.{
  type CrackingNode, type StorageChunk, Branch, Leaf,
}
import gleam/float
import gleam/int
import gleam/list
import gleam/order
import gleam/string

pub fn partition(node: CrackingNode, pivot: fact.Value) -> CrackingNode {
  case node {
    Leaf(values) -> {
      let #(smaller, larger) =
        list.partition(values, fn(v) { fact.compare(v, pivot) == order.Lt })
      Branch(pivot, Leaf(smaller), Leaf(larger))
    }
    Branch(p, left, right) -> {
      case fact.compare(pivot, p) {
        order.Lt -> Branch(p, partition(left, pivot), right)
        _ -> Branch(p, left, partition(right, pivot))
      }
    }
  }
}

pub fn crack_chunk(chunk: StorageChunk, pivot: Value) -> StorageChunk {
  internal.StorageChunk(..chunk, values: crack_node(chunk.values, pivot))
}

fn crack_node(node: CrackingNode, pivot: Value) -> CrackingNode {
  case node {
    Leaf(values) -> {
      let #(left_vals, right_vals) =
        list.partition(values, fn(v) { compare_values(v, pivot) == order.Lt })
      case list.is_empty(left_vals) || list.is_empty(right_vals) {
        True -> Leaf(values)
        // Cannot crack further with this pivot
        False ->
          Branch(pivot: pivot, left: Leaf(left_vals), right: Leaf(right_vals))
      }
    }
    Branch(p, left, right) -> {
      case compare_values(pivot, p) {
        order.Lt ->
          Branch(pivot: p, left: crack_node(left, pivot), right: right)
        _ -> Branch(pivot: p, left: left, right: crack_node(right, pivot))
      }
    }
  }
}

pub fn compare_values(a: Value, b: Value) -> order.Order {
  case a, b {
    Int(i1), Int(i2) -> int.compare(i1, i2)
    Float(f1), Float(f2) -> float.compare(f1, f2)
    Int(i), Float(f) -> float.compare(int.to_float(i), f)
    Float(f), Int(i) -> float.compare(f, int.to_float(i))
    Str(s1), Str(s2) -> string.compare(s1, s2)
    _, _ -> order.Eq
  }
}
