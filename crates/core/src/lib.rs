//! siyuanmaster-core: reusable, dependency-light logic shared by the
//! `siyuanmasterd` gateway and the `siyuanmaster` CLI.
//!
//! The crate is intentionally pure (no network, no filesystem except
//! explicitly injected) so every security-critical decision — scoped
//! tokens, the SafeWriteTxn write-transaction state machine, reference
//! impact, tree permission inheritance, path handling, audit shape —
//! is fully unit-testable without a SiYuan runtime.

pub mod audit;
pub mod catalog;
pub mod diff;
pub mod hash;
pub mod path;
pub mod perm;
pub mod refs;
pub mod secret;
pub mod segments;
pub mod token;
pub mod txn;
