//! The way out. Every exit here exists from deployment and is designed
//! against one question: if the operator key were destroyed this instant and
//! nobody ever ran the world again, can each lamport still be got out, by
//! someone, without anyone's permission?
//!
//!   creature vaults  -> the keeper reclaims their own, in wind-down
//!   credits          -> already pull-only; the holder needs nobody
//!   metabolism, pool -> swept to `recovery`, fixed before the first lamport
//!   account rent     -> after escheat, every PDA closes to `recovery`
//! The operator's heartbeat distinguishes a running world from an abandoned
//! one: a world being looked after never opens these doors, and one that is
//! not opens them for everybody at the same moment.

use anchor_lang::prelude::*;
use mpl_core::accounts::BaseCollectionV1;

use crate::errors::InstarError;
use crate::money::{add, assert_solvent, free_lamports, pay_out, sub};
use crate::nft::{Core, LarvaAsset, MplCore};
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
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    #[account(mut, address = creature.asset @ InstarError::AssetMismatch, constraint = asset.owner == owner.key() @ InstarError::NotOwner)]
    pub asset: Account<'info, LarvaAsset>,
    #[account(mut, address = world.collection @ InstarError::WrongCollection)]
    pub collection: Account<'info, BaseCollectionV1>,
    #[account(
        init_if_needed,
        payer = owner,
        space = Credit::SIZE,
        seeds = [CREDIT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub credit: Account<'info, Credit>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

/// Take your own larva's vault. Needs no operator and no service, only that
/// the world has ended and the asset is yours. The larva is DEAD afterwards
/// and its asset burned; the rent comes back to you.
pub fn reclaim_vault(ctx: Context<ReclaimVault>, _id: u64) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(world.wind_down, InstarError::NotWindingDown);
    let c = &mut ctx.accounts.creature;
    require!(c.status != STATUS_DEAD, InstarError::WrongStatus);
    let amount = c.vault;
    c.vault = 0;
    c.clear_listing();
    c.status = STATUS_DEAD;
    world.total_alive = sub(world.total_alive, 1)?;
    world.total_vaults = sub(world.total_vaults, amount)?;
    world.total_credit = add(world.total_credit, amount)?;

    let credit = &mut ctx.accounts.credit;
    credit.owner = ctx.accounts.owner.key();
    credit.bump = ctx.bumps.credit;
    credit.amount = add(credit.amount, amount)?;
    assert_solvent(world)?;
    Core {
        program: &ctx.accounts.mpl_core_program,
        world: &ctx.accounts.world,
        collection: ctx.accounts.collection.as_ref(),
        payer: &ctx.accounts.owner,
        system_program: &ctx.accounts.system_program,
    }
    .burn(ctx.accounts.asset.as_ref())
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
/// zero, any remaining claim fails as Insolvent, and the accounts themselves
/// may be closed for their rent.
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
    world.escheated = true;
    pay_out(&world.to_account_info(), &ctx.accounts.recovery.to_account_info(), amount)?;
    assert_solvent(world)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CloseRecord<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = recovery @ InstarError::WrongId)]
    pub world: Account<'info, World>,
    #[account(mut, close = recovery, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    /// CHECK: constrained to `world.recovery`; any account may receive lamports.
    #[account(mut)]
    pub recovery: UncheckedAccount<'info>,
}

/// Return a creature record's rent to recovery. Only after escheat, when the
/// record backs no money; whatever its status. The Core asset is not touched:
/// a kept larva's asset stays with its keeper as a collectible, a dead one's
/// is already a burned stub.
pub fn close_record(ctx: Context<CloseRecord>, _id: u64) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(world.escheated, InstarError::NotEscheated);
    world.closed_records = add(world.closed_records, 1)?;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseCredit<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = recovery @ InstarError::WrongId)]
    pub world: Account<'info, World>,
    /// Any holder's credit, passed by address; no signature, since after
    /// escheat it is empty and the World no longer backs it.
    #[account(mut, close = recovery, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Account<'info, Credit>,
    /// CHECK: constrained to `world.recovery`; any account may receive lamports.
    #[account(mut)]
    pub recovery: UncheckedAccount<'info>,
}

/// Return a credit account's rent to recovery. Only after escheat.
pub fn close_credit(ctx: Context<CloseCredit>) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(world.escheated, InstarError::NotEscheated);
    world.credits_open = sub(world.credits_open, 1)?;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseWorld<'info> {
    #[account(mut, close = recovery, seeds = [WORLD_SEED], bump = world.bump, has_one = recovery @ InstarError::WrongId)]
    pub world: Account<'info, World>,
    /// CHECK: constrained to `world.recovery`; any account may receive lamports.
    #[account(mut)]
    pub recovery: UncheckedAccount<'info>,
}

/// The last instruction the world ever runs: once every record and credit is
/// closed, the World PDA closes to recovery for its rent. The collection
/// stays behind as a Core account whose update authority no longer exists.
pub fn close_world(ctx: Context<CloseWorld>) -> Result<()> {
    let world = &ctx.accounts.world;
    require!(world.escheated, InstarError::NotEscheated);
    require!(
        world.closed_records == world.next_id && world.credits_open == 0,
        InstarError::RecordsStillOpen
    );
    Ok(())
}
