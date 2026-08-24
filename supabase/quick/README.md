# Online tables, with nothing to deploy

Play Triplanetary with somebody across the internet. No command line, no
account, no server to run. You paste one file into a web page, copy two values
out of it, and that is the setup.

There is a second, heavier way to play online in this repository — a referee
that runs on Supabase and judges every move. [Which one you want](#which-of-the-two-you-want)
is at the bottom. If you are playing with people you know, this is the one.

## 1. Make a project

At [supabase.com](https://supabase.com), make a free account and a new project.
Any region. It asks for a database password — save it somewhere, though the
game never needs it.

Wait a minute or two for it to finish setting itself up.

## 2. Run the file

In your project, click **SQL Editor** in the left sidebar, then **New query**.

Open [`schema.sql`](./schema.sql) from this folder, copy the whole thing, paste
it into the box, and press **Run**.

It should say success. Running it again later is safe — every line is written
to be repeatable, so this is also how you pick up improvements.

That file makes two tables, turns on the live feed the game listens to, locks
everything behind Postgres' own security, and defines the nine calls the game
makes. Passwords are hashed inside the database and are never readable by a
browser.

## 3. Copy two values

The **Connect** button at the top of the dashboard shows both together. Under
_App Frameworks_ they appear as `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or
`SUPABASE_PUBLISHABLE_KEY`).

Otherwise: **Project Settings → Data API** for the URL, and **Project Settings
→ API Keys** for the key.

- **Project URL** — `https://<something>.supabase.co`. If you cannot find it,
  read it off the address bar: the dashboard is at
  `supabase.com/dashboard/project/<something>`.
- **A publishable key** — starts `sb_publishable_…`, or an older one starting
  `eyJ…`. Either works.

Both are meant to be public — they ship inside the web page of every Supabase
app. **Never use the secret key** (`sb_secret_…`, previously called
`service_role`). It bypasses every rule in the database and the game has no use
for it.

## 4. Play

Open the game → **Play online** → **Quick table**. Paste the URL and the key.
Both are remembered in your browser.

Then either:

- **Host a table** — pick your scenario, fleets and options _first_, because
  they are frozen the moment you host: whoever joins rebuilds that exact board.
  You choose a password and get a six-character code.
- **Join a table** — with a code and password from the host.
- **Open tables** — lists tables hosted publicly on your project.

Share the code and the password however you like. Anyone with both can sit
down.

## Housekeeping

Tables stay until you remove them. To clear old ones out, run this in the SQL
Editor whenever you feel like it:

```sql
select tri_sweep(30);   -- forget tables untouched for 30 days
```

If you turn on the `pg_cron` extension (Database → Extensions), it can do that
nightly instead:

```sql
select cron.schedule('tri-sweep', '0 4 * * *', $$select tri_sweep(30)$$);
```

## What it costs

Nothing, realistically. A game is a few kilobytes of moves. The free tier's
500 MB and two million live messages a month are far beyond what a group of
friends can get through.

## Honestly, what this does and does not protect

**The password is the door.** Anyone with the code and the password can join.
The password is checked inside the database before any read or write, and the
hash itself is unreachable from a browser.

**Your side is yours.** Sitting down mints a key that stays in your browser.
Somebody who has the password can join the table but cannot move your ships,
and an order signed by a side you are not sitting in is refused. Leave a seat
idle for five minutes and it frees up, so a closed tab does not lock a chair
forever.

**The dice are the database's.** This matters more than it sounds. Triplanetary
keeps its dice in a single number inside the game state, so a browser holding
that number could roll the next die _before_ deciding whether to open fire.
Here the database rolls it, at the moment the move is stored. Nobody sees it
coming, and replaying the game still gives exactly the same rolls.

**The rules are not enforced.** Each browser runs them, and the database stores
what it is handed. Somebody who edits their own copy of the game could store a
move the rules forbid. Every move is saved with a fingerprint of the board it
produced, so the other players' browsers notice immediately and say so rather
than quietly playing on — but noticing is not preventing. This is a game
between people who chose to sit down together.

**The move list is readable.** That is how the live feed works: a row reaches a
subscriber only if the database would let them read it, and there is no
password to check at that moment. So somebody who guessed a table code could
watch that game. Codes are six characters from a 30-letter alphabet.

**Fog of war is refused here.** Two scenarios — Escape and Lateral 7 — hide
information from one side. This mode cannot keep that secret: the move list
rebuilds the whole board, hidden ships and all. Rather than offer a secret it
cannot keep, the database turns those setups away with a message. Play them
hot-seat, solo, or on the refereed mode.

## Which of the two you want

|                                               | this one               | the refereed one                 |
| --------------------------------------------- | ---------------------- | -------------------------------- |
| Setup                                         | paste one file         | push a schema, deploy a function |
| Needs a command line or GitHub Actions        | no                     | yes                              |
| Rules enforced by                             | each browser           | the server                       |
| A modified client can propose an illegal move | yes, and others notice | no                               |
| Fog-of-war scenarios                          | refused                | supported                        |
| Accounts                                      | none                   | anonymous, automatic             |

Both use the same rules, the same map and the same dice discipline. They can
live in the same Supabase project without interfering — this one's tables are
named `tri_*`, the other's are not.

The refereed one is set up from
[the main README](../../README.md#playing-with-other-people-over-the-internet).

## If something does not work

- **"No table with that code."** — a typo, or the table is on a different
  project from the one you are pointed at.
- **"That password does not open this table."** — wrong password, or again the
  wrong project.
- **Moves do not arrive for the other player** — check **Database →
  Replication** and confirm `tri_moves` is in the `supabase_realtime`
  publication, or just re-run `schema.sql`, which adds it.
- **"Somebody else is playing that side."** — they are, or they were within the
  last five minutes. Wait it out or take the other side.
- **The two boards disagree** — the game says so rather than hiding it. Both
  players should reload; each browser rebuilds from the move list, which is
  always enough to get back to the same board.

## Checking it before you play

Paste this in the SQL Editor. Expect nine rows:

```sql
select routine_name from information_schema.routines
 where routine_name like 'tri\_%' order by routine_name;
```

`tri_roll` is deliberately **not** among them — the dice roll is not something
a browser is allowed to call on its own.
