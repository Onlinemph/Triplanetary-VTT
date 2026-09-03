-- Changing a table's setup from its lobby.
--
-- `reconfigure_game` replaces everything `create_game` wrote except the code,
-- the kind, the host and the password: a new scenario, seed, options, opening
-- board and roster, in one transaction and only while the table is still in
-- its lobby. The referee has already decided who keeps which seat (see
-- `reconfigure` in referee.ts); this writes the roster it hands over. A lobby
-- has no log and no views, so there is nothing else to reconcile — but the
-- views are cleared all the same, so a stale snapshot cannot survive a
-- change of board.

create or replace function public.reconfigure_game(
  p_game     uuid,
  p_host     uuid,
  p_scenario text,
  p_fog      boolean,
  p_seed     bigint,
  p_options  jsonb,
  p_fleets   jsonb,
  p_state    jsonb,
  p_turn     integer,
  p_seats    jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_host   uuid;
begin
  select g.status, g.host_id into v_status, v_host
    from public.games g
   where g.id = p_game
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;
  if v_host <> p_host then
    return jsonb_build_object('ok', false, 'reason', 'not-host');
  end if;
  if v_status <> 'lobby' then
    return jsonb_build_object('ok', false, 'reason', 'begun');
  end if;

  update public.games
     set scenario_id = p_scenario,
         fog         = p_fog,
         turn        = p_turn
   where id = p_game;

  update public.game_secrets
     set seed    = p_seed,
         options = p_options,
         fleets  = p_fleets,
         state   = p_state
   where game_id = p_game;

  delete from public.views where game_id = p_game;
  delete from public.seats where game_id = p_game;

  insert into public.seats (game_id, seat, ordinal, faction, name, kind, user_id, last_seen)
  select p_game, e.seat, e.ordinal, e.faction, e.name, e.kind, e.user_id, e.last_seen
    from jsonb_to_recordset(p_seats)
      as e(seat text, ordinal integer, faction text, name text, kind text,
           user_id uuid, last_seen timestamptz);

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function
  public.reconfigure_game(uuid, uuid, text, boolean, bigint, jsonb, jsonb, jsonb, integer, jsonb)
from public, anon, authenticated;

grant execute on function
  public.reconfigure_game(uuid, uuid, text, boolean, bigint, jsonb, jsonb, jsonb, integer, jsonb)
to service_role;
