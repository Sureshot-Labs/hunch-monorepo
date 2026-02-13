export const UNREALIZED_PNL_COMPONENT_SQL = `
  case
    when p.side <> 'FLAT' and p.size > 0 then
      coalesce(
        case
          when p.average_price is not null
           and umt.outcome_side in ('YES', 'NO')
           and upper(coalesce(m.resolved_outcome, '')) in ('YES', 'NO')
            then (
              case
                when upper(m.resolved_outcome) = 'YES' and umt.outcome_side = 'YES' then 1::numeric
                when upper(m.resolved_outcome) = 'NO' and umt.outcome_side = 'NO' then 1::numeric
                else 0::numeric
              end * p.size
            ) - (p.average_price * p.size)
          when p.average_price is not null
           and umt.outcome_side in ('YES', 'NO')
           and m.resolved_outcome_pct is not null
            then (
              case
                when umt.outcome_side = 'YES'
                  then least(greatest(m.resolved_outcome_pct::numeric / 10000.0, 0::numeric), 1::numeric)
                else 1::numeric - least(greatest(m.resolved_outcome_pct::numeric / 10000.0, 0::numeric), 1::numeric)
              end * p.size
            ) - (p.average_price * p.size)
          else null
        end,
        p.unrealized_pnl,
        0
      )
    else 0
  end
`;

export const EFFECTIVE_PNL_SQL = `
  coalesce(p.realized_pnl, 0) + (${UNREALIZED_PNL_COMPONENT_SQL})
`;
