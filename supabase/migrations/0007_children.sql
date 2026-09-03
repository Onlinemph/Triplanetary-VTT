-- A child table: the frozen sky's ground battle, fought at its own table.
--
-- When an Orbital Drop board freezes over a base, the referee opens an Ogre
-- table for the battle and links the two: the parent carries the child's code
-- so every browser at it can hop across, the child carries the parent's so
-- they can come back, and the child inherits the parent's password and host.
-- `create_child_game` writes all of that in one transaction and refuses a
-- second child while one is open; `unlink_child` clears the link once the
-- result has been handed back.

alter table public.games
  add column if not exists parent_id   uuid references public.games(id) on delete set null,
  add column if not exists child_id    uuid references public.games(id) on delete set null,
  add column if not exists parent_code text,
  add column if not exists child_code  text;

create or replace function public.create_child_game(
  p_parent   uuid,
  p_code     text,
  p_scenario text,
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
  v_id         uuid;
  v_parent     public.games%rowtype;
  v_password   text;
  v_constraint text;
begin
  select * into v_parent from public.games g where g.id = p_parent for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'gone');
  end if;
  if v_parent.child_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'has-child');
  end if;
  select s.password into v_password from public.game_secrets s where s.game_id = p_parent;

  insert into public.games (code, scenario_id, fog, status, turn, host_id, kind, parent_id, parent_code)
  values (p_code, p_scenario, false, 'lobby', p_turn, v_parent.host_id, 'ogre', p_parent, v_parent.code)
  returning id into v_id;

  insert into public.game_secrets (game_id, seed, options, fleets, state, password)
  values (v_id, p_seed, p_options, p_fleets, p_state, v_password);

  insert into public.seats (game_id, seat, ordinal, faction, name, kind, user_id, last_seen)
  select v_id, e.seat, e.ordinal, e.faction, e.name, e.kind, e.user_id, e.last_seen
    from jsonb_to_recordset(p_seats)
      as e(seat text, ordinal integer, faction text, name text, kind text,
           user_id uuid, last_seen timestamptz);

  update public.games set child_id = v_id, child_code = p_code where id = p_parent;

  return jsonb_build_object('ok', true, 'id', v_id);
exception
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'games_code_key' then
      return jsonb_build_object('ok', false, 'reason', 'code-taken');
    end if;
    raise;
end;
$$;

create or replace function public.unlink_child(p_parent uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  update public.games set child_id = null, child_code = null where id = p_parent;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function
  public.create_child_game(uuid, text, text, bigint, jsonb, jsonb, jsonb, integer, jsonb),
  public.unlink_child(uuid)
from public, anon, authenticated;

grant execute on function
  public.create_child_game(uuid, text, text, bigint, jsonb, jsonb, jsonb, integer, jsonb),
  public.unlink_child(uuid)
to service_role;
