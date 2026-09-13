//! The market: primary sale, listing, resale, hand-off, and the pull-payment
//! exit for everything a human is owed.

use anchor_lang::prelude::*;

use crate::errors::InstarError;
use crate::money::{add, assert_solvent, bps, deposit, pay_out, sub};
use crate::state::*;

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Buy<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    /// The parent record, for the ancestry royalty. Omitted for a founder;
    /// the seeds prove it is the record `creature.parent_id` names.
    #[account(mut, seeds = [CREATURE_SEED, &creature.parent_id.to_le_bytes()], bump = parent.bump)]
    pub parent: Option<Account<'info, Creature>>,
    pub system_program: Program<'info, System>,
}

/// Buy a newborn. Most of the price is seeded into the larva itself and a
/// tenth goes to its parent if the parent is still kept; otherwise the pool
/// keeps that share rather than it being stranded. The buyer states the price
/// they saw so an offer changed under them cannot charge more.
pub fn buy(ctx: Context<Buy>, _id: u64, price: u64) -> Result<()> {
    require!(!ctx.accounts.world.wind_down, InstarError::WindingDown);
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OFFERED, InstarError::NotForSale);
    require!(price == c.sale_price, InstarError::WrongPrice);
    // A larva with a parent must be bought with that parent's record in hand,
    // or a raw client could route the ancestry royalty away from a kept parent.
    require!(c.parent_id == NO_PARENT || ctx.accounts.parent.is_some(), InstarError::WrongId);
    deposit(&ctx.accounts.buyer, &ctx.accounts.world, &ctx.accounts.system_program, price)?;

    let to_vault = bps(price, BUY_TO_VAULT_BPS)?;
    let to_metab = bps(price, BUY_TO_METABOLISM_BPS)?;
    let mut to_pool = bps(price, BUY_TO_POOL_BPS)?;
    let to_parent = sub(sub(sub(price, to_vault)?, to_metab)?, to_pool)?;

    let world = &mut ctx.accounts.world;
    c.vault = add(c.vault, to_vault)?;
    world.total_vaults = add(world.total_vaults, to_vault)?;
    world.metabolism = add(world.metabolism, to_metab)?;

    match ctx.accounts.parent.as_mut() {
        Some(parent) if c.parent_id != NO_PARENT && parent.status == STATUS_OWNED => {
            parent.vault = add(parent.vault, to_parent)?;
            world.total_vaults = add(world.total_vaults, to_parent)?;
        }
        _ => to_pool = add(to_pool, to_parent)?,
    }
    world.pool = add(world.pool, to_pool)?;

    c.status = STATUS_OWNED;
    c.sale_price = 0;
    c.keeper = ctx.accounts.buyer.key();
    assert_solvent(world)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct KeeperListing<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump, has_one = keeper @ InstarError::NotKeeper)]
    pub creature: Account<'info, Creature>,
}

pub fn list(ctx: Context<KeeperListing>, _id: u64, price: u64) -> Result<()> {
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OWNED, InstarError::WrongStatus);
    // a cull cannot be cancelled, so a larva awaiting one is not sold to anyone
    require!(!c.pending_cull, InstarError::WrongStatus);
    require!(price > 0, InstarError::WrongPrice);
    c.sale_price = price;
    Ok(())
}

pub fn unlist(ctx: Context<KeeperListing>, _id: u64) -> Result<()> {
    ctx.accounts.creature.sale_price = 0;
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct BuyListed<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    #[account(
        init_if_needed,
        payer = buyer,
        space = Credit::SIZE,
        seeds = [CREDIT_SEED, creature.keeper.as_ref()],
        bump,
    )]
    pub seller_credit: Account<'info, Credit>,
    pub system_program: Program<'info, System>,
}

/// Buy a larva from its current keeper. The vault travels with it, so the
/// buyer is paying for what the larva has already earned.
pub fn buy_listed(ctx: Context<BuyListed>, _id: u64, price: u64) -> Result<()> {
    require!(!ctx.accounts.world.wind_down, InstarError::WindingDown);
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OWNED && c.sale_price > 0, InstarError::NotForSale);
    require!(!c.pending_cull, InstarError::WrongStatus);
    require!(price == c.sale_price, InstarError::WrongPrice);
    deposit(&ctx.accounts.buyer, &ctx.accounts.world, &ctx.accounts.system_program, price)?;

    let to_seller = bps(price, RESALE_TO_SELLER_BPS)?;
    let to_metab = bps(price, RESALE_TO_METABOLISM_BPS)?;
    let to_pool = sub(sub(price, to_seller)?, to_metab)?;

    let world = &mut ctx.accounts.world;
    world.metabolism = add(world.metabolism, to_metab)?;
    world.pool = add(world.pool, to_pool)?;
    world.total_credit = add(world.total_credit, to_seller)?;

    let credit = &mut ctx.accounts.seller_credit;
    credit.owner = c.keeper;
    credit.bump = ctx.bumps.seller_credit;
    credit.amount = add(credit.amount, to_seller)?;

    c.sale_price = 0;
    c.keeper = ctx.accounts.buyer.key();
    assert_solvent(world)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Transfer<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump, has_one = keeper @ InstarError::NotKeeper)]
    pub creature: Account<'info, Creature>,
}

/// Hand the larva to another keeper. Its vault goes with it, exactly as it
/// does through the market; a listing does not survive the hand-off.
pub fn transfer(ctx: Context<Transfer>, _id: u64, to: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OWNED, InstarError::WrongStatus);
    require!(!c.pending_cull, InstarError::WrongStatus);
    require_keys_neq!(to, Pubkey::default(), InstarError::WrongId);
    c.sale_price = 0;
    c.keeper = to;
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump, has_one = owner @ InstarError::NotKeeper)]
    pub credit: Account<'info, Credit>,
}

/// Take everything owed to you: sale proceeds, salvage, reclaimed vaults.
/// Needs no operator and no service.
pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let credit = &mut ctx.accounts.credit;
    let amount = credit.amount;
    require!(amount > 0, InstarError::NothingToWithdraw);
    credit.amount = 0;
    let world = &mut ctx.accounts.world;
    world.total_credit = sub(world.total_credit, amount)?;
    pay_out(&world.to_account_info(), &ctx.accounts.owner.to_account_info(), amount)?;
    assert_solvent(world)
}
