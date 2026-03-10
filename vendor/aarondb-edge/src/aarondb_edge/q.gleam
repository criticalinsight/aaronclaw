import aarondb_edge/fact
import aarondb_edge/shared/ast.{
  type BodyClause, type Part, Negative, Positive, Val, Var,
}
import gleam/list
import gleam/option.{type Option, None, Some}

pub type QueryBuilder {
  QueryBuilder(
    find: List(String),
    clauses: List(BodyClause),
    order_by: Option(ast.OrderBy),
    limit: Option(Int),
    offset: Option(Int),
    as_of: Option(Int),
  )
}

pub fn new() -> QueryBuilder {
  QueryBuilder(
    find: [],
    clauses: [],
    order_by: None,
    limit: None,
    offset: None,
    as_of: None,
  )
}

pub fn from_clauses(clauses: List(BodyClause)) -> QueryBuilder {
  QueryBuilder(
    find: [],
    clauses: clauses,
    order_by: None,
    limit: None,
    offset: None,
    as_of: None,
  )
}

pub fn select(vars: List(String)) -> QueryBuilder {
  QueryBuilder(
    find: vars,
    clauses: [],
    order_by: None,
    limit: None,
    offset: None,
    as_of: None,
  )
}

pub fn s(val: String) -> Part {
  Val(fact.Str(val))
}

pub fn i(val: Int) -> Part {
  Val(fact.Int(val))
}

pub fn v(name: String) -> Part {
  Var(name)
}

pub fn vec(val: List(Float)) -> Part {
  Val(fact.Vec(val))
}

pub fn where(
  builder: QueryBuilder,
  entity: Part,
  attr: String,
  value: Part,
) -> QueryBuilder {
  let clause = Positive(#(entity, attr, value))
  QueryBuilder(..builder, clauses: list.append(builder.clauses, [clause]))
}

pub fn negate(
  builder: QueryBuilder,
  entity: Part,
  attr: String,
  value: Part,
) -> QueryBuilder {
  let clause = Negative(#(entity, attr, value))
  QueryBuilder(..builder, clauses: list.append(builder.clauses, [clause]))
}

pub fn count(
  builder: QueryBuilder,
  into: String,
  target: String,
  filter: List(BodyClause),
) -> QueryBuilder {
  let clause = ast.Aggregate(into, ast.Count, Var(target), filter)
  QueryBuilder(..builder, clauses: list.append(builder.clauses, [clause]))
}

pub fn sum(
  builder: QueryBuilder,
  into: String,
  target: String,
  filter: List(BodyClause),
) -> QueryBuilder {
  let clause = ast.Aggregate(into, ast.Sum, Var(target), filter)
  QueryBuilder(..builder, clauses: list.append(builder.clauses, [clause]))
}

pub fn limit(builder: QueryBuilder, n: Int) -> QueryBuilder {
  QueryBuilder(..builder, limit: Some(n))
}

pub fn offset(builder: QueryBuilder, n: Int) -> QueryBuilder {
  QueryBuilder(..builder, offset: Some(n))
}

pub fn order_by(
  builder: QueryBuilder,
  variable: String,
  direction: ast.OrderDirection,
) -> QueryBuilder {
  QueryBuilder(..builder, order_by: Some(ast.OrderBy(variable, direction)))
}

pub fn as_of(builder: QueryBuilder, tx_id: Int) -> QueryBuilder {
  QueryBuilder(..builder, as_of: Some(tx_id))
}

pub fn to_query(builder: QueryBuilder) -> ast.Query {
  ast.Query(
    find: builder.find,
    where: builder.clauses,
    order_by: builder.order_by,
    limit: builder.limit,
    offset: builder.offset,
    as_of: builder.as_of,
  )
}
