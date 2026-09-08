# Playing online

How the two games are played between browsers: what a table is, how you
get to one, how you get back to it, and how a war hands its ground battles
off. This is the player's page; `MULTIPLAYER.md` is the engineer's.

## A table

A game somebody has opened for others to join. It has a **code** — six
letters, no zeros or ones, easy to read down a phone — and a **password**
the host chose when opening it. The code and the password are all anyone
needs; nobody makes an account. Share them both, or share the link the
lobby offers, which carries the code (never the password).

There are two arrangements, and the host picks one when opening the table:

- **A refereed table** has a judge on the server. It enforces the rules,
  keeps the board, plays any seat handed to the computer, and is the only
  kind that runs the fogged Triplanetary scenarios.
- **A quick table** is a shared list of moves with a password on the door.
  Every browser runs the rules itself. It needs nothing deployed beyond the
  database, and it is right for people who trust each other.

Both play both games. Triplanetary, Ogre, a battle out of the builder and an
Orbital Drop war all sit at either kind of table, and a seat can be handed to
the computer at either. One thing still needs the referee: the fogged
Triplanetary scenarios, Escape and Lateral 7, because a shared move list
rebuilds the board the fog is hiding. Everything else is a choice about how
much you trust the people you sat down with.

At a refereed table the referee plays the computer's seat. At a quick table
there is no referee, so the browser of the person in the lowest occupied seat
plays it — its orders go through the same door as everyone else's, signed by
the computer's seat, and nobody can sit in that chair. If that browser goes
away, the seat ages out in a few minutes and the next person's browser takes
the computer over. A war at a quick table does the same for its ground
battles: a side of the battle nobody at the war is playing — a base's militia,
a power whose seat is empty — is the computer's, played from the battle.

## Sitting down

Press **Play online** on a Triplanetary scenario, **Host a table** in the
Ogre picker or the battle builder, or **Join a table** from the start menu.
Joining asks for the code and the password; you land in the lobby, where
you can see the scenario, who holds which seat, and take one — or watch.
The host starts the game when every seat is filled.

Your seat belongs to this browser. Close the tab and come back and it is
still yours; the start menu lists **Your tables**, with a _Rejoin_ button
for each, and a `?join=` link to a table this browser knows brings the
password along. _Leave table_ gives the seat up for good and drops it from
the list.

## Getting a seat back

Lost the browser, or moved to a phone? Join the table with the code and the
password, find your name on the seat you held, and press **This is me**.
The seat is yours again and whoever held it is stood up. Only a table with
a password offers this, and never for a computer's seat. At a quick table
the equivalent is time: a seat nobody has been heard from in a while is
open again, and sitting there is the reclaim.

## The Train

The Ogre picker's **The Train** is an original scenario for the rulebook's
Section 9: a train has to cross the green map along the line with six squads
aboard, its escort alongside, through country the raiders got to first. The
train only runs on the rails, its speed marker changes by one step a turn
before it moves, and a counter parked on the line stops it dead until the
escort clears the way. The computer plays either side.

## A battle of your own

The Ogre picker's **Custom battle** door opens the battle builder: either
board or a fresh one generated from a seed, any mix of cybertanks, armour
and infantry on both sides, and the terms — a command post to take, a far
edge to break through to, or attrition to a turn limit. What it produces
is an order of battle; fight it at this keyboard or host it, and every
joiner rebuilds the same board. At a refereed ground table the host may
**change the setup** from the lobby until the table begins, and everyone
there sees the new terms.

## A war and its battles

Host an **Orbital Drop** war as a refereed table and the ground battles
look after themselves. When the sky freezes over a base, the referee opens
an Ogre table for the battle — same password, same people in the seats
their powers hold, the base's militia played by the computer — and every
browser at the war hops across to it. When the battle is decided, its
result goes back to the war as the war's own order, and leaving the
finished battle brings you back to the frozen sky as it thaws.

A quick table does the same thing without a referee. Every browser at the war
works out the same code for the battle's table from the war's own code, the
first to get there opens it and the rest join, and when the battle is decided
whichever browser is quickest reports the result back to the war. You will
see the same two hops either way.

A war played at one keyboard fights its ground battles in the same window, as
it always has.

## When something goes wrong

- _No table is waiting on that code._ The code or the password is wrong,
  or the table was finished or abandoned. Twenty misses in ten minutes and
  the answer is the same either way for a while.
- _Could not rejoin._ The table is gone; forget it from the start menu.
- _The referee refused that order._ The board moved under you — somebody
  else acted first — and the order no longer applies. Look again.
- _Reconnecting._ The connection dropped; the client comes back on its own
  and catches up on what it missed.
