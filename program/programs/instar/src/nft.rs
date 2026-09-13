//! Every larva is a Metaplex Core asset in the world's collection, and the
//! asset's `owner` is the one truth about who keeps it. The World PDA owns
//! unsold larvae, is the collection's update authority, and holds the three
//! permanent plugin authorities that let the program move, freeze and burn an
//! asset a keeper owns: sale to a buyer, a cull request, and death.

use std::ops::Deref;

use anchor_lang::prelude::*;
use mpl_core::accounts::BaseAssetV1;
use mpl_core::instructions::{
    BurnV1CpiBuilder, CreateCollectionV2CpiBuilder, CreateV2CpiBuilder, TransferV1CpiBuilder, UpdatePluginV1CpiBuilder,
};
use mpl_core::types::{
    Attribute, Attributes, Key as CoreKey, PermanentBurnDelegate, PermanentFreezeDelegate, PermanentTransferDelegate,
    Plugin, PluginAuthority, PluginAuthorityPair,
};

use crate::errors::InstarError;
use crate::state::{World, NO_PARENT, WORLD_SEED};

pub const COLLECTION_NAME: &str = "Instar";

/// The Core program, for `Program<'info, MplCore>`.
#[derive(Clone)]
pub struct MplCore;

impl Id for MplCore {
    fn id() -> Pubkey {
        mpl_core::ID
    }
}

/// The accounts every Core CPI needs, with the World PDA as the signing
/// authority. `payer` is whoever signed the outer instruction: it pays the
/// rent of anything created and receives the rent of anything burned.
pub struct Core<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub world: &'a Account<'info, World>,
    pub collection: &'a AccountInfo<'info>,
    pub payer: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

impl<'a, 'info> Core<'a, 'info> {
    fn world_info(&self) -> AccountInfo<'info> {
        self.world.to_account_info()
    }

    fn signer_seeds(&self) -> [&'a [u8]; 2] {
        [WORLD_SEED, std::slice::from_ref(&self.world.bump)]
    }

    /// The world's collection, owned and updatable by the World PDA. The
    /// collection account is a fresh keypair the client signs for.
    pub fn create_collection(&self, uri: String) -> Result<()> {
        let world = self.world_info();
        CreateCollectionV2CpiBuilder::new(self.program)
            .collection(self.collection)
            .update_authority(Some(&world))
            .payer(self.payer)
            .system_program(self.system_program)
            .name(COLLECTION_NAME.to_string())
            .uri(uri)
            .invoke()?;
        Ok(())
    }

    /// A newborn's asset: owned by the World PDA until it is bought, in the
    /// collection (the World PDA signs as collection authority), carrying the
    /// permanent delegates the program needs later and the birth record as
    /// attributes for wallets to show.
    #[allow(clippy::too_many_arguments)]
    pub fn create_asset(
        &self,
        asset: &AccountInfo<'info>,
        id: u64,
        parent_id: u64,
        generation: u32,
        birth_tick: u64,
        genome_hash: &[u8; 32],
        uri: String,
    ) -> Result<()> {
        let world = self.world_info();
        let authority = PluginAuthority::Address { address: world.key() };
        let plugin = |plugin: Plugin| PluginAuthorityPair { plugin, authority: Some(authority.clone()) };
        let attribute = |key: &str, value: String| Attribute { key: key.to_string(), value };
        let parent = if parent_id == NO_PARENT { "founder".to_string() } else { parent_id.to_string() };
        let plugins = vec![
            plugin(Plugin::PermanentTransferDelegate(PermanentTransferDelegate {})),
            plugin(Plugin::PermanentBurnDelegate(PermanentBurnDelegate {})),
            plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: false })),
            plugin(Plugin::Attributes(Attributes {
                attribute_list: vec![
                    attribute("generation", generation.to_string()),
                    attribute("parent", parent),
                    attribute("birth_tick", birth_tick.to_string()),
                    attribute("genome", genome_hex(genome_hash)),
                ],
            })),
        ];
        CreateV2CpiBuilder::new(self.program)
            .asset(asset)
            .collection(Some(self.collection))
            .authority(Some(&world))
            .payer(self.payer)
            .owner(Some(&world))
            .system_program(self.system_program)
            .name(format!("Instar #{id}"))
            .uri(uri)
            .plugins(plugins)
            .invoke_signed(&[&self.signer_seeds()])?;
        Ok(())
    }

    /// Hand the asset to `new_owner`. The World PDA signs either as the owner
    /// (a primary sale) or as the permanent transfer delegate (a resale).
    pub fn transfer(&self, asset: &AccountInfo<'info>, new_owner: &AccountInfo<'info>) -> Result<()> {
        let world = self.world_info();
        TransferV1CpiBuilder::new(self.program)
            .asset(asset)
            .collection(Some(self.collection))
            .payer(self.payer)
            .authority(Some(&world))
            .new_owner(new_owner)
            .system_program(Some(self.system_program))
            .invoke_signed(&[&self.signer_seeds()])?;
        Ok(())
    }

    /// A cull cannot be cancelled, so the asset is frozen where it is until
    /// the settlement burns it; a frozen asset cannot leave the dish.
    pub fn freeze(&self, asset: &AccountInfo<'info>) -> Result<()> {
        let world = self.world_info();
        UpdatePluginV1CpiBuilder::new(self.program)
            .asset(asset)
            .collection(Some(self.collection))
            .payer(self.payer)
            .authority(Some(&world))
            .system_program(self.system_program)
            .plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: true }))
            .invoke_signed(&[&self.signer_seeds()])?;
        Ok(())
    }

    /// Death. The permanent burn delegate burns through a freeze, so a
    /// pending cull ends the same way as any other death. The asset's rent
    /// goes to the payer.
    pub fn burn(&self, asset: &AccountInfo<'info>) -> Result<()> {
        let world = self.world_info();
        BurnV1CpiBuilder::new(self.program)
            .asset(asset)
            .collection(Some(self.collection))
            .payer(self.payer)
            .authority(Some(&world))
            .system_program(Some(self.system_program))
            .invoke_signed(&[&self.signer_seeds()])?;
        Ok(())
    }
}

/// A living larva's asset as Anchor loads it: a Core-owned account keyed
/// `AssetV1`. Core does not delete a burned asset, it leaves a one-byte
/// `Uninitialized` stub behind, so an account that no longer reads as an
/// asset is a dead larva and loading it is `WrongStatus`. Never written back:
/// Core owns it, and Anchor only reserialises what the program owns.
#[derive(Clone)]
pub struct LarvaAsset(BaseAssetV1);

impl Deref for LarvaAsset {
    type Target = BaseAssetV1;

    fn deref(&self) -> &BaseAssetV1 {
        &self.0
    }
}

impl AccountDeserialize for LarvaAsset {
    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        let live = CoreKey::from_slice(buf, 0).map_or(false, |key| key == CoreKey::AssetV1);
        require!(live, InstarError::WrongStatus);
        Ok(Self(BaseAssetV1::from_bytes(buf)?))
    }
}

impl AccountSerialize for LarvaAsset {}

/// Core's key byte, where an Anchor account keeps its discriminator. Not used
/// to load the account (`try_deserialize_unchecked` checks the key itself);
/// `#[derive(Accounts)]` needs it, as it needs the empty `IdlBuild`: the
/// asset is a Core type and contributes nothing to the IDL.
impl Discriminator for LarvaAsset {
    const DISCRIMINATOR: &'static [u8] = &[CoreKey::AssetV1 as u8];
}

#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for LarvaAsset {}

impl Owner for LarvaAsset {
    fn owner() -> Pubkey {
        mpl_core::ID
    }
}

/// What a settlement finds at `creature.asset`: the living asset's owner, or
/// `None` where the owner has already burned it natively. Core does not
/// delete a burned asset, it leaves a one-byte `Uninitialized` stub it still
/// owns; such a larva has no keeper and nothing left to burn. Any other key
/// is not an asset of ours. The owner is the 32 bytes after the key in the
/// versioned `AssetV1` layout; the name and uri behind it are not needed and
/// not decoded.
pub fn settled_owner(asset: &AccountInfo) -> Result<Option<Pubkey>> {
    let data = asset.try_borrow_data()?;
    let data: &[u8] = &data;
    match CoreKey::from_slice(data, 0) {
        Ok(CoreKey::AssetV1) => {
            let owner = data.get(1..33).and_then(|bytes| Pubkey::try_from(bytes).ok());
            Ok(Some(owner.ok_or_else(|| error!(InstarError::WrongStatus))?))
        }
        Ok(CoreKey::Uninitialized) => Ok(None),
        _ => err!(InstarError::WrongStatus),
    }
}

/// The owner of a living asset, for a credit PDA's seeds; a burned stub has
/// no owner and no credit.
pub fn live_owner(asset: &AccountInfo) -> Result<Pubkey> {
    settled_owner(asset)?.ok_or_else(|| error!(InstarError::WrongStatus))
}

/// The genome digest as the journal and the site print it: the engine's u64
/// held big-endian in the last eight bytes of the zero-padded field, as 16
/// hex characters.
fn genome_hex(hash: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(16);
    for b in &hash[24..] {
        s.push(HEX[usize::from(b >> 4)] as char);
        s.push(HEX[usize::from(b & 0xf)] as char);
    }
    s
}
