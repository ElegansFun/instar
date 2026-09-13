//! The market: primary sale, listing, resale, and the pull-payment exit for
//! everything a human is owed. A keeper hands a larva on with a plain Core
//! transfer of the asset; the program has no instruction for that.

use anchor_lang::prelude::*;
use mpl_core::accounts::BaseCollectionV1;

use crate::errors::InstarError;
use crate::money::{add, assert_solvent, bps, deposit, pay_out, sub};
use crate::nft::{Core, LarvaAsset, MplCore};
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
    #[account(mut, address = creature.asset @ InstarError::AssetMismatch)]
    pub asset: Account<'info, LarvaAsset>,
    #[account(mut, address = world.collection @ InstarError::WrongCollection)]
    pub collection: Account<'info, BaseCollectionV1>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

/// Buy a newborn. Most of the price is seeded into the larva itself and a
/// tenth goes to its parent if the parent is still kept; otherwise the pool
/// keeps that share rather than it being stranded. The buyer states the price
/// they saw so an offer changed under them cannot charge more. The asset
/// moves from the World PDA to the buyer.
pub fn buy(ctx: Context<Buy>, _id: u64, price: u64) -> Result<()> {
    require!(!ctx.accounts.world.wind_down, InstarError::WindingDown);
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OFFERED, InstarError::NotForSale);
    require_keys_eq!(ctx.accounts.asset.owner, ctx.accounts.world.key(), InstarError::NotForSale);
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
    c.clear_listing();
    assert_solvent(world)?;
    Core {
        program: &ctx.accounts.mpl_core_program,
        world: &ctx.accounts.world,
        collection: ctx.accounts.collection.as_ref(),
        payer: &ctx.accounts.buyer,
        system_program: &ctx.accounts.system_program,
    }
    .transfer(ctx.accounts.asset.as_ref(), &ctx.accounts.buyer)
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Listing<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [CREATURE_SEED, &id.to_le_bytes()], bump = creature.bump)]
    pub creature: Account<'info, Creature>,
    #[account(address = creature.asset @ InstarError::AssetMismatch)]
    pub asset: Account<'info, LarvaAsset>,
}

/// Offer your larva for resale. Only the asset's current owner may.
pub fn list(ctx: Context<Listing>, _id: u64, price: u64) -> Result<()> {
    require_keys_eq!(ctx.accounts.asset.owner, ctx.accounts.signer.key(), InstarError::NotOwner);
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OWNED, InstarError::WrongStatus);
    // a cull cannot be cancelled, so a larva awaiting one is not sold to anyone
    require!(!c.pending_cull, InstarError::WrongStatus);
    require!(price > 0, InstarError::WrongPrice);
    c.sale_price = price;
    c.listed_by = ctx.accounts.signer.key();
    c.listed_at = Clock::get()?.unix_timestamp;
    Ok(())
}

/// Take a listing down: the keeper who made it, or whoever owns the asset now
/// (a stale listing left by a previous owner is already void, and this clears it).
pub fn unlist(ctx: Context<Listing>, _id: u64) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let c = &mut ctx.accounts.creature;
    require!(signer == c.listed_by || signer == ctx.accounts.asset.owner, InstarError::NotOwner);
    c.clear_listing();
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
    #[account(mut, address = creature.asset @ InstarError::AssetMismatch)]
    pub asset: Account<'info, LarvaAsset>,
    #[account(mut, address = world.collection @ InstarError::WrongCollection)]
    pub collection: Account<'info, BaseCollectionV1>,
    /// The seller's credit: the keeper who listed the larva.
    #[account(
        init_if_needed,
        payer = buyer,
        space = Credit::SIZE,
        seeds = [CREDIT_SEED, creature.listed_by.as_ref()],
        bump,
    )]
    pub seller_credit: Account<'info, Credit>,
    pub mpl_core_program: Program<'info, MplCore>,
    pub system_program: Program<'info, System>,
}

/// Buy a larva from its current keeper. The vault travels with it, so the
/// buyer is paying for what the larva has already earned. A listing is only
/// good while the asset is still in the lister's hands and for LISTING_MAX_AGE
/// after it was made: a larva that was moved with a plain Core transfer since
/// is not for sale, nor is one whose old listing would revive on its way back.
/// The World PDA moves the asset as permanent transfer delegate.
pub fn buy_listed(ctx: Context<BuyListed>, _id: u64, price: u64) -> Result<()> {
    require!(!ctx.accounts.world.wind_down, InstarError::WindingDown);
    let c = &mut ctx.accounts.creature;
    require!(c.status == STATUS_OWNED && c.sale_price > 0, InstarError::NotForSale);
    require_keys_eq!(ctx.accounts.asset.owner, c.listed_by, InstarError::NotForSale);
    let now = Clock::get()?.unix_timestamp;
    require!(now <= c.listed_at.saturating_add(LISTING_MAX_AGE), InstarError::NotForSale);
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
    if credit.owner == Pubkey::default() {
        world.credits_open = add(world.credits_open, 1)?;
    }
    credit.owner = c.listed_by;
    credit.bump = ctx.bumps.seller_credit;
    credit.amount = add(credit.amount, to_seller)?;

    c.clear_listing();
    assert_solvent(world)?;
    Core {
        program: &ctx.accounts.mpl_core_program,
        world: &ctx.accounts.world,
        collection: ctx.accounts.collection.as_ref(),
        payer: &ctx.accounts.buyer,
        system_program: &ctx.accounts.system_program,
    }
    .transfer(ctx.accounts.asset.as_ref(), &ctx.accounts.buyer)
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [WORLD_SEED], bump = world.bump)]
    pub world: Account<'info, World>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump, has_one = owner @ InstarError::NotOwner)]
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
