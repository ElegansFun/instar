//! Operator administration, the epoch commitment, and the treasury exits.
//! Every operator instruction refreshes the heartbeat; a world that is being
//! run never drifts into abandonment.

use anchor_lang::prelude::*;

use crate::errors::InstarError;
use crate::money::{add, assert_solvent, deposit, pay_out, sub};
use crate::nft::{Core, MplCore};
use crate::state::*;

/// Only the program's upgrade authority may create the World. The PDA is a
/// singleton per program id, so without this check whoever called init_world
/// first after deployment would own the world and fix its recovery address.
#[derive(Accounts)]
pub struct InitWorld<'info> {
    #[account(init, payer = operator, space = World::SIZE, seeds = [WORLD_SEED], bump)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub operator: Signer<'info>,
    /// The Core collection every fly will belong to: a fresh keypair the
    /// client generates and signs for, as Core requires of a new account.
    #[account(mut)]
    pub collection: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ InstarError::NotOperator)]
    pub program: Program<'info, crate::program::Instar>,
    #[account(constraint = program_data.upgrade_authority_address == Some(operator.key()) @ InstarError::NotOperator)]
    pub program_data: Account<'info, ProgramData>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

pub fn init_world(ctx: Context<InitWorld>, recovery: Pubkey, collection_uri: String) -> Result<()> {
    let world = &mut ctx.accounts.world;
    let operator = ctx.accounts.operator.key();
    // Recovery is where an abandoned world's money goes when the operator key
    // is gone. The operator key itself is the one address that must never be it.
    require_keys_neq!(recovery, Pubkey::default(), InstarError::WrongId);
    require_keys_neq!(recovery, operator, InstarError::RecoveryIsOperator);
    world.operator = operator;
    world.pending_operator = Pubkey::default();
    world.recovery = recovery;
    world.collection = ctx.accounts.collection.key();
    world.bump = ctx.bumps.world;
    world.touch()?;
    Core {
        program: &ctx.accounts.mpl_core_program,
        world: &ctx.accounts.world,
        collection: &ctx.accounts.collection,
        payer: &ctx.accounts.operator,
        system_program: &ctx.accounts.system_program,
    }
    .create_collection(collection_uri)
}

/// The shape shared by every operator-only instruction.
#[derive(Accounts)]
pub struct OperatorOnly<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = operator @ InstarError::NotOperator)]
    pub world: Account<'info, World>,
    pub operator: Signer<'info>,
}

pub fn set_recovery(ctx: Context<OperatorOnly>, new_recovery: Pubkey) -> Result<()> {
    let world = &mut ctx.accounts.world;
    // an abandoned world's destination is already fixed; otherwise whoever
    // found the key later could redirect the escheat
    require!(!world.wind_down, InstarError::WrongStatus);
    require_keys_neq!(new_recovery, Pubkey::default(), InstarError::WrongId);
    require_keys_neq!(new_recovery, world.operator, InstarError::RecoveryIsOperator);
    world.recovery = new_recovery;
    world.touch()
}

pub fn transfer_operator(ctx: Context<OperatorOnly>, new_operator: Pubkey) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require_keys_neq!(new_operator, Pubkey::default(), InstarError::WrongId);
    require_keys_neq!(new_operator, world.recovery, InstarError::RecoveryIsOperator);
    world.pending_operator = new_operator;
    world.touch()
}

#[derive(Accounts)]
pub struct AcceptOperator<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = pending_operator @ InstarError::NotOperator)]
    pub world: Account<'info, World>,
    pub pending_operator: Signer<'info>,
}

pub fn accept_operator(ctx: Context<AcceptOperator>) -> Result<()> {
    let world = &mut ctx.accounts.world;
    // recovery may have moved since the transfer was offered
    require_keys_neq!(world.pending_operator, world.recovery, InstarError::RecoveryIsOperator);
    world.operator = ctx.accounts.pending_operator.key();
    world.pending_operator = Pubkey::default();
    world.touch()
}

pub fn heartbeat(ctx: Context<OperatorOnly>) -> Result<()> {
    ctx.accounts.world.touch()
}

/// Commit the engine's deterministic state hash for an epoch. Anyone replaying
/// the engine from genesis must reproduce exactly this hash.
pub fn post_epoch(ctx: Context<OperatorOnly>, epoch: u64, tick: u64, state_hash: [u8; 32]) -> Result<()> {
    let world = &mut ctx.accounts.world;
    require!(
        epoch == world.last_epoch.wrapping_add(1) && tick > world.last_epoch_tick,
        InstarError::EpochNotMonotonic
    );
    world.last_epoch = epoch;
    world.last_epoch_tick = tick;
    world.last_state_hash = state_hash;
    world.touch()
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump, has_one = operator @ InstarError::NotOperator)]
    pub world: Account<'info, World>,
    pub operator: Signer<'info>,
    /// CHECK: any writable account may receive lamports; the operator chooses it.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
}

/// The operator recovers the protocol treasuries. `u64::MAX` takes all of a
/// pot; 0 takes none of it, so one pot can be drawn without touching the other.
/// Creature vaults and credits are never touched: they belong to keepers.
pub const TAKE_ALL: u64 = u64::MAX;

pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, metabolism_amount: u64, pool_amount: u64) -> Result<()> {
    let world = &mut ctx.accounts.world;
    let m = if metabolism_amount == TAKE_ALL { world.metabolism } else { metabolism_amount };
    let p = if pool_amount == TAKE_ALL { world.pool } else { pool_amount };
    require!(m <= world.metabolism && p <= world.pool, InstarError::Insolvent);
    let total = add(m, p)?;
    require!(total > 0, InstarError::NothingToWithdraw);
    world.metabolism = sub(world.metabolism, m)?;
    world.pool = sub(world.pool, p)?;
    world.touch()?;
    pay_out(&world.to_account_info(), &ctx.accounts.to.to_account_info(), total)?;
    assert_solvent(world)
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Money from outside the market: the coin's creator-fee stream, or anyone who
/// wants to feed the world. Metabolism sets how many flies the world carries;
/// the pool pays the ones living well. The caller states the split. A world
/// that is winding down takes no new money: its ledger is being emptied, and
/// fresh lamports would only end up backing stale claims.
pub fn fund(ctx: Context<Fund>, amount: u64, pool_bps: u16) -> Result<()> {
    require!(!ctx.accounts.world.wind_down, InstarError::WindingDown);
    require!(u64::from(pool_bps) <= BPS, InstarError::WrongPrice);
    require!(amount > 0, InstarError::NothingToWithdraw);
    deposit(&ctx.accounts.payer, &ctx.accounts.world, &ctx.accounts.system_program, amount)?;
    let world = &mut ctx.accounts.world;
    let to_pool = crate::money::bps(amount, u64::from(pool_bps))?;
    world.pool = add(world.pool, to_pool)?;
    world.metabolism = add(world.metabolism, sub(amount, to_pool)?)?;
    assert_solvent(world)
}
