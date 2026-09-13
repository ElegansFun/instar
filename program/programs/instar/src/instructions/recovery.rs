//! The way out. Every exit here exists from deployment and is designed
//! against one question: if the operator key were destroyed this instant and
//! nobody ever ran the world again, can each lamport still be got out, by
//! someone, without anyone's permission?
//!
//!   creature vaults  -> the keeper reclaims their own, in wind-down
//!   credits          -> already pull-only; the holder needs nobody
//!   metabolism, pool -> swept to `recovery`, fixed before the first lamport
//!
//! The operator's heartbeat distinguishes a running world from an abandoned
//! one: a world being looked after never opens these doors, and one that is
//! not opens them for everybody at the same moment.

use anchor_lang::prelude::*;

use crate::errors::InstarError;
use crate::money::{add, assert_solvent, free_lamports, pay_out, sub};
use crate::state::*;

#[derive(Accounts)]
pub struct BeginWindDown<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    pub signer: Signer<'info>,
}

/// Declare the world over. The operator may do this deliberately; anyone may
/// once the operator has gone quiet for ABANDONED_AFTER. One-way.
pub fn begin_wind_down(ctx: Context<BeginWindDown>) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(!world.wind_down, InstarError::WrongStatus);
    let now = Clock::get()?.unix_timestamp;
    let is_operator = ctx.accounts.signer.key() == world.operator;
    require!(is_operator || world.abandoned(now), InstarError::NotAbandoned);
    world.wind_down = true;
    world.wind_down_at = now;
    if is_operator {
        world.last_operator_action = now;
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct ReclaimVault<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump, has_one = keeper @ InstarError::NotKeeper)]
    pub creature: Account<'info, Creature>,
    #[account(
        init_if_needed,
        payer = keeper,
        space = Credit::SIZE,
        seeds = [CREDIT_SEED, keeper.key().as_ref()],
        bump,
    )]
    pub credit: Account<'info, Credit>,
    pub system_program: Program<'info, System>,
}

/// Take your own larva's vault. Needs no operator and no service, only that
/// the world has ended and the larva is yours.
pub fn reclaim_vault(ctx: Context<ReclaimVault>, _id: u64) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(world.wind_down, InstarError::NotWindingDown);
    let c = &mut ctx.accounts.creature;
    let amount = c.vault;
    c.vault = 0;
    c.sale_price = 0;
    if c.status != STATUS_DEAD {
        c.status = STATUS_DEAD;
        world.total_alive = sub(world.total_alive, 1)?;
    }
    world.total_vaults = sub(world.total_vaults, amount)?;
    world.total_credit = add(world.total_credit, amount)?;

    let credit = &mut ctx.accounts.credit;
    credit.owner = ctx.accounts.keeper.key();
    credit.bump = ctx.bumps.credit;
    credit.amount = add(credit.amount, amount)?;
    assert_solvent(world)
}

#[derive(Accounts)]
pub struct ToRecovery<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = recovery @ InstarError::WrongId)]
    pub world: Account<'info, World>,
    /// CHECK: constrained to `world.recovery`; any account may receive lamports.
    #[account(mut)]
    pub recovery: UncheckedAccount<'info>,
}

/// Send the treasuries to the recovery address. Permissionless on purpose:
/// anyone may press it, but only the address fixed at deployment receives.
pub fn sweep_to_recovery(ctx: Context<ToRecovery>) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(world.wind_down, InstarError::NotWindingDown);
    let amount = add(world.metabolism, world.pool)?;
    world.metabolism = 0;
    world.pool = 0;
    pay_out(&world.to_account_info(), &ctx.accounts.recovery.to_account_info(), amount)?;
    assert_solvent(world)
}

/// The last resort. Long after the world ended, whatever nobody came back for
/// goes to recovery rather than sitting here forever. This is the only way a
/// keeper's own money leaves without them, which is why the timer is six
/// months and why it is stated plainly in the UI. Afterwards the ledger is
/// zero and any remaining claim fails as Insolvent.
pub fn escheat(ctx: Context<ToRecovery>) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(world.wind_down, InstarError::NotWindingDown);
    let now = Clock::get()?.unix_timestamp;
    require!(now > world.wind_down_at.saturating_add(ESCHEAT_AFTER), InstarError::TooEarly);
    let amount = free_lamports(world)?;
    world.metabolism = 0;
    world.pool = 0;
    world.total_vaults = 0;
    world.total_credit = 0;
    pay_out(&world.to_account_info(), &ctx.accounts.recovery.to_account_info(), amount)?;
    assert_solvent(world)
}
