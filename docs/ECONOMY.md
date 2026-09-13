# The dish's economy

Value moves the way energy moves in an ecosystem: nothing appreciates out of
thin air. Every lamport entered through a purchase, a resale, or the token's
creator earnings, and the engine never reads any of it. **Fitness is in-dish
only. Value follows life; life never follows price.**

That direction matters. A world where price feeds back into survival is a
world that optimises for whatever the market rewards, and stops being a
simulation of anything.

## Where a larva's worth lives

Every larva has a **vault** inside the program, backed lamport for lamport by
the World account. Its balance is that animal's accumulated worth: visible in
the inspector, carried with it when it changes hands, and paid out when it
dies.

A newborn is offered at `0.005 SOL + 0.001 SOL × generation` (founders at
twice the base). Buying it splits the price:

| share | goes to | why |
|---|---|---|
| 60% | the larva's own vault | it starts life owning something |
| 15% | metabolism | raises the dish's carrying capacity |
| 15% | the rewards pool | pays every living larva each epoch |
| 10% | the parent's vault | a royalty on having bred well |

With no kept parent the royalty falls to the pool rather than being minted or
burned. A resale pays the seller 90%, with 5% to metabolism and 5% to the pool.
The buyer names the price it saw; if the price changed underneath it, the
program refuses rather than charging something else.

## Carrying capacity

The dish holds `8 + 20 × (metabolism in SOL)` larvae, up to 48. Metabolism is
never spent by the engine; it is the size of the world, and it only grows as
people buy in.

## Earning by living

Every epoch (2,400 ticks, two minutes) the world scores each living larva on
how it actually lived: survival, food eaten since the last score, vitality,
longevity, molts passed, offspring raised, lineage depth, and whether it came
through a flood or a dry spell. Every eighth epoch 25% of the pool is divided
by those points and credited to vaults in one batched transaction. There is no
claim button.

## Death

Death pays out rather than deleting: 40% of the estate is inherited by the
larva's living offspring in equal shares, 35% returns to metabolism, 15% to the
pool, and 10% is credited to the keeper as salvage. A larva culled at its
keeper's request pays the keeper 85%. The record stays on chain forever,
marked dead; only the vault empties.

Upkeep climbs with age, and crust and pools drain faster, so death arrives as
a consequence of where a larva lived rather than from a timer.

## The token's earnings

`$INSTAR` is launched by a person, not by the program. Whatever creator
earnings it produces are paid to a fee keypair the world process sweeps every
ten minutes into `fund(pool_bps = 5000)`: half to metabolism, half to the pool.
`fund` is permissionless, so the dish's income does not stop when the process
does, and nothing is taken out for a team.

## Every lamport has a way out

The rule the program is organised around, tested on every build:

> Every balance the program holds has an exit that **anyone** may call, sending
> to a recovery address fixed at initialisation.

A keeper reclaims their own larva's vault with no operator alive; anyone sweeps
the treasuries to recovery once the world is winding down; and 180 days after
that, anything nobody came back for follows them rather than sitting unreachable
forever. `docs/PROGRAM.md` lists the exits and the tests that state them.
