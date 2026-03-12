import aarondb_edge/fact
import gleam/option.{type Option}

pub type PullPattern =
  List(PullItem)

pub type PullItem {
  Wildcard
  Attr(String)
  Nested(String, PullPattern)
  Except(List(String))
  PullRecursion(String, Int)
}

pub type Query {
  Query(
    find: List(String),
    where: List(BodyClause),
    order_by: Option(OrderBy),
    limit: Option(Int),
    offset: Option(Int),
    as_of: Option(Int),
  )
}

pub type OrderBy {
  OrderBy(variable: String, direction: OrderDirection)
}

pub type Clause =
  #(Part, String, Part)

pub type Part {
  Var(String)
  Uid(fact.EntityId)
  Val(fact.Value)
  AttrVal(String)
  Lookup(#(String, fact.Value))
}

pub type BodyClause {
  Positive(Clause)
  Negative(Clause)
  Filter(Expression)
  Bind(Part, Part)
  Aggregate(
    variable: String,
    func: AggFunc,
    target: Part,
    filter: List(BodyClause),
  )
  GraphGroupBy(List(String))
  GroupBy(String)
  LimitClause(Int)
  OffsetClause(Int)
  OrderByClause(String, OrderDirection)
  Union(List(List(BodyClause)))
  Subquery(List(BodyClause))
  Recursion(variable: String, clauses: List(BodyClause))
  Temporal(
    type_: TemporalType,
    time: Int,
    op: TemporalOp,
    variable: String,
    entity: Part,
    clauses: List(BodyClause),
  )
  Neighbors(from: Part, edge: String, depth: Int, node_var: String)
  CycleDetect(edge: String, cycle_var: String)
  BetweennessCentrality(edge: String, entity_var: String, score_var: String)
  StronglyConnectedComponents(
    edge: String,
    entity_var: String,
    component_var: String,
  )
  TopologicalSort(edge: String, entity_var: String, order_var: String)
  ConnectedComponents(edge: String, entity_var: String, component_var: String)
  Reachable(from: Part, edge: String, node_var: String)
  Similarity(variable: String, target: Part, threshold: Float)
  SimilarityEntity(variable: String, target: Part, threshold: Float)
  CustomIndex(
    variable: String,
    index_name: String,
    query: IndexQuery,
    threshold: Float,
  )
  ShortestPath(
    from: Part,
    to: Part,
    edge: String,
    path_var: String,
    cost_var: Option(String),
    max_depth: Option(Int),
  )
  PageRank(
    entity_var: String,
    edge: String,
    rank_var: String,
    damping: Float,
    iterations: Int,
  )
  StartsWith(variable: String, prefix: String)
  Virtual(adapter_name: String, args: List(Part), outputs: List(String))
  Pull(variable: String, entity: Part, pattern: PullPattern)
  Cognitive(concept: Part, context: Part, threshold: Float, engram_var: String)
}

pub type AggFunc {
  Sum
  Count
  Min
  Max
  Avg
  Median
}

pub type OrderDirection {
  Asc
  Desc
}

pub type TemporalType {
  Tx
  Valid
}

pub type TemporalOp {
  At
  Since
  Until
  Before
  After
  Range
}

pub type Expression {
  Eq(Part, Part)
  Neq(Part, Part)
  Gt(Part, Part)
  Lt(Part, Part)
  And(Expression, Expression)
  Or(Expression, Expression)
}

pub type Step {
  In(String)
  Out(String)
}

pub type Rule {
  Rule(head: Clause, body: List(BodyClause))
}

pub type IndexQuery {
  TextQuery(text: String)
  NumericRange(min: Float, max: Float)
  Custom(data: String)
}
