use anchor_lang::prelude::*;

#[error_code]
pub enum InstarError {
    #[msg("signer is not the world operator")]
    NotOperator,
    #[msg("signer is not the owner of the fly's asset")]
    NotOwner,
    #[msg("the fly or the world is not in the status this action needs")]
    WrongStatus,
    #[msg("id is not the next in sequence, or the account passed is not the record it claims to be")]
    WrongId,
    #[msg("the fly is not for sale")]
    NotForSale,
    #[msg("price does not match the sale price on record")]
    WrongPrice,
    #[msg("the world does not hold the lamports to back this ledger")]
    Insolvent,
    #[msg("the world is not winding down")]
    NotWindingDown,
    #[msg("the operator is still active; the world is not abandoned")]
    NotAbandoned,
    #[msg("the timer for this action has not elapsed")]
    TooEarly,
    #[msg("epoch or tick is not the next in sequence")]
    EpochNotMonotonic,
    #[msg("nothing to withdraw")]
    NothingToWithdraw,
    #[msg("the world is winding down; no new money may enter it")]
    WindingDown,
    #[msg("recovery must be an address other than the operator")]
    RecoveryIsOperator,
    #[msg("the asset account is not the fly's asset")]
    AssetMismatch,
    #[msg("the collection account is not the world's collection")]
    WrongCollection,
    #[msg("the world has not escheated; records and credits are still live")]
    NotEscheated,
    #[msg("creature records or credits are still open; close them first")]
    RecordsStillOpen,
}
